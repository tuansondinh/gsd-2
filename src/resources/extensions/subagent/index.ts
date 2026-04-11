/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@gsd/pi-agent-core";
import type { ImageContent, Message } from "@gsd/pi-ai";
import { StringEnum } from "@gsd/pi-ai";
import {
    type ExtensionAPI,
    getMarkdownTheme,
} from "@gsd/pi-coding-agent";
import { Container, Key, Markdown, Spacer, Text } from "@gsd/pi-tui";
import { Type } from "@sinclair/typebox";
import { formatTokenCount, shortcutDesc } from "../shared/mod.js";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";
import {
    type IsolationEnvironment,
    type MergeResult,
    createIsolation,
    mergeDeltaPatches,
    readIsolationMode,
} from "./isolation.js";
import { registerWorker, updateWorker } from "./worker-registry.js";
import { resolveConfiguredSubagentModel } from "./configured-model.js";
import { resolveSubagentModel } from "./model-resolution.js";
import { loadEffectivePreferences } from "../shared/preferences.js";
import {
    readBudgetSubagentModelFromSettings,
    runLegacySingleAgent,
    stopLegacySubagents,
} from "./legacy-runner.js";
import {
    MAX_IN_PROCESS_SUBAGENT_DEPTH,
    startInProcessSingleAgent,
    type SubagentHandle,
} from "./in-process-runner.js";
import { CmuxClient, shellEscape } from "../cmux/index.js";
import { BackgroundJobManager, type BackgroundSubagentJob } from "./background-job-manager.js";
import { runSubagentInBackground } from "./background-runner.js";
import { showAgentSwitcher } from "./agent-switcher-component.js";
import {
    buildAgentSwitchTargets,
    type AgentSwitchTarget,
} from "./agent-switcher-model.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const DEFAULT_AWAIT_SUBAGENT_TIMEOUT_SECONDS = 120;
const USE_IN_PROCESS_SUBAGENT = process.env.LSD_SUBAGENT_IN_PROCESS !== "0";

type AgentSessionState = "running" | "completed" | "failed";

interface AgentSessionLink {
    id: string;
    agentName: string;
    task: string;
    parentSessionFile: string;
    subagentSessionFile: string;
    createdAt: number;
    updatedAt: number;
    state: AgentSessionState;
}

const agentSessionLinksById = new Map<string, AgentSessionLink>();
const agentSessionIdsByParent = new Map<string, string[]>();
const parentSessionByChild = new Map<string, string>();

interface LiveSubagentRuntime {
    sessionFile?: string;
    parentSessionFile?: string;
    agentName: string;
    isBusy: () => boolean;
    sendPrompt: (text: string, images?: ImageContent[]) => Promise<void>;
    sendSteer: (text: string, images?: ImageContent[]) => Promise<void>;
    sendFollowUp: (text: string, images?: ImageContent[]) => Promise<void>;
}

const liveRuntimeBySessionFile = new Map<string, LiveSubagentRuntime>();
const inProcessSubagentDepthBySessionId = new Map<string, number>();
let agentSessionLinkCounter = 0;

function listSessionFiles(sessionDir: string): string[] {
    if (!fs.existsSync(sessionDir)) return [];
    try {
        return fs
            .readdirSync(sessionDir)
            .filter((name) => name.endsWith(".jsonl"))
            .map((name) => path.join(sessionDir, name));
    } catch {
        return [];
    }
}

function registerAgentSessionLink(link: Omit<AgentSessionLink, "id" | "createdAt" | "updatedAt">): AgentSessionLink {
    const now = Date.now();
    const id = `agent-${++agentSessionLinkCounter}`;
    const full: AgentSessionLink = { ...link, id, createdAt: now, updatedAt: now };
    agentSessionLinksById.set(id, full);
    const list = agentSessionIdsByParent.get(link.parentSessionFile) ?? [];
    list.push(id);
    agentSessionIdsByParent.set(link.parentSessionFile, list);
    parentSessionByChild.set(link.subagentSessionFile, link.parentSessionFile);
    return full;
}

function updateAgentSessionLinkState(subagentSessionFile: string, state: AgentSessionState): void {
    for (const link of agentSessionLinksById.values()) {
        if (link.subagentSessionFile === subagentSessionFile) {
            link.state = state;
            link.updatedAt = Date.now();
            return;
        }
    }
}

function upsertAgentSessionLink(
    agentName: string,
    task: string,
    parentSessionFile: string,
    subagentSessionFile: string,
    state: AgentSessionState,
): void {
    const existingParent = parentSessionByChild.get(subagentSessionFile);
    if (!existingParent) {
        registerAgentSessionLink({
            agentName,
            task,
            parentSessionFile,
            subagentSessionFile,
            state,
        });
        return;
    }

    updateAgentSessionLinkState(subagentSessionFile, state);
}

function getAgentSessionLinksForParent(parentSessionFile: string): AgentSessionLink[] {
    const ids = agentSessionIdsByParent.get(parentSessionFile) ?? [];
    return ids
        .map((id) => agentSessionLinksById.get(id))
        .filter((entry): entry is AgentSessionLink => Boolean(entry))
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

function readSessionHeader(sessionFile: string): {
    parentSession?: string;
    subagentName?: string;
    subagentTask?: string;
    subagentSystemPrompt?: string;
    subagentTools?: string[];
} | null {
    try {
        const content = fs.readFileSync(sessionFile, "utf-8");
        const firstLine = content.split("\n").find((line) => line.trim().length > 0);
        if (!firstLine) return null;
        const parsed = JSON.parse(firstLine);
        if (!parsed || parsed.type !== "session") return null;
        return {
            parentSession: typeof parsed.parentSession === "string" ? parsed.parentSession : undefined,
            subagentName: typeof parsed.subagentName === "string" ? parsed.subagentName : undefined,
            subagentTask: typeof parsed.subagentTask === "string" ? parsed.subagentTask : undefined,
            subagentSystemPrompt: typeof parsed.subagentSystemPrompt === "string" ? parsed.subagentSystemPrompt : undefined,
            subagentTools: Array.isArray(parsed.subagentTools)
                ? parsed.subagentTools.filter((tool: unknown): tool is string => typeof tool === "string")
                : undefined,
        };
    } catch {
        return null;
    }
}

function backfillAgentSessionLinksForParent(parentSessionFile: string, sessionDir: string): AgentSessionLink[] {
    for (const sessionFile of listSessionFiles(sessionDir)) {
        if (sessionFile === parentSessionFile) continue;
        const header = readSessionHeader(sessionFile);
        if (header?.parentSession !== parentSessionFile) continue;
        const existingParent = parentSessionByChild.get(sessionFile);
        if (!existingParent) {
            registerAgentSessionLink({
                agentName: header.subagentName ?? "subagent",
                task: header.subagentTask ?? "Recovered from persisted session lineage",
                parentSessionFile,
                subagentSessionFile: sessionFile,
                state: "completed",
            });
        }
    }
    return getAgentSessionLinksForParent(parentSessionFile);
}

function formatSwitchTargetSummary(target: AgentSwitchTarget): string {
    const current = target.isCurrent ? " (current)" : "";
    if (target.kind === "parent") {
        return `● parent — main session${current}`;
    }

    const icon = target.state === "running" ? "▶" : target.state === "failed" ? "✗" : "✓";
    return `${icon} ${target.agentName} — ${target.taskPreview}${current}`;
}

function buildSwitchTargetsForParent(
    parentSessionFile: string,
    currentSessionFile: string,
    currentCwd: string,
    trackedLinks: AgentSessionLink[],
    runningJobs: BackgroundSubagentJob[],
): AgentSwitchTarget[] {
    return buildAgentSwitchTargets({
        currentSessionFile,
        rootParentSessionFile: parentSessionFile,
        currentCwd,
        trackedLinks: trackedLinks.map((link) => ({
            id: link.id,
            agentName: link.agentName,
            task: link.task,
            parentSessionFile: link.parentSessionFile,
            subagentSessionFile: link.subagentSessionFile,
            updatedAt: link.updatedAt,
            state: link.state,
        })),
        runningJobs: runningJobs.map((job) => ({
            id: job.id,
            agentName: job.agentName,
            task: job.task,
            startedAt: job.startedAt,
            parentSessionFile: job.parentSessionFile,
            sessionFile: job.sessionFile,
            cwd: job.cwd,
        })),
    });
}

const AwaitSubagentParams = Type.Object({
    jobs: Type.Optional(
        Type.Array(Type.String(), {
            description: "Subagent job IDs to wait for. Omit to wait for the next running background subagent.",
        }),
    ),
    timeout: Type.Optional(
        Type.Number({
            description:
                "Maximum seconds to wait before returning control. Defaults to 120. " +
                "Subagents continue running in the background after timeout.",
        }),
    ),
});

export async function stopLiveSubagents(): Promise<void> {
    await stopLegacySubagents();
}

function formatBackgroundSubagentResults(jobs: BackgroundSubagentJob[]): string {
    if (jobs.length === 0) return "No completed subagent jobs.";

    const parts: string[] = [];
    for (const job of jobs) {
        const elapsed = (((job.completedAt ?? Date.now()) - job.startedAt) / 1000).toFixed(1);
        const header = `### ${job.id} — ${job.agentName} (${job.status}, ${elapsed}s)`;

        if (job.status === "completed") {
            parts.push(`${header}\n\n${job.resultSummary ?? "(no output)"}`);
        } else if (job.status === "failed") {
            parts.push(`${header}\n\nError: ${job.stderr ?? "unknown error"}`);
        } else if (job.status === "cancelled") {
            parts.push(`${header}\n\nCancelled.`);
        }
    }

    return parts.join("\n\n---\n\n");
}

async function awaitBackgroundSubagents(
    manager: BackgroundJobManager,
    jobIds?: string[],
    timeoutSeconds = DEFAULT_AWAIT_SUBAGENT_TIMEOUT_SECONDS,
    signal?: AbortSignal,
): Promise<string> {
    const timeoutMs = timeoutSeconds * 1000;

    let watched: BackgroundSubagentJob[];
    if (jobIds && jobIds.length > 0) {
        watched = [];
        const notFound: string[] = [];
        for (const id of jobIds) {
            const job = manager.getJob(id);
            if (job) {
                watched.push(job);
            } else {
                notFound.push(id);
            }
        }
        if (notFound.length > 0 && watched.length === 0) {
            return `No subagent jobs found: ${notFound.join(", ")}`;
        }
    } else {
        watched = manager.getRunningJobs();
        if (watched.length === 0) {
            return "No running background subagents.";
        }
    }

    for (const job of watched) job.awaited = true;

    const running = watched.filter((job) => job.status === "running");
    if (running.length === 0) {
        return formatBackgroundSubagentResults(watched);
    }

    const TIMEOUT_SENTINEL = Symbol("timeout");
    const ABORT_SENTINEL = Symbol("abort");
    const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
        const timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
        if (typeof timer === "object" && "unref" in timer) timer.unref();
    });
    const abortPromise = signal
        ? new Promise<typeof ABORT_SENTINEL>((resolve) => {
            if (signal.aborted) {
                resolve(ABORT_SENTINEL);
            } else {
                signal.addEventListener("abort", () => resolve(ABORT_SENTINEL), { once: true });
            }
        })
        : null;

    const raceResult = await Promise.race([
        Promise.race(running.map((job) => job.promise)).then(() => "completed" as const),
        timeoutPromise,
        ...(abortPromise ? [abortPromise] : []),
    ]);

    const timedOut = raceResult === TIMEOUT_SENTINEL;
    const wasAborted = raceResult === ABORT_SENTINEL;
    const completed = watched.filter((job) => job.status !== "running");
    const stillRunning = watched.filter((job) => job.status === "running");

    let result = formatBackgroundSubagentResults(completed);
    if (stillRunning.length > 0) {
        result += `\n\n**Still running:** ${stillRunning.map((job) => `${job.id} (${job.agentName})`).join(", ")}`;
    }
    if (wasAborted) {
        result += `\n\n⎋ **Cancelled** — subagents are still running in the background. ` +
            `Use \`await_subagent\` or \`/subagents wait\` again later.`;
    } else if (timedOut) {
        result += `\n\n⏱ **Timed out** after ${timeoutSeconds}s waiting for subagents to finish. ` +
            `Subagents are still running in the background. ` +
            `Use \`await_subagent\` or \`/subagents wait\` again later.`;
    }

    return result;
}

function formatUsageStats(
    usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        cost: number;
        contextTokens?: number;
        turns?: number;
    },
    model?: string,
): string {
    const parts: string[] = [];
    if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
    if (usage.input) parts.push(`↑${formatTokenCount(usage.input)}`);
    if (usage.output) parts.push(`↓${formatTokenCount(usage.output)}`);
    if (usage.cacheRead) parts.push(`R${formatTokenCount(usage.cacheRead)}`);
    if (usage.cacheWrite) parts.push(`W${formatTokenCount(usage.cacheWrite)}`);
    if (usage.cost) parts.push(`$${(Number(usage.cost) || 0).toFixed(4)}`);
    if (usage.contextTokens && usage.contextTokens > 0) {
        parts.push(`ctx:${formatTokenCount(usage.contextTokens)}`);
    }
    if (model) parts.push(model);
    return parts.join(" ");
}

function formatToolCall(
    toolName: string,
    args: Record<string, unknown>,
    themeFg: (color: any, text: string) => string,
): string {
    const shortenPath = (p: string) => {
        const home = os.homedir();
        return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
    };

    switch (toolName) {
        case "bash": {
            const command = (args.command as string) || "...";
            const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
            return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
        }
        case "read": {
            const rawPath = (args.file_path || args.path || "...") as string;
            const filePath = shortenPath(rawPath);
            const offset = args.offset as number | undefined;
            const limit = args.limit as number | undefined;
            let text = themeFg("accent", filePath);
            if (offset !== undefined || limit !== undefined) {
                const startLine = offset ?? 1;
                const endLine = limit !== undefined ? startLine + limit - 1 : "";
                text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
            }
            return themeFg("muted", "read ") + text;
        }
        case "write": {
            const rawPath = (args.file_path || args.path || "...") as string;
            const filePath = shortenPath(rawPath);
            const content = (args.content || "") as string;
            const lines = content.split("\n").length;
            let text = themeFg("muted", "write ") + themeFg("accent", filePath);
            if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
            return text;
        }
        case "edit": {
            const rawPath = (args.file_path || args.path || "...") as string;
            return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
        }
        case "ls": {
            const rawPath = (args.path || ".") as string;
            return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
        }
        case "find": {
            const pattern = (args.pattern || "*") as string;
            const rawPath = (args.path || ".") as string;
            return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
        }
        case "grep": {
            const pattern = (args.pattern || "") as string;
            const rawPath = (args.path || ".") as string;
            return (
                themeFg("muted", "grep ") +
                themeFg("accent", `/${pattern}/`) +
                themeFg("dim", ` in ${shortenPath(rawPath)}`)
            );
        }
        default: {
            const argsStr = JSON.stringify(args);
            const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
            return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
        }
    }
}

interface UsageStats {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens: number;
    turns: number;
}

interface SingleResult {
    agent: string;
    agentSource: "bundled" | "user" | "project" | "unknown";
    task: string;
    exitCode: number;
    messages: Message[];
    stderr: string;
    usage: UsageStats;
    model?: string;
    stopReason?: string;
    errorMessage?: string;
    step?: number;
    backgroundJobId?: string;
    sessionFile?: string;
    parentSessionFile?: string;
}

interface SubagentDetails {
    mode: "single" | "parallel" | "chain";
    agentScope: AgentScope;
    projectAgentsDir: string | null;
    results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === "assistant") {
            for (const part of msg.content) {
                if (part.type === "text") return part.text;
            }
        }
    }
    return "";
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
    const items: DisplayItem[] = [];
    for (const msg of messages) {
        if (msg.role === "assistant") {
            for (const part of msg.content) {
                if (part.type === "text") items.push({ type: "text", text: part.text });
                else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
            }
        }
    }
    return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
    items: TIn[],
    concurrency: number,
    fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
    if (items.length === 0) return [];
    const limit = Math.max(1, Math.min(concurrency, items.length));
    const results: TOut[] = new Array(items.length);
    let nextIndex = 0;
    const workers = new Array(limit).fill(null).map(async () => {
        while (true) {
            const current = nextIndex++;
            if (current >= items.length) return;
            results[current] = await fn(items[current], current);
        }
    });
    await Promise.all(workers);
    return results;
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

const TaskItem = Type.Object({
    agent: Type.String({ description: "Name of the agent to invoke" }),
    task: Type.String({ description: "Task to delegate to the agent" }),
    cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
    model: Type.Optional(
        Type.String({
            description:
                "Optional model override. If omitted, the launcher infers one from the agent config, delegated-task preferences, or the current session model.",
        }),
    ),
});

const ChainItem = Type.Object({
    agent: Type.String({ description: "Name of the agent to invoke" }),
    task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
    cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
    model: Type.Optional(
        Type.String({
            description:
                "Optional model override. If omitted, the launcher infers one from the agent config, delegated-task preferences, or the current session model.",
        }),
    ),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
    description: 'Which agent directories to use. Default: "both".',
    default: "both",
});

const SubagentParams = Type.Object({
    agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
    task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
    tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
    chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
    agentScope: Type.Optional(AgentScopeSchema),
    confirmProjectAgents: Type.Optional(
        Type.Boolean({ description: "Prompt before running project-local agents. Default: false.", default: false }),
    ),
    cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
    model: Type.Optional(
        Type.String({
            description:
                "Optional model override for single mode. If omitted, the launcher infers one from the agent config, delegated-task preferences, or the current session model.",
        }),
    ),
    isolated: Type.Optional(
        Type.Boolean({
            description:
                "Run the subagent in an isolated filesystem (git worktree). " +
                "Changes are captured as patches and merged back. " +
                "Only available when taskIsolation.mode is configured in settings.",
            default: false,
        }),
    ),
    background: Type.Optional(
        Type.Boolean({
            description:
                "Run in detached background mode — returns immediately with a job ID (sa_xxxx). " +
                "Only valid for single mode ({ agent, task }). " +
                "The main session stays free while the subagent runs. " +
                "Completion is announced back into the session automatically. " +
                "Use /subagents to list, cancel, or inspect background jobs.",
            default: false,
        }),
    ),
});

export default function(pi: ExtensionAPI) {
    let bgManager: BackgroundJobManager | null = null;
    const foregroundSubagentStatusKey = "foreground-subagent";
    const foregroundSubagentHint = "Ctrl+B: move foreground subagent to background";
    type ActiveForegroundSubagent = {
        claimed: boolean;
        agentName: string;
        task: string;
        cwd: string;
        parentSessionFile?: string;
        resultPromise: Promise<{
            summary: string;
            stderr: string;
            exitCode: number;
            model?: string;
            sessionFile?: string;
            parentSessionFile?: string;
        }>;
        adoptToBackground: (jobId: string) => boolean;
        abortController?: AbortController;
        handle?: SubagentHandle;
        sendPrompt?: (text: string, images?: ImageContent[]) => Promise<void>;
        sendSteer?: (text: string, images?: ImageContent[]) => Promise<void>;
        sendFollowUp?: (text: string, images?: ImageContent[]) => Promise<void>;
        isBusy?: () => boolean;
    };
    let activeForegroundSubagent: ActiveForegroundSubagent | null = null;
    let activeSessionFileForUi: string | undefined;
    const liveStreamBufferBySession = new Map<string, string>();

    function flushLiveStream(sessionFile: string): void {
        const buffered = liveStreamBufferBySession.get(sessionFile);
        if (!buffered || !buffered.trim()) return;
        liveStreamBufferBySession.set(sessionFile, "");
        pi.sendMessage(
            {
                customType: "live_subagent_stream",
                content: buffered,
                display: true,
            },
            { deliverAs: "followUp" },
        );
    }

    function pushLiveStreamDelta(sessionFile: string, delta: string): void {
        const prev = liveStreamBufferBySession.get(sessionFile) ?? "";
        const next = prev + delta;
        liveStreamBufferBySession.set(sessionFile, next);
        if (next.length >= 120 || next.includes("\n")) {
            flushLiveStream(sessionFile);
        }
    }

    function getCurrentSessionSubagentMetadata(sessionFile: string | undefined) {
        if (!sessionFile) return null;
        return readSessionHeader(sessionFile);
    }

    function applyCurrentSessionSubagentTools(ctx: any): void {
        const metadata = getCurrentSessionSubagentMetadata(ctx.sessionManager.getSessionFile());
        if (metadata?.subagentTools && metadata.subagentTools.length > 0) {
            ctx.setActiveTools(metadata.subagentTools);
        }
    }

    function getBgManager(): BackgroundJobManager {
        if (!bgManager) throw new Error("BackgroundJobManager not initialized.");
        return bgManager;
    }

    pi.on("session_start", async (_event, ctx) => {
        activeSessionFileForUi = ctx.sessionManager.getSessionFile();
        bgManager = new BackgroundJobManager({
            onJobComplete: (job) => {
                if (job.sessionFile && job.parentSessionFile) {
                    const existingParent = parentSessionByChild.get(job.sessionFile);
                    if (!existingParent) {
                        registerAgentSessionLink({
                            agentName: job.agentName,
                            task: job.task,
                            parentSessionFile: job.parentSessionFile,
                            subagentSessionFile: job.sessionFile,
                            state: job.status === "failed" ? "failed" : "completed",
                        });
                    } else {
                        updateAgentSessionLinkState(job.sessionFile, job.status === "failed" ? "failed" : "completed");
                    }
                }

                if (job.awaited) return;
                const statusEmoji = job.status === "completed" ? "✓" : job.status === "cancelled" ? "✗ cancelled" : "✗ failed";
                const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(1);
                const taskPreview = job.task.length > 80 ? `${job.task.slice(0, 80)}…` : job.task;
                const output = job.status === "completed"
                    ? (job.resultSummary ?? "(no output)")
                    : `Error: ${job.stderr ?? "unknown error"}`;
                const modelInfo = job.model ? ` · ${job.model}` : "";

                // Use pi.sendMessage to deliver the background result message
                pi.sendMessage(
                    {
                        customType: "background_subagent_result",
                        content: [
                            `**Background subagent ${statusEmoji}: ${job.id}** (${job.agentName}, ${elapsed}s${modelInfo})`,
                            `> ${taskPreview}`,
                            "",
                            output,
                        ].join("\n"),
                        display: true,
                    },
                    { deliverAs: "followUp" },
                );
            },
        });
        applyCurrentSessionSubagentTools(ctx);
    });

    pi.on("session_switch", async (_event, ctx) => {
        activeSessionFileForUi = ctx.sessionManager.getSessionFile();
        applyCurrentSessionSubagentTools(ctx);
    });

    pi.on("before_agent_start", async (event, ctx) => {
        const metadata = getCurrentSessionSubagentMetadata(ctx.sessionManager.getSessionFile());
        if (!metadata?.subagentSystemPrompt) return;
        const subagentName = metadata.subagentName ?? "subagent";
        const taskNote = metadata.subagentTask
            ? `Original delegated task: ${metadata.subagentTask}`
            : "Continue operating as the delegated subagent for this session.";
        const antiRecursion = [
            `You are already the ${subagentName} subagent for this session.`,
            "Do not spawn or delegate to another subagent with the same name as yourself.",
            `If the user asks you to continue ${subagentName} work, do that work directly in this session.`,
            taskNote,
        ].join("\n");
        return {
            systemPrompt: `${event.systemPrompt}\n\n${antiRecursion}\n\n${metadata.subagentSystemPrompt}`,
        };
    });
    pi.on("input", async (event, ctx) => {
        const sessionFile = ctx.sessionManager.getSessionFile();
        const runtimeFromSession = sessionFile ? liveRuntimeBySessionFile.get(sessionFile) : undefined;
        const runtimeFromForeground = (!runtimeFromSession && activeForegroundSubagent && !activeForegroundSubagent.claimed &&
            activeForegroundSubagent.sendPrompt && activeForegroundSubagent.sendSteer && activeForegroundSubagent.sendFollowUp && activeForegroundSubagent.isBusy &&
            sessionFile && activeForegroundSubagent.parentSessionFile === sessionFile)
            ? {
                agentName: activeForegroundSubagent.agentName,
                isBusy: activeForegroundSubagent.isBusy,
                sendPrompt: activeForegroundSubagent.sendPrompt,
                sendSteer: activeForegroundSubagent.sendSteer,
                sendFollowUp: activeForegroundSubagent.sendFollowUp,
            }
            : undefined;
        const runtime = runtimeFromSession ?? runtimeFromForeground;
        if (!runtime) return;

        const text = event.text?.trim();
        if (!text) return { action: "handled" as const };

        const isSlashCommand = text.startsWith("/");
        if (isSlashCommand) return;

        try {
            if (runtime.isBusy()) {
                await runtime.sendSteer(text, event.images);
                ctx.ui.notify(`Sent steer to running subagent ${runtime.agentName}.`, "info");
            } else {
                await runtime.sendPrompt(text, event.images);
                ctx.ui.notify(`Sent prompt to live subagent ${runtime.agentName}.`, "info");
            }
            return { action: "handled" as const };
        } catch (error) {
            ctx.ui.notify(
                `Failed to send input to live subagent ${runtime.agentName}: ${error instanceof Error ? error.message : String(error)}`,
                "error",
            );
            return { action: "handled" as const };
        }
    });


    pi.on("session_before_switch", async () => {
        if (activeSessionFileForUi) flushLiveStream(activeSessionFileForUi);
        activeForegroundSubagent = null;
    });

    pi.on("session_shutdown", async () => {
        if (activeSessionFileForUi) flushLiveStream(activeSessionFileForUi);
        activeSessionFileForUi = undefined;
        activeForegroundSubagent = null;
        await stopLiveSubagents();
        if (bgManager) {
            bgManager.shutdown();
            bgManager = null;
        }
        agentSessionLinksById.clear();
        agentSessionIdsByParent.clear();
        parentSessionByChild.clear();
        liveRuntimeBySessionFile.clear();
        inProcessSubagentDepthBySessionId.clear();
        liveStreamBufferBySession.clear();
    });

    // /subagents command
    pi.registerCommand("subagents", {
        description: "List and manage background subagent jobs. Subcommands: list, wait [id], cancel <id>, output <id>, info <id>",
        handler: async (args: string, ctx) => {
            const manager = bgManager;
            if (!manager) {
                pi.sendMessage({ customType: "subagents_list", content: "No background subagent manager active.", display: true });
                return;
            }

            const parts = args.trim().split(/\s+/);
            const sub = parts[0] || "list";
            const jobId = parts[1];

            if (sub === "cancel" && jobId) {
                const result = manager.cancel(jobId);
                const msg = result === "cancelled"
                    ? `Cancelled background subagent **${jobId}**.`
                    : result === "not_found"
                        ? `Job **${jobId}** not found.`
                        : `Job **${jobId}** is already done (${result}).`;
                pi.sendMessage({ customType: "subagents_cancel", content: msg, display: true });
                return;
            }

            if (sub === "wait") {
                const output = await awaitBackgroundSubagents(manager, jobId ? [jobId] : undefined);
                pi.sendMessage({ customType: "subagents_wait", content: output, display: true });
                return;
            }

            if ((sub === "output" || sub === "info") && jobId) {
                const job = manager.getJob(jobId);
                if (!job) {
                    pi.sendMessage({ customType: "subagents_info", content: `Job **${jobId}** not found.`, display: true });
                    return;
                }
                const elapsed = (((job.completedAt ?? Date.now()) - job.startedAt) / 1000).toFixed(1);
                const lines = [
                    `## Background Subagent: ${job.id}`,
                    `- **Status:** ${job.status}`,
                    `- **Agent:** ${job.agentName}`,
                    `- **CWD:** ${job.cwd}`,
                    `- **Started:** ${new Date(job.startedAt).toISOString()}`,
                    job.completedAt ? `- **Completed:** ${new Date(job.completedAt).toISOString()} (${elapsed}s)` : `- **Elapsed:** ${elapsed}s`,
                    job.model ? `- **Model:** ${job.model}` : "",
                    job.exitCode !== undefined ? `- **Exit code:** ${job.exitCode}` : "",
                    "",
                    "### Task",
                    job.task,
                ];
                if (sub === "output" || sub === "info") {
                    if (job.resultSummary) {
                        lines.push("", "### Output", job.resultSummary);
                    }
                    if (job.stderr) {
                        lines.push("", "### Stderr", job.stderr);
                    }
                }
                pi.sendMessage({ customType: "subagents_info", content: lines.filter(l => l !== undefined).join("\n"), display: true });
                return;
            }

            // Default: list
            const running = manager.getRunningJobs();
            const recent = manager.getRecentJobs(10);
            const done = recent.filter((j) => j.status !== "running");
            const lines: string[] = ["## Background Subagents"];

            if (running.length === 0 && done.length === 0) {
                lines.push("", "No background subagent jobs.");
            } else {
                if (running.length > 0) {
                    lines.push("", "### Running");
                    for (const job of running) {
                        const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(0);
                        const preview = job.task.length > 50 ? `${job.task.slice(0, 50)}…` : job.task;
                        const modelSuffix = job.model ? ` · ${job.model}` : "";
                        lines.push(`- **${job.id}** [${job.agentName}${modelSuffix}] ${elapsed}s — ${preview}`);
                    }
                }
                if (done.length > 0) {
                    lines.push("", "### Recent");
                    for (const job of done) {
                        const elapsed = (((job.completedAt ?? Date.now()) - job.startedAt) / 1000).toFixed(1);
                        const preview = job.task.length > 50 ? `${job.task.slice(0, 50)}…` : job.task;
                        lines.push(`- **${job.id}** [${job.agentName}] ${job.status}, ${elapsed}s — ${preview}`);
                    }
                }
            }
            lines.push("", "_Use `/subagents wait [id]`, `/subagents cancel <id>`, `/subagents output <id>`, `/subagents info <id>`_");

            pi.sendMessage({ customType: "subagents_list", content: lines.join("\n"), display: true });
        },
    });

    // /subagent command - list available agents
    pi.registerCommand("subagent", {
        description: "List available subagents",
        handler: async (_args, ctx) => {
            const discovery = discoverAgents(ctx.cwd, "both");
            if (discovery.agents.length === 0) {
                ctx.ui.notify("No agents found. Add .md files to ~/.lsd/agent/agents/ (or your configured agent dir) or .lsd/agents/", "warning");
                return;
            }
            const lines = discovery.agents.map(
                (a) => `  ${a.name} [${a.source}]${a.model ? ` (${a.model})` : ""}: ${a.description}`,
            );
            ctx.ui.notify(`Available agents (${discovery.agents.length}):\n${lines.join("\n")}`, "info");
        },
    });

    // /agent command - switch to the parent or a tracked subagent session
    pi.registerCommand("agent", {
        description: "Switch focus to parent/subagent sessions (/agent picker, /agent <id|index|name>, /agent parent)",
        handler: async (args: string, ctx) => {
            const currentSessionFile = ctx.sessionManager.getSessionFile();
            if (!currentSessionFile) {
                ctx.ui.notify("Current session is in-memory only; /agent requires a persisted session file.", "warning");
                return;
            }

            const arg = args.trim();
            const parentSessionFile = parentSessionByChild.get(currentSessionFile);
            const currentParent = parentSessionFile ?? currentSessionFile;
            const currentSessionDir = path.dirname(currentParent);

            let tracked = getAgentSessionLinksForParent(currentParent).filter((entry) => fs.existsSync(entry.subagentSessionFile));
            if (tracked.length === 0) {
                tracked = backfillAgentSessionLinksForParent(currentParent, currentSessionDir)
                    .filter((entry) => fs.existsSync(entry.subagentSessionFile));
            }

            const runningJobs = bgManager?.getRunningJobs() ?? [];
            const switchTargets = buildSwitchTargetsForParent(
                currentParent,
                currentSessionFile,
                ctx.cwd,
                tracked,
                runningJobs,
            );

            const applySwitchTarget = async (target: AgentSwitchTarget): Promise<void> => {
                if (target.selectionAction === "blocked") {
                    ctx.ui.notify(target.blockedReason ?? "That target cannot be selected yet.", "warning");
                    return;
                }

                if (target.selectionAction === "attach_live") {
                    if (!fs.existsSync(target.sessionFile)) {
                        ctx.ui.notify(`Live subagent session file is missing: ${target.sessionFile}`, "error");
                        return;
                    }
                    const liveRuntime = liveRuntimeBySessionFile.get(target.sessionFile);
                    if (!liveRuntime) {
                        ctx.ui.notify("Live runtime is no longer available for this subagent. It may have completed.", "warning");
                        return;
                    }
                    const switched = await ctx.switchSession(target.sessionFile);
                    if (switched.cancelled) {
                        ctx.ui.notify("Session switch was cancelled.", "warning");
                        return;
                    }
                    ctx.ui.notify(`Attached to running subagent ${target.agentName}. Prompts in this session are routed live (busy => steer, idle => prompt). Use /agent parent to return.`, "info");
                    return;
                }

                if (target.kind === "parent") {
                    if (!fs.existsSync(target.sessionFile)) {
                        ctx.ui.notify(`Parent session file not found: ${target.sessionFile}`, "error");
                        return;
                    }
                    const switched = await ctx.switchSession(target.sessionFile);
                    if (switched.cancelled) {
                        ctx.ui.notify("Session switch was cancelled.", "warning");
                        return;
                    }
                    ctx.ui.notify("Switched to parent session.", "info");
                    return;
                }

                if (!fs.existsSync(target.sessionFile)) {
                    ctx.ui.notify(`Subagent session file is missing: ${target.sessionFile}`, "error");
                    return;
                }

                const switched = await ctx.switchSession(target.sessionFile);
                if (switched.cancelled) {
                    ctx.ui.notify("Session switch was cancelled.", "warning");
                    return;
                }
                updateAgentSessionLinkState(target.sessionFile, target.state === "failed" ? "failed" : "completed");
                ctx.ui.notify(`Switched to subagent ${target.agentName}. This resumes the saved subagent session; use /agent parent to return.`, "info");
            };

            if (!arg) {
                const subagentTargets = switchTargets.filter((target) => target.kind === "subagent");
                if (ctx.hasUI) {
                    if (subagentTargets.length === 0 && !parentSessionFile) {
                        ctx.ui.notify("No tracked subagent sessions for this parent session yet. Run a single-mode subagent first (foreground or background).", "info");
                        return;
                    }

                    const selected = await showAgentSwitcher(ctx, switchTargets);
                    if (!selected) return;
                    await applySwitchTarget(selected);
                    return;
                }

                if (subagentTargets.length === 0 && !parentSessionFile) {
                    ctx.ui.notify("No tracked subagent sessions for this parent session yet. Run a single-mode subagent first (foreground or background).", "info");
                    return;
                }

                const lines = ["Agent switch targets:"];
                switchTargets.forEach((target, index) => {
                    lines.push(`${index + 1}. ${formatSwitchTargetSummary(target)}`);
                });
                lines.push("", "Use `/agent <index|id|name>` for explicit targeting, or `/agent parent`.");
                ctx.ui.notify(lines.join("\n"), "info");
                return;
            }

            if (arg === "parent" || arg === "main") {
                if (!parentSessionFile) {
                    ctx.ui.notify("You are already in the parent/main session.", "info");
                    return;
                }
                if (!fs.existsSync(parentSessionFile)) {
                    ctx.ui.notify(`Parent session file not found: ${parentSessionFile}`, "error");
                    return;
                }
                const switched = await ctx.switchSession(parentSessionFile);
                if (switched.cancelled) {
                    ctx.ui.notify("Session switch was cancelled.", "warning");
                    return;
                }
                ctx.ui.notify("Switched to parent session.", "info");
                return;
            }

            let target: AgentSessionLink | undefined;
            if (/^\d+$/.test(arg)) {
                const index = Number.parseInt(arg, 10) - 1;
                target = tracked[index];
            }
            if (!target) {
                target = tracked.find((entry) => entry.id === arg);
            }
            if (!target) {
                target = tracked.find((entry) => entry.agentName === arg);
            }
            if (!target) {
                target = tracked.find((entry) => path.basename(entry.subagentSessionFile) === arg);
            }

            if (!target) {
                const runningTarget = switchTargets.find((entry) => entry.id === arg && entry.kind === "subagent");
                if (runningTarget?.state === "running") {
                    ctx.ui.notify(runningTarget.blockedReason ?? "Selected subagent is still running. Live attach is not implemented yet.", "warning");
                    return;
                }
                ctx.ui.notify(`Unknown subagent target: ${arg}. Run /agent to list available targets.`, "warning");
                return;
            }

            if (!fs.existsSync(target.subagentSessionFile)) {
                ctx.ui.notify(`Subagent session file is missing: ${target.subagentSessionFile}`, "error");
                return;
            }

            if (target.state === "running") {
                const liveRuntime = liveRuntimeBySessionFile.get(target.subagentSessionFile);
                if (!liveRuntime) {
                    ctx.ui.notify("Live runtime is no longer available for this subagent. It may have completed.", "warning");
                    return;
                }
                const switched = await ctx.switchSession(target.subagentSessionFile);
                if (switched.cancelled) {
                    ctx.ui.notify("Session switch was cancelled.", "warning");
                    return;
                }
                ctx.ui.notify(`Attached to running subagent ${target.agentName}. Prompts in this session are routed live (busy => steer, idle => prompt). Use /agent parent to return.`, "info");
                return;
            }

            const switched = await ctx.switchSession(target.subagentSessionFile);
            if (switched.cancelled) {
                ctx.ui.notify("Session switch was cancelled.", "warning");
                return;
            }
            updateAgentSessionLinkState(target.subagentSessionFile, target.state === "failed" ? "failed" : "completed");
            ctx.ui.notify(`Switched to subagent ${target.agentName}. This resumes the saved subagent session; use /agent parent to return.`, "info");
        },
    });
    pi.registerShortcut(Key.ctrl("b"), {
        description: shortcutDesc("Move foreground subagent to background", "/subagents list"),
        handler: async (ctx) => {
            const running = activeForegroundSubagent;
            if (!running || running.claimed) return;
            const manager = bgManager;
            if (!manager) {
                ctx.ui.notify("Background subagent manager is not available.", "error");
                return;
            }

            running.claimed = true;
            let jobId: string;
            try {
                if (running.handle) {
                    jobId = manager.adoptHandle(
                        running.agentName,
                        running.task,
                        running.cwd,
                        running.handle,
                        running.resultPromise,
                        {
                            parentSessionFile: running.parentSessionFile ?? ctx.sessionManager.getSessionFile(),
                        },
                    );
                } else if (running.abortController) {
                    jobId = manager.adoptRunning(
                        running.agentName,
                        running.task,
                        running.cwd,
                        running.abortController,
                        running.resultPromise,
                        {
                            parentSessionFile: running.parentSessionFile ?? ctx.sessionManager.getSessionFile(),
                        },
                    );
                } else {
                    throw new Error("Foreground subagent cannot be moved to background (missing runtime handle).");
                }
            } catch (error) {
                running.claimed = false;
                ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
                return;
            }

            const released = running.adoptToBackground(jobId);
            if (!released) {
                running.claimed = false;
                manager.cancel(jobId);
                return;
            }

            activeForegroundSubagent = null;
            ctx.ui.setStatus(foregroundSubagentStatusKey, undefined);
            ctx.ui.notify(
                `Moved ${running.agentName} to background as ${jobId}. Use /subagents wait ${jobId}, /subagents output ${jobId}, or /subagents cancel ${jobId}.`,
                "info",
            );
        },
    });

    pi.registerTool({
        name: "await_subagent",
        label: "Await Background Subagent",
        description:
            "Wait for background subagent jobs to complete. Provide specific sa_xxxx job IDs or omit jobs to wait for the next running background subagent.",
        promptGuidelines: [
            "Use await_subagent when the user wants to block until a background subagent finishes.",
            "Pass jobs when the user names a specific sa_xxxx job ID; omit jobs to wait for any running background subagent.",
            "Use a shorter timeout when polling and a longer timeout when the user explicitly wants to wait here.",
        ],
        parameters: AwaitSubagentParams,
        async execute(_toolCallId, params, signal) {
            const manager = getBgManager();
            const output = await awaitBackgroundSubagents(manager, params.jobs, params.timeout ?? DEFAULT_AWAIT_SUBAGENT_TIMEOUT_SECONDS, signal);
            return {
                content: [{ type: "text", text: output }],
                details: undefined,
            };
        },
    });

    pi.registerTool({
        name: "subagent",
        label: "Subagent",
        description: [
            "Delegate tasks to specialized subagents with isolated context windows.",
            "Each subagent is a separate pi process with its own tools, model, and system prompt.",
            "Model selection can be overridden per call, otherwise it is inferred from the agent config, delegated-task preferences, or the current session model.",
            "Modes: single ({ agent, task }), parallel ({ tasks: [{agent, task},...] }), chain ({ chain: [{agent, task},...] } with {previous} placeholder).",
            "Agents are defined as .md files in the configured user agent directory (for LSD this is typically ~/.lsd/agent/agents/) or project-local .lsd/agents/, with legacy support for .gsd/agents/ and .pi/agents/.",
            "If the user asks for a named subagent such as scout, worker, reviewer, or planner, invoke this tool directly rather than the Skill tool.",
            "Use the /subagent command to list available agents and their descriptions.",
            "Set background: true (single mode only) to run detached — returns immediately with a sa_xxxx job ID. Completion is announced back into the session. Use await_subagent or /subagents to manage background jobs.",
        ].join(" "),
        promptGuidelines: [
            "Use subagent to delegate self-contained tasks that benefit from an isolated context window.",
            "The subagent tool is available directly as a tool call — invoke it programmatically like any other tool, not via a slash command. Do NOT type '/scout' or '/subagent' in the chat; call this tool with the correct parameters instead.",
            "Valid call shapes: single mode uses { agent, task }, parallel mode uses { tasks: [{ agent, task }, ...] }, and chain mode uses { chain: [{ agent, task }, ...] }.",
            "If the user names a subagent such as scout, worker, reviewer, or planner, use this subagent tool directly rather than the Skill tool or ad-hoc search.",
            "Recon planning rule: use no scout for narrow known-file work, one scout for one broad unfamiliar subsystem, and parallel scouts only when the work spans multiple loosely-coupled subsystems.",
            "Use scout only for broad or unfamiliar codebase reconnaissance before you read many files yourself; save direct reads for targeted lookups once the relevant files are known.",
            "Do not use scout as the reviewer, auditor, or final judge. Scout should map architecture, files, ownership, and likely hotspots for another agent or the parent model to evaluate.",
            "If understanding the task would require scanning multiple files or folders to figure out architecture, routes, data flow, or ownership, launch scout first with single mode: { agent: 'scout', task: '...' }.",
            "If reconnaissance spans multiple loosely-coupled subsystems, prefer parallel scout subagents with { tasks: [{ agent: 'scout', task: 'map frontend...' }, { agent: 'scout', task: 'map backend...' }] }.",
            "When using scout for a review-like request, phrase the task as mapping: ask for architecture, key files, hotspots, and likely risk areas to inspect next — not for a final ranked review.",
            "For broad review or audit requests, use scout only as a prep step; the parent model or a reviewer should make the final judgments.",
            "Skip scout when the user already named the exact file/function to inspect or the task is obviously narrow.",
            "Use parallel mode when tasks are independent and don't need each other's output.",
            "Use background: true when the user wants to keep chatting while a long-running agent works in parallel.",
            "If the user wants to wait for a background subagent result, use await_subagent.",
        ],
        parameters: SubagentParams,

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const agentScope: AgentScope = params.agentScope ?? "both";
            const discovery = discoverAgents(ctx.cwd, agentScope);
            const agents = discovery.agents;
            const confirmProjectAgents = params.confirmProjectAgents ?? false;
            const cmuxClient = CmuxClient.fromPreferences(loadEffectivePreferences()?.preferences);
            const cmuxSplitsEnabled = cmuxClient.getConfig().splits;
            const invokingSessionFile = ctx.sessionManager.getSessionFile();
            const invokingSessionId = ctx.sessionManager.getSessionId();
            const currentSubagentDepth = inProcessSubagentDepthBySessionId.get(invokingSessionId) ?? 0;
            const nextSubagentDepth = currentSubagentDepth + 1;

            // Resolve isolation mode
            const isolationMode = readIsolationMode();
            const useIsolation = Boolean(params.isolated) && isolationMode !== "none";

            const hasChain = (params.chain?.length ?? 0) > 0;
            const hasTasks = (params.tasks?.length ?? 0) > 0;
            const hasSingle = Boolean(params.agent && params.task);
            const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

            const makeDetails =
                (mode: "single" | "parallel" | "chain") =>
                    (results: SingleResult[]): SubagentDetails => ({
                        mode,
                        agentScope,
                        projectAgentsDir: discovery.projectAgentsDir,
                        results,
                    });

            const trackInProcessDepth = (started: { handle: SubagentHandle; resultPromise: Promise<SingleResult> }, depth: number) => {
                const sessionId = started.handle.sessionId;
                if (!sessionId) return;
                inProcessSubagentDepthBySessionId.set(sessionId, depth);
                void started.resultPromise.finally(() => {
                    inProcessSubagentDepthBySessionId.delete(sessionId);
                });
            };

            if (modeCount !== 1) {
                const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
                return {
                    content: [
                        {
                            type: "text",
                            text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
                        },
                    ],
                    details: makeDetails("single")([]),
                };
            }

            if (params.background && !hasSingle) {
                return {
                    content: [{ type: "text", text: "background: true is only supported in single mode ({ agent, task }). Not valid for parallel or chain modes." }],
                    details: makeDetails(hasChain ? "chain" : "parallel")([]),
                    isError: true,
                };
            }

            if (USE_IN_PROCESS_SUBAGENT && nextSubagentDepth > MAX_IN_PROCESS_SUBAGENT_DEPTH) {
                return {
                    content: [{ type: "text", text: `Max subagent depth (${MAX_IN_PROCESS_SUBAGENT_DEPTH}) exceeded.` }],
                    details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
                    isError: true,
                };
            }

            if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
                const requestedAgentNames = new Set<string>();
                if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
                if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
                if (params.agent) requestedAgentNames.add(params.agent);

                const projectAgentsRequested = Array.from(requestedAgentNames)
                    .map((name) => agents.find((a) => a.name === name))
                    .filter((a): a is AgentConfig => a?.source === "project");

                if (projectAgentsRequested.length > 0) {
                    const names = projectAgentsRequested.map((a) => a.name).join(", ");
                    const dir = discovery.projectAgentsDir ?? "(unknown)";
                    const ok = await ctx.ui.confirm(
                        "Run project-local agents?",
                        `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
                    );
                    if (!ok)
                        return {
                            content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
                            details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
                        };
                }
            }

            if (params.chain && params.chain.length > 0) {
                const results: SingleResult[] = [];
                let previousOutput = "";

                for (let i = 0; i < params.chain.length; i++) {
                    const step = params.chain[i];
                    const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

                    // Create update callback that includes all previous results
                    const chainUpdate: OnUpdateCallback | undefined = onUpdate
                        ? (partial) => {
                            // Combine completed results with current streaming result
                            const currentResult = partial.details?.results[0];
                            if (currentResult) {
                                const allResults = [...results, currentResult];
                                onUpdate({
                                    content: partial.content,
                                    details: makeDetails("chain")(allResults),
                                });
                            }
                        }
                        : undefined;

                    const result = USE_IN_PROCESS_SUBAGENT
                        ? await (async () => {
                            const started = await startInProcessSingleAgent(
                                ctx.cwd,
                                agents,
                                step.agent,
                                taskWithContext,
                                step.cwd,
                                i + 1,
                                step.model,
                                ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
                                signal,
                                chainUpdate,
                                makeDetails("chain"),
                                invokingSessionFile,
                                nextSubagentDepth,
                            );
                            trackInProcessDepth(started, nextSubagentDepth);
                            return started.resultPromise;
                        })()
                        : await runLegacySingleAgent(
                            ctx.cwd,
                            agents,
                            step.agent,
                            taskWithContext,
                            step.cwd,
                            i + 1,
                            step.model,
                            ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
                            signal,
                            chainUpdate,
                            makeDetails("chain"),
                            invokingSessionFile,
                            false,
                            undefined,
                            undefined,
                        );
                    results.push(result);

                    const isError =
                        result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
                    if (isError) {
                        const errorMsg =
                            result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
                        return {
                            content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
                            details: makeDetails("chain")(results),
                            isError: true,
                        };
                    }
                    previousOutput = getFinalOutput(result.messages);
                }
                return {
                    content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
                    details: makeDetails("chain")(results),
                };
            }

            if (params.tasks && params.tasks.length > 0) {
                if (params.tasks.length > MAX_PARALLEL_TASKS)
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
                            },
                        ],
                        details: makeDetails("parallel")([]),
                    };

                // Track all results for streaming updates
                const allResults: SingleResult[] = new Array(params.tasks.length);

                // Initialize placeholder results
                for (let i = 0; i < params.tasks.length; i++) {
                    allResults[i] = {
                        agent: params.tasks[i].agent,
                        agentSource: "unknown",
                        task: params.tasks[i].task,
                        exitCode: -1, // -1 = still running
                        messages: [],
                        stderr: "",
                        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
                    };
                }

                const emitParallelUpdate = () => {
                    if (onUpdate) {
                        const running = allResults.filter((r) => r.exitCode === -1).length;
                        const done = allResults.filter((r) => r.exitCode !== -1).length;
                        onUpdate({
                            content: [
                                { type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
                            ],
                            details: makeDetails("parallel")([...allResults]),
                        });
                    }
                };

                const MAX_RETRIES = 1; // Retry failed tasks once
                const batchId = crypto.randomUUID();
                const batchSize = params.tasks.length;
                // Pre-create a grid layout for cmux splits so agents get a clean tiled arrangement
                const gridSurfaces: string[] = [];
                const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
                    const workerId = registerWorker(t.agent, t.task, index, batchSize, batchId);
                    const runTask = () =>
                        USE_IN_PROCESS_SUBAGENT
                            ? (async () => {
                                const started = await startInProcessSingleAgent(
                                    ctx.cwd,
                                    agents,
                                    t.agent,
                                    t.task,
                                    t.cwd,
                                    undefined,
                                    t.model,
                                    ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
                                    signal,
                                    (partial) => {
                                        if (partial.details?.results[0]) {
                                            allResults[index] = partial.details.results[0];
                                            emitParallelUpdate();
                                        }
                                    },
                                    makeDetails("parallel"),
                                    invokingSessionFile,
                                    nextSubagentDepth,
                                );
                                trackInProcessDepth(started, nextSubagentDepth);
                                return started.resultPromise;
                            })()
                            : runLegacySingleAgent(
                                ctx.cwd,
                                agents,
                                t.agent,
                                t.task,
                                t.cwd,
                                undefined,
                                t.model,
                                ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
                                signal,
                                (partial) => {
                                    if (partial.details?.results[0]) {
                                        allResults[index] = partial.details.results[0];
                                        emitParallelUpdate();
                                    }
                                },
                                makeDetails("parallel"),
                                invokingSessionFile,
                                false,
                                undefined,
                            );
                    let result = await runTask();

                    // Auto-retry failed tasks (likely API rate limit or transient error)
                    const isFailed = result.exitCode !== 0 || (result.messages.length === 0 && !signal?.aborted);
                    if (isFailed && MAX_RETRIES > 0 && !signal?.aborted) {
                        result = await runTask();
                    }

                    updateWorker(workerId, result.exitCode === 0 ? "completed" : "failed");
                    allResults[index] = result;
                    emitParallelUpdate();
                    return result;
                });

                const successCount = results.filter((r) => r.exitCode === 0).length;
                const summaries = results.map((r) => {
                    const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
                    const output = isError
                        ? (r.errorMessage || r.stderr || getFinalOutput(r.messages) || "(no output)")
                        : getFinalOutput(r.messages);
                    return `[${r.agent}] ${r.exitCode === 0 ? "completed" : `failed (exit ${r.exitCode})`}: ${output || "(no output)"}`;
                });
                return {
                    content: [
                        {
                            type: "text",
                            text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
                        },
                    ],
                    details: makeDetails("parallel")(results),
                };
            }

            if (params.agent && params.task) {
                // ── Background mode ──────────────────────────────────────────
                if (params.background) {
                    const manager = bgManager;
                    if (!manager) {
                        return {
                            content: [{ type: "text", text: "Background subagent manager not initialized." }],
                            details: makeDetails("single")([]),
                            isError: true,
                        };
                    }

                    const agentForBg = agents.find((a) => a.name === params.agent);
                    if (!agentForBg) {
                        const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
                        return {
                            content: [{ type: "text", text: `Unknown agent: "${params.agent}". Available: ${available}` }],
                            details: makeDetails("single")([]),
                            isError: true,
                        };
                    }

                    // Pre-resolve model so we can show it in the launch message
                    const bgPreferences = loadEffectivePreferences()?.preferences;
                    const bgSettingsBudgetModel = readBudgetSubagentModelFromSettings();
                    const bgResolvedModelCfg = resolveConfiguredSubagentModel(agentForBg, bgPreferences, bgSettingsBudgetModel);
                    const bgInferredModel = resolveSubagentModel(
                        { name: agentForBg.name, model: bgResolvedModelCfg },
                        { overrideModel: params.model, parentModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined },
                    );

                    let jobId: string;
                    try {
                        if (USE_IN_PROCESS_SUBAGENT) {
                            const started = await startInProcessSingleAgent(
                                ctx.cwd,
                                agents,
                                params.agent,
                                params.task,
                                params.cwd,
                                undefined,
                                params.model,
                                ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
                                undefined,
                                undefined,
                                makeDetails("single"),
                                invokingSessionFile,
                                nextSubagentDepth,
                            );
                            trackInProcessDepth(started, nextSubagentDepth);

                            const effectiveCwd = params.cwd ?? ctx.cwd;
                            jobId = manager.adoptHandle(
                                params.agent,
                                params.task,
                                effectiveCwd,
                                started.handle,
                                started.resultPromise.then((result) => ({
                                    summary: (getFinalOutput(result.messages) || "(no output)").slice(0, 300),
                                    stderr: result.stderr,
                                    exitCode: result.exitCode,
                                    model: result.model,
                                    sessionFile: result.sessionFile,
                                    parentSessionFile: result.parentSessionFile,
                                })),
                                {
                                    parentSessionFile: invokingSessionFile,
                                    model: bgInferredModel,
                                },
                            );
                        } else {
                            jobId = runSubagentInBackground(
                                manager,
                                agents,
                                params.agent,
                                params.task,
                                params.cwd,
                                params.model,
                                { defaultCwd: ctx.cwd, model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined, parentSessionFile: invokingSessionFile },
                                async (bgSignal) => {
                                    let liveSessionFile: string | undefined;
                                    let liveRuntime: LiveSubagentRuntime | undefined;
                                    const result = await runLegacySingleAgent(
                                        ctx.cwd,
                                        agents,
                                        params.agent!,
                                        params.task!,
                                        params.cwd,
                                        undefined,
                                        params.model,
                                        ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
                                        bgSignal,
                                        undefined, // no streaming updates for background jobs
                                        makeDetails("single"),
                                        invokingSessionFile,
                                        true,
                                        (info) => {
                                            if (!invokingSessionFile || !info.sessionFile) return;
                                            upsertAgentSessionLink(
                                                params.agent!,
                                                params.task!,
                                                invokingSessionFile,
                                                info.sessionFile,
                                                "running",
                                            );
                                            liveSessionFile = info.sessionFile;
                                            if (liveRuntime) {
                                                liveRuntime.sessionFile = info.sessionFile;
                                                liveRuntime.parentSessionFile = info.parentSessionFile ?? invokingSessionFile;
                                                liveRuntimeBySessionFile.set(info.sessionFile, liveRuntime);
                                            }
                                        },
                                        (event, partial) => {
                                            const sessionFile = partial.sessionFile;
                                            if (!sessionFile || activeSessionFileForUi !== sessionFile) return;
                                            if (event?.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
                                                const delta = String(event.assistantMessageEvent.delta ?? "");
                                                if (delta) pushLiveStreamDelta(sessionFile, delta);
                                            }
                                            if (event?.type === "message_end") {
                                                flushLiveStream(sessionFile);
                                            }
                                        },
                                        {
                                            onStart: (control) => {
                                                if (!control.sendPrompt || !control.sendSteer || !control.sendFollowUp || !control.isBusy) return;
                                                liveRuntime = {
                                                    sessionFile: liveSessionFile,
                                                    parentSessionFile: invokingSessionFile,
                                                    agentName: params.agent!,
                                                    isBusy: control.isBusy,
                                                    sendPrompt: control.sendPrompt,
                                                    sendSteer: control.sendSteer,
                                                    sendFollowUp: control.sendFollowUp,
                                                };
                                                if (liveSessionFile) {
                                                    liveRuntimeBySessionFile.set(liveSessionFile, liveRuntime);
                                                }
                                            },
                                            onFinish: () => {
                                                if (liveSessionFile) liveRuntimeBySessionFile.delete(liveSessionFile);
                                            },
                                        },
                                    );
                                    return {
                                        exitCode: result.exitCode,
                                        finalOutput: getFinalOutput(result.messages),
                                        stderr: result.stderr,
                                        model: result.model,
                                        sessionFile: result.sessionFile,
                                        parentSessionFile: result.parentSessionFile,
                                    };
                                },
                            );
                        }
                    } catch (err) {
                        return {
                            content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
                            details: makeDetails("single")([]),
                            isError: true,
                        };
                    }

                    const bgModelLine = bgInferredModel ? `\nModel: ${bgInferredModel}` : "";
                    return {
                        content: [{ type: "text", text: `Background subagent started. Job ID: **${jobId}**\nAgent: ${params.agent}${bgModelLine}\nUse \`await_subagent\` to wait, \`/subagents wait ${jobId}\` to block in the TUI, or \`/subagents cancel ${jobId}\` to stop it.` }],
                        details: makeDetails("single")([]),
                    };
                }

                // ── Foreground (blocking) mode ───────────────────────────────
                let isolation: IsolationEnvironment | null = null;
                let mergeResult: MergeResult | undefined;
                try {
                    const effectiveCwd = params.cwd ?? ctx.cwd;


                    if (useIsolation) {
                        const taskId = crypto.randomUUID();
                        isolation = await createIsolation(effectiveCwd, taskId, isolationMode);
                    }

                    let result: SingleResult;
                    if (USE_IN_PROCESS_SUBAGENT && !isolation) {
                        const started = await startInProcessSingleAgent(
                            ctx.cwd,
                            agents,
                            params.agent,
                            params.task,
                            params.cwd,
                            undefined,
                            params.model,
                            ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
                            signal,
                            onUpdate,
                            makeDetails("single"),
                            invokingSessionFile,
                            nextSubagentDepth,
                        );
                        trackInProcessDepth(started, nextSubagentDepth);

                        const effectiveRunCwd = params.cwd ?? ctx.cwd;
                        let releaseToBackground: ((jobId: string) => void) | undefined;
                        const movedToBackground = new Promise<string>((resolve) => {
                            releaseToBackground = resolve;
                        });

                        activeForegroundSubagent = {
                            claimed: false,
                            agentName: params.agent,
                            task: params.task,
                            cwd: effectiveRunCwd,
                            parentSessionFile: invokingSessionFile,
                            handle: started.handle,
                            resultPromise: started.resultPromise.then((done) => ({
                                summary: getFinalOutput(done.messages) || "(no output)",
                                stderr: done.stderr,
                                exitCode: done.exitCode,
                                model: done.model,
                                sessionFile: done.sessionFile,
                                parentSessionFile: done.parentSessionFile,
                            })),
                            adoptToBackground: (jobId: string) => {
                                if (!releaseToBackground) return false;
                                releaseToBackground(jobId);
                                releaseToBackground = undefined;
                                return true;
                            },
                            sendPrompt: started.handle.prompt,
                            sendSteer: started.handle.steer,
                            sendFollowUp: started.handle.followUp,
                            isBusy: started.handle.isBusy,
                        };
                        ctx.ui.setStatus(foregroundSubagentStatusKey, foregroundSubagentHint);

                        const winner = await Promise.race([
                            started.resultPromise.then((done) => ({ type: "done" as const, done })),
                            movedToBackground.then((jobId) => ({ type: "background" as const, jobId })),
                        ]);

                        if (winner.type === "background") {
                            activeForegroundSubagent = null;
                            ctx.ui.setStatus(foregroundSubagentStatusKey, undefined);
                            result = {
                                ...started.currentResult,
                                backgroundJobId: winner.jobId,
                            };
                        } else {
                            activeForegroundSubagent = null;
                            ctx.ui.setStatus(foregroundSubagentStatusKey, undefined);
                            result = winner.done;
                        }
                    } else {
                        let liveSessionFile: string | undefined;
                        let liveRuntime: LiveSubagentRuntime | undefined;
                        result = await runLegacySingleAgent(
                            ctx.cwd,
                            agents,
                            params.agent,
                            params.task,
                            isolation ? isolation.workDir : params.cwd,
                            undefined,
                            params.model,
                            ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
                            signal,
                            onUpdate,
                            makeDetails("single"),
                            invokingSessionFile,
                            !isolation,
                            !isolation
                                ? (info) => {
                                    if (!invokingSessionFile || !info.sessionFile) return;
                                    upsertAgentSessionLink(
                                        params.agent!,
                                        params.task!,
                                        invokingSessionFile,
                                        info.sessionFile,
                                        "running",
                                    );
                                    liveSessionFile = info.sessionFile;
                                    if (liveRuntime) {
                                        liveRuntime.sessionFile = info.sessionFile;
                                        liveRuntime.parentSessionFile = info.parentSessionFile ?? invokingSessionFile;
                                        liveRuntimeBySessionFile.set(info.sessionFile, liveRuntime);
                                    }
                                }
                                : undefined,
                            !isolation
                                ? (event, partial) => {
                                    const sessionFile = partial.sessionFile;
                                    if (!sessionFile || activeSessionFileForUi !== sessionFile) return;
                                    if (event?.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
                                        const delta = String(event.assistantMessageEvent.delta ?? "");
                                        if (delta) pushLiveStreamDelta(sessionFile, delta);
                                    }
                                    if (event?.type === "message_end") {
                                        flushLiveStream(sessionFile);
                                    }
                                }
                                : undefined,
                            !isolation
                                ? {
                                    onStart: (control) => {
                                        activeForegroundSubagent = { ...control, claimed: false };
                                        ctx.ui.setStatus(foregroundSubagentStatusKey, foregroundSubagentHint);

                                        if (!control.sendPrompt || !control.sendSteer || !control.sendFollowUp || !control.isBusy) return;
                                        liveRuntime = {
                                            sessionFile: liveSessionFile,
                                            parentSessionFile: invokingSessionFile,
                                            agentName: params.agent!,
                                            isBusy: control.isBusy,
                                            sendPrompt: control.sendPrompt,
                                            sendSteer: control.sendSteer,
                                            sendFollowUp: control.sendFollowUp,
                                        };
                                        if (liveSessionFile && liveRuntime) {
                                            liveRuntimeBySessionFile.set(liveSessionFile, liveRuntime);
                                        }
                                    },
                                    onFinish: () => {
                                        activeForegroundSubagent = null;
                                        ctx.ui.setStatus(foregroundSubagentStatusKey, undefined);
                                        if (liveSessionFile) liveRuntimeBySessionFile.delete(liveSessionFile);
                                    },
                                }
                                : undefined,
                        );
                    }

                    if (result.sessionFile && invokingSessionFile) {
                        const existingParent = parentSessionByChild.get(result.sessionFile);
                        if (!existingParent) {
                            registerAgentSessionLink({
                                agentName: result.agent,
                                task: result.task,
                                parentSessionFile: invokingSessionFile,
                                subagentSessionFile: result.sessionFile,
                                state: result.exitCode === 0 ? "completed" : "failed",
                            });
                        } else {
                            updateAgentSessionLinkState(result.sessionFile, result.exitCode === 0 ? "completed" : "failed");
                        }
                    }

                    if (result.backgroundJobId) {
                        return {
                            content: [{ type: "text", text: `Moved ${result.agent} to background as **${result.backgroundJobId}**. Use \`await_subagent\`, \`/subagents wait ${result.backgroundJobId}\`, or \`/subagents output ${result.backgroundJobId}\`.` }],
                            details: makeDetails("single")([result]),
                        };
                    }

                    // Capture and merge delta if isolated
                    if (isolation) {
                        const patches = await isolation.captureDelta();
                        if (patches.length > 0) {
                            mergeResult = await mergeDeltaPatches(effectiveCwd, patches);
                        }
                    }

                    const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
                    const agentSwitchHint = result.sessionFile ? "\n\nTip: run `/agent` to switch focus to this subagent session." : "";
                    if (isError) {
                        const errorMsg =
                            result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
                        return {
                            content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}${agentSwitchHint}` }],
                            details: makeDetails("single")([result]),
                            isError: true,
                        };
                    }


                    let outputText = getFinalOutput(result.messages) || "(no output)";
                    if (mergeResult && !mergeResult.success) {
                        outputText += `\n\n⚠ Patch merge failed: ${mergeResult.error || "unknown error"}`;
                    }
                    if (agentSwitchHint) outputText += agentSwitchHint;
                    return {
                        content: [{ type: "text", text: outputText }],
                        details: makeDetails("single")([result]),
                    };
                } finally {
                    if (isolation) {
                        await isolation.cleanup();
                    }
                }
            }

            const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
            return {
                content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
                details: makeDetails("single")([]),
            };
        },

        renderCall(args, theme) {
            const scope: AgentScope = args.agentScope ?? "both";
            if (args.chain && args.chain.length > 0) {
                let text =
                    theme.fg("toolTitle", theme.bold("subagent ")) +
                    theme.fg("accent", `chain (${args.chain.length} steps)`);
                for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
                    const step = args.chain[i];
                    // Clean up {previous} placeholder for display
                    const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
                    const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
                    text +=
                        "\n  " +
                        theme.fg("muted", `${i + 1}.`) +
                        " " +
                        theme.fg("accent", step.agent) +
                        theme.fg("dim", ` ${preview}`);
                }
                if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
                return new Text(text, 0, 0);
            }
            if (args.tasks && args.tasks.length > 0) {
                let text =
                    theme.fg("toolTitle", theme.bold("subagent ")) +
                    theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
                for (const t of args.tasks.slice(0, 3)) {
                    const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
                    text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
                }
                if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
                return new Text(text, 0, 0);
            }
            const agentName = args.agent || "...";
            const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
            let text =
                theme.fg("toolTitle", theme.bold("subagent ")) +
                theme.fg("accent", agentName);
            text += `\n  ${theme.fg("dim", preview)}`;
            return new Text(text, 0, 0);
        },

        renderResult(result, { expanded }, theme) {
            const details = result.details as SubagentDetails | undefined;
            if (!details || details.results.length === 0) {
                const text = result.content[0];
                return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
            }

            const mdTheme = getMarkdownTheme();

            const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
                const toShow = limit ? items.slice(-limit) : items;
                const skipped = limit && items.length > limit ? items.length - limit : 0;
                let text = "";
                if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
                for (const item of toShow) {
                    if (item.type === "text") {
                        const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
                        text += `${theme.fg("toolOutput", preview)}\n`;
                    } else {
                        text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
                    }
                }
                return text.trimEnd();
            };

            if (details.mode === "single" && details.results.length === 1) {
                const r = details.results[0];
                const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
                const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
                const displayItems = getDisplayItems(r.messages);
                const finalOutput = getFinalOutput(r.messages);

                if (expanded) {
                    const container = new Container();
                    let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
                    if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
                    container.addChild(new Text(header, 0, 0));
                    if (isError && r.errorMessage)
                        container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
                    container.addChild(new Spacer(1));
                    container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
                    container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
                    container.addChild(new Spacer(1));
                    container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
                    if (displayItems.length === 0 && !finalOutput) {
                        container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
                    } else {
                        for (const item of displayItems) {
                            if (item.type === "toolCall")
                                container.addChild(
                                    new Text(
                                        theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                                        0,
                                        0,
                                    ),
                                );
                        }
                        if (finalOutput) {
                            container.addChild(new Spacer(1));
                            container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
                        }
                    }
                    const usageStr = formatUsageStats(r.usage, r.model);
                    if (usageStr) {
                        container.addChild(new Spacer(1));
                        container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
                    }
                    return container;
                }

                let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
                if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
                if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
                else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
                else {
                    text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
                    if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
                }
                if (!isError && !r.backgroundJobId && !finalOutput) {
                    text += `\n${theme.fg("muted", "Hint: Ctrl+B to move running foreground subagent to background")}`;
                }
                const usageStr = formatUsageStats(r.usage, r.model);
                if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
                return new Text(text, 0, 0);
            }

            const aggregateUsage = (results: SingleResult[]) => {
                const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
                for (const r of results) {
                    total.input += r.usage.input;
                    total.output += r.usage.output;
                    total.cacheRead += r.usage.cacheRead;
                    total.cacheWrite += r.usage.cacheWrite;
                    total.cost += r.usage.cost;
                    total.turns += r.usage.turns;
                }
                return total;
            };

            if (details.mode === "chain") {
                const successCount = details.results.filter((r) => r.exitCode === 0).length;
                const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

                if (expanded) {
                    const container = new Container();
                    container.addChild(
                        new Text(
                            icon +
                            " " +
                            theme.fg("toolTitle", theme.bold("chain ")) +
                            theme.fg("accent", `${successCount}/${details.results.length} steps`),
                            0,
                            0,
                        ),
                    );

                    for (const r of details.results) {
                        const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
                        const displayItems = getDisplayItems(r.messages);
                        const finalOutput = getFinalOutput(r.messages);

                        container.addChild(new Spacer(1));
                        container.addChild(
                            new Text(
                                `${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
                                0,
                                0,
                            ),
                        );
                        container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

                        // Show tool calls
                        for (const item of displayItems) {
                            if (item.type === "toolCall") {
                                container.addChild(
                                    new Text(
                                        theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                                        0,
                                        0,
                                    ),
                                );
                            }
                        }

                        // Show final output as markdown
                        if (finalOutput) {
                            container.addChild(new Spacer(1));
                            container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
                        }

                        const stepUsage = formatUsageStats(r.usage, r.model);
                        if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
                    }

                    const usageStr = formatUsageStats(aggregateUsage(details.results));
                    if (usageStr) {
                        container.addChild(new Spacer(1));
                        container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
                    }
                    return container;
                }

                // Collapsed view
                let text =
                    icon +
                    " " +
                    theme.fg("toolTitle", theme.bold("chain ")) +
                    theme.fg("accent", `${successCount}/${details.results.length} steps`);
                for (const r of details.results) {
                    const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
                    const displayItems = getDisplayItems(r.messages);
                    text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
                    if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
                    else text += `\n${renderDisplayItems(displayItems, 5)}`;
                }
                const usageStr = formatUsageStats(aggregateUsage(details.results));
                if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
                text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
                return new Text(text, 0, 0);
            }

            if (details.mode === "parallel") {
                const running = details.results.filter((r) => r.exitCode === -1).length;
                const successCount = details.results.filter((r) => r.exitCode === 0).length;
                const failCount = details.results.filter((r) => r.exitCode > 0).length;
                const isRunning = running > 0;
                const icon = isRunning
                    ? theme.fg("warning", "⏳")
                    : failCount > 0
                        ? theme.fg("warning", "◐")
                        : theme.fg("success", "✓");
                const status = isRunning
                    ? `${successCount + failCount}/${details.results.length} done, ${running} running`
                    : `${successCount}/${details.results.length} tasks`;

                if (expanded && !isRunning) {
                    const container = new Container();
                    container.addChild(
                        new Text(
                            `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
                            0,
                            0,
                        ),
                    );

                    for (const r of details.results) {
                        const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
                        const displayItems = getDisplayItems(r.messages);
                        const finalOutput = getFinalOutput(r.messages);

                        container.addChild(new Spacer(1));
                        container.addChild(
                            new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
                        );
                        container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

                        // Show tool calls
                        for (const item of displayItems) {
                            if (item.type === "toolCall") {
                                container.addChild(
                                    new Text(
                                        theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                                        0,
                                        0,
                                    ),
                                );
                            }
                        }

                        // Show final output as markdown
                        if (finalOutput) {
                            container.addChild(new Spacer(1));
                            container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
                        }

                        const taskUsage = formatUsageStats(r.usage, r.model);
                        if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
                    }

                    const usageStr = formatUsageStats(aggregateUsage(details.results));
                    if (usageStr) {
                        container.addChild(new Spacer(1));
                        container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
                    }
                    return container;
                }

                // Collapsed view (or still running)
                let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
                for (const r of details.results) {
                    const rIcon =
                        r.exitCode === -1
                            ? theme.fg("warning", "⏳")
                            : r.exitCode === 0
                                ? theme.fg("success", "✓")
                                : theme.fg("error", "✗");
                    const displayItems = getDisplayItems(r.messages);
                    text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
                    if (displayItems.length === 0)
                        text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
                    else text += `\n${renderDisplayItems(displayItems, 5)}`;
                }
                if (!isRunning) {
                    const usageStr = formatUsageStats(aggregateUsage(details.results));
                    if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
                }
                if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
                return new Text(text, 0, 0);
            }

            const text = result.content[0];
            return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
        },
    });
}

