import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@gsd/pi-agent-core";
import type { ImageContent, Message } from "@gsd/pi-ai";
import { getAgentDir } from "@gsd/pi-coding-agent";
import type { AgentConfig } from "./agents.js";
import { buildSubagentProcessArgs, getBundledExtensionPathsFromEnv } from "./launch-helpers.js";
import { handleSubagentPermissionRequest, isSubagentPermissionRequest } from "./approval-proxy.js";
import { resolveConfiguredSubagentModel } from "./configured-model.js";
import { normalizeSubagentModel, resolveSubagentModel } from "./model-resolution.js";
import { loadEffectivePreferences } from "../shared/preferences.js";

const liveSubagentProcesses = new Set<ChildProcess>();

export interface LegacyUsageStats {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens: number;
    turns: number;
}

export interface LegacySingleResult {
    agent: string;
    agentSource: "bundled" | "user" | "project" | "unknown";
    task: string;
    exitCode: number;
    messages: Message[];
    stderr: string;
    usage: LegacyUsageStats;
    model?: string;
    stopReason?: string;
    errorMessage?: string;
    step?: number;
    backgroundJobId?: string;
    sessionFile?: string;
    parentSessionFile?: string;
}

type BackgroundResultPayload = {
    summary: string;
    stderr: string;
    exitCode: number;
    model?: string;
    sessionFile?: string;
    parentSessionFile?: string;
};

export interface ForegroundSingleRunControl {
    agentName: string;
    task: string;
    cwd: string;
    parentSessionFile?: string;
    abortController: AbortController;
    resultPromise: Promise<BackgroundResultPayload>;
    adoptToBackground: (jobId: string) => boolean;
    sendPrompt?: (text: string, images?: ImageContent[]) => Promise<void>;
    sendSteer?: (text: string, images?: ImageContent[]) => Promise<void>;
    sendFollowUp?: (text: string, images?: ImageContent[]) => Promise<void>;
    isBusy?: () => boolean;
}

export interface ForegroundSingleRunHooks {
    onStart?: (control: ForegroundSingleRunControl) => void;
    onFinish?: () => void;
}

export type LegacyOnUpdateCallback<TDetails> = (partial: AgentToolResult<TDetails>) => void;

export function readBudgetSubagentModelFromSettings(): string | undefined {
    try {
        const settingsPath = path.join(getAgentDir(), "settings.json");
        if (!fs.existsSync(settingsPath)) return undefined;
        const raw = fs.readFileSync(settingsPath, "utf-8");
        const parsed = JSON.parse(raw) as { budgetSubagentModel?: unknown };
        return typeof parsed.budgetSubagentModel === "string"
            ? normalizeSubagentModel(parsed.budgetSubagentModel)
            : undefined;
    } catch {
        return undefined;
    }
}

export async function stopLegacySubagents(): Promise<void> {
    const active = Array.from(liveSubagentProcesses);
    if (active.length === 0) return;

    for (const proc of active) {
        try {
            proc.kill("SIGTERM");
        } catch {
            /* ignore */
        }
    }

    await Promise.all(
        active.map(
            (proc) =>
                new Promise<void>((resolve) => {
                    const done = () => resolve();
                    const timer = setTimeout(done, 500);
                    proc.once("exit", () => {
                        clearTimeout(timer);
                        resolve();
                    });
                }),
        ),
    );

    for (const proc of active) {
        if (proc.exitCode === null) {
            try {
                proc.kill("SIGKILL");
            } catch {
                /* ignore */
            }
        }
    }
}

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

function detectNewSubagentSessionFile(sessionDir: string, before: Set<string>, startedAt: number): string | undefined {
    const after = listSessionFiles(sessionDir);
    const created = after.filter((file) => !before.has(file));
    const candidates = created.length > 0 ? created : after;
    const ranked = candidates
        .map((file) => {
            let mtime = 0;
            try {
                mtime = fs.statSync(file).mtimeMs;
            } catch {
                mtime = 0;
            }
            return { file, mtime };
        })
        .filter((entry) => entry.mtime >= startedAt - 5000)
        .sort((a, b) => b.mtime - a.mtime);
    return ranked[0]?.file;
}

function resolveSubagentCliPath(defaultCwd: string): string | null {
    const candidates = [process.env.GSD_BIN_PATH, process.env.LSD_BIN_PATH, process.argv[1]]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value && value !== "undefined"));

    for (const candidate of candidates) {
        if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
    }

    const cwdCandidates = [path.join(defaultCwd, "dist", "loader.js"), path.join(defaultCwd, "scripts", "dev-cli.js")];
    for (const candidate of cwdCandidates) {
        if (fs.existsSync(candidate)) return candidate;
    }

    for (const binName of ["lsd", "gsd"]) {
        try {
            const resolved = execFileSync("which", [binName], { encoding: "utf-8" }).trim();
            if (resolved) return resolved;
        } catch {
            /* ignore */
        }
    }

    return null;
}

function processSubagentEventLine(
    line: string,
    currentResult: LegacySingleResult,
    emitUpdate: () => void,
    proc: ChildProcess | undefined,
    onSessionInfo?: (info: { sessionFile?: string; parentSessionFile?: string }) => void,
    onEventType?: (eventType: string) => void,
    onParsedEvent?: (event: any) => void,
): boolean {
    if (!line.trim()) return false;
    let event: any;
    try {
        event = JSON.parse(line);
    } catch {
        return false;
    }

    const eventType = typeof event.type === "string" ? event.type : "unknown";
    onEventType?.(eventType);
    onParsedEvent?.(event);

    if (event.type === "subagent_session_info") {
        let changed = false;
        if (typeof event.sessionFile === "string" && event.sessionFile) {
            if (currentResult.sessionFile !== event.sessionFile) changed = true;
            currentResult.sessionFile = event.sessionFile;
        }
        if (typeof event.parentSessionFile === "string" && event.parentSessionFile) {
            if (currentResult.parentSessionFile !== event.parentSessionFile) changed = true;
            currentResult.parentSessionFile = event.parentSessionFile;
        }
        if (changed) {
            onSessionInfo?.({
                sessionFile: currentResult.sessionFile,
                parentSessionFile: currentResult.parentSessionFile,
            });
        }
        return false;
    }

    if (proc && isSubagentPermissionRequest(event)) {
        void handleSubagentPermissionRequest(event, proc);
        return false;
    }

    if ((event.type === "message_end" || event.type === "turn_end") && event.message) {
        const msg = event.message as Message;
        currentResult.messages.push(msg);

        if (msg.role === "assistant") {
            currentResult.usage.turns++;
            const usage = msg.usage;
            if (usage) {
                currentResult.usage.input += usage.input || 0;
                currentResult.usage.output += usage.output || 0;
                currentResult.usage.cacheRead += usage.cacheRead || 0;
                currentResult.usage.cacheWrite += usage.cacheWrite || 0;
                currentResult.usage.cost += usage.cost?.total || 0;
                currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            if (msg.model && (!currentResult.model || msg.model.includes("/"))) currentResult.model = msg.model;
            if (msg.stopReason) currentResult.stopReason = msg.stopReason;
            if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
        }
        emitUpdate();
    }

    if (event.type === "tool_result_end" && event.message) {
        currentResult.messages.push(event.message as Message);
        emitUpdate();
    }

    return event.type === "agent_end";
}

function writePromptToTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
    const safeName = agentName.replace(/[^\w.-]+/g, "_");
    const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
    fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
    return { dir: tmpDir, filePath };
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

export async function runLegacySingleAgent<TDetails>(
    defaultCwd: string,
    agents: AgentConfig[],
    agentName: string,
    task: string,
    cwd: string | undefined,
    step: number | undefined,
    modelOverride: string | undefined,
    parentModel: { provider: string; id: string } | undefined,
    signal: AbortSignal | undefined,
    onUpdate: LegacyOnUpdateCallback<TDetails> | undefined,
    makeDetails: (results: LegacySingleResult[]) => TDetails,
    parentSessionFile: string | undefined,
    attachableSession: boolean,
    onSessionInfo?: (info: { sessionFile?: string; parentSessionFile?: string }) => void,
    onSubagentEvent?: (event: any, currentResult: LegacySingleResult) => void,
    foregroundHooks?: ForegroundSingleRunHooks,
): Promise<LegacySingleResult> {
    const agent = agents.find((a) => a.name === agentName);

    if (!agent) {
        const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
        return {
            agent: agentName,
            agentSource: "unknown",
            task,
            exitCode: 1,
            messages: [],
            stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
            step,
        };
    }

    let tmpPromptDir: string | null = null;
    let tmpPromptPath: string | null = null;

    const preferences = loadEffectivePreferences()?.preferences;
    const settingsBudgetModel = readBudgetSubagentModelFromSettings();
    const resolvedModel = resolveConfiguredSubagentModel(agent, preferences, settingsBudgetModel);
    const inferredModel = resolveSubagentModel(
        { name: agent.name, model: resolvedModel },
        { overrideModel: modelOverride, parentModel },
    );

    const currentResult: LegacySingleResult = {
        agent: agentName,
        agentSource: agent.source,
        task,
        exitCode: 0,
        messages: [],
        stderr: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        model: inferredModel,
        step,
        parentSessionFile,
    };

    const emitUpdate = () => {
        if (onUpdate) {
            onUpdate({
                content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
                details: makeDetails([currentResult]),
            });
        }
    };

    let wasAborted = false;
    let deferTempPromptCleanup = false;
    let tempPromptCleanupDone = false;

    const cleanupTempPromptFiles = () => {
        if (tempPromptCleanupDone) return;
        tempPromptCleanupDone = true;
        if (tmpPromptPath)
            try {
                fs.unlinkSync(tmpPromptPath);
            } catch {
                /* ignore */
            }
        if (tmpPromptDir)
            try {
                fs.rmdirSync(tmpPromptDir);
            } catch {
                /* ignore */
            }
    };

    try {
        if (agent.systemPrompt.trim()) {
            const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
            tmpPromptDir = tmp.dir;
            tmpPromptPath = tmp.filePath;
        }
        const effectiveCwd = cwd ?? defaultCwd;
        const subagentSessionDir = parentSessionFile ? path.dirname(parentSessionFile) : undefined;
        const sessionFilesBefore = attachableSession && subagentSessionDir
            ? new Set(listSessionFiles(subagentSessionDir))
            : undefined;
        const launchStartedAt = Date.now();

        const args = buildSubagentProcessArgs(agent, task, tmpPromptPath, inferredModel, {
            noSession: !attachableSession,
            parentSessionFile: parentSessionFile,
            mode: attachableSession ? "rpc" : "json",
        });

        const exitCode = await new Promise<number>((resolve) => {
            const bundledPaths = getBundledExtensionPathsFromEnv();
            const extensionArgs = bundledPaths.flatMap((p) => ["--extension", p]);
            const cliPath = resolveSubagentCliPath(effectiveCwd);
            if (!cliPath) {
                currentResult.stderr += "Unable to resolve LSD/GSD CLI path for subagent launch.";
                resolve(1);
                return;
            }
            const proc = spawn(
                process.execPath,
                [cliPath, ...extensionArgs, ...args],
                { cwd: effectiveCwd, shell: false, stdio: ["pipe", "pipe", "pipe"] },
            );
            liveSubagentProcesses.add(proc);
            let buffer = "";
            let completionSeen = false;
            let resolved = false;
            let foregroundReleased = false;
            let isBusy = false;
            let commandSeq = 0;
            const pendingCommandResponses = new Map<string, { resolve: (data: any) => void; reject: (error: Error) => void }>();
            const procAbortController = new AbortController();
            let resolveBackgroundResult: ((value: BackgroundResultPayload) => void) | undefined;
            let rejectBackgroundResult: ((reason?: unknown) => void) | undefined;
            const backgroundResultPromise = new Promise<BackgroundResultPayload>((resolveBg, rejectBg) => {
                resolveBackgroundResult = resolveBg;
                rejectBackgroundResult = rejectBg;
            });

            const sendRpcCommand = async (command: Record<string, unknown>): Promise<any> => {
                const id = `sa_cmd_${++commandSeq}`;
                if (!proc.stdin) throw new Error("Subagent RPC stdin is not available.");
                return new Promise((resolveCmd, rejectCmd) => {
                    pendingCommandResponses.set(id, { resolve: resolveCmd, reject: rejectCmd });
                    proc.stdin!.write(JSON.stringify({ id, ...command }) + "\n");
                });
            };

            const finishForeground = (code: number) => {
                if (resolved) return;
                resolved = true;
                resolve(code);
            };

            const adoptToBackground = (jobId: string): boolean => {
                if (resolved || foregroundReleased) return false;
                foregroundReleased = true;
                deferTempPromptCleanup = true;
                currentResult.backgroundJobId = jobId;
                finishForeground(0);
                return true;
            };

            backgroundResultPromise.finally(() => {
                if (deferTempPromptCleanup) cleanupTempPromptFiles();
            });

            foregroundHooks?.onStart?.({
                agentName,
                task,
                cwd: cwd ?? defaultCwd,
                parentSessionFile,
                abortController: procAbortController,
                resultPromise: backgroundResultPromise,
                adoptToBackground,
                sendPrompt: attachableSession
                    ? async (text: string, images?: ImageContent[]) => {
                        await sendRpcCommand({ type: "prompt", message: text, images });
                    }
                    : undefined,
                sendSteer: attachableSession
                    ? async (text: string, images?: ImageContent[]) => {
                        await sendRpcCommand({ type: "steer", message: text, images });
                    }
                    : undefined,
                sendFollowUp: attachableSession
                    ? async (text: string, images?: ImageContent[]) => {
                        await sendRpcCommand({ type: "follow_up", message: text, images });
                    }
                    : undefined,
                isBusy: attachableSession ? () => isBusy : undefined,
            });

            proc.stdout.on("data", (data) => {
                buffer += data.toString();
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    if (attachableSession) {
                        try {
                            const parsed = JSON.parse(trimmed);
                            if (parsed?.type === "response" && typeof parsed.id === "string" && pendingCommandResponses.has(parsed.id)) {
                                const pending = pendingCommandResponses.get(parsed.id)!;
                                pendingCommandResponses.delete(parsed.id);
                                if (parsed.success === false) {
                                    pending.reject(new Error(typeof parsed.error === "string" ? parsed.error : "Subagent RPC command failed."));
                                } else {
                                    pending.resolve(parsed.data);
                                }
                                continue;
                            }
                        } catch {
                            // Fall through to generic event processing.
                        }
                    }

                    if (processSubagentEventLine(trimmed, currentResult, emitUpdate, proc, onSessionInfo, (eventType) => {
                        if (eventType === "agent_start") isBusy = true;
                        if (eventType === "agent_end") isBusy = false;
                    }, (event) => onSubagentEvent?.(event, currentResult))) {
                        completionSeen = true;
                        try {
                            proc.kill("SIGTERM");
                        } catch {
                            /* ignore */
                        }
                    }
                }
            });

            proc.stderr.on("data", (data) => {
                currentResult.stderr += data.toString();
            });

            proc.on("close", (code) => {
                liveSubagentProcesses.delete(proc);
                if (buffer.trim()) {
                    const completedOnFlush = processSubagentEventLine(buffer, currentResult, emitUpdate, proc, onSessionInfo, (eventType) => {
                        if (eventType === "agent_start") isBusy = true;
                        if (eventType === "agent_end") isBusy = false;
                    }, (event) => onSubagentEvent?.(event, currentResult));
                    completionSeen = completionSeen || completedOnFlush;
                }
                isBusy = false;
                for (const pending of pendingCommandResponses.values()) {
                    pending.reject(new Error("Subagent process closed before command response."));
                }
                pendingCommandResponses.clear();

                const finalExitCode = completionSeen && (code === null || code === 143 || code === 15) ? 0 : (code ?? 0);
                currentResult.exitCode = finalExitCode;

                if (attachableSession && sessionFilesBefore && subagentSessionDir && !currentResult.sessionFile) {
                    const detected = detectNewSubagentSessionFile(subagentSessionDir, sessionFilesBefore, launchStartedAt);
                    if (detected) currentResult.sessionFile = detected;
                }

                resolveBackgroundResult?.({
                    summary: getFinalOutput(currentResult.messages),
                    stderr: currentResult.stderr,
                    exitCode: finalExitCode,
                    model: currentResult.model,
                    sessionFile: currentResult.sessionFile,
                    parentSessionFile: currentResult.parentSessionFile,
                });
                foregroundHooks?.onFinish?.();
                finishForeground(finalExitCode);
            });

            proc.on("error", (error) => {
                liveSubagentProcesses.delete(proc);
                isBusy = false;
                for (const pending of pendingCommandResponses.values()) {
                    pending.reject(error instanceof Error ? error : new Error(String(error)));
                }
                pendingCommandResponses.clear();
                rejectBackgroundResult?.(error);
                foregroundHooks?.onFinish?.();
                finishForeground(1);
            });

            if (attachableSession) {
                void sendRpcCommand({ type: "prompt", message: task }).catch((error) => {
                    currentResult.stderr += error instanceof Error ? error.message : String(error);
                    try {
                        proc.kill("SIGTERM");
                    } catch {
                        /* ignore */
                    }
                });
            }

            const killProc = () => {
                wasAborted = true;
                procAbortController.abort();
                proc.kill("SIGTERM");
                setTimeout(() => {
                    if (!proc.killed) proc.kill("SIGKILL");
                }, 5000);
            };

            if (signal) {
                if (signal.aborted) killProc();
                else signal.addEventListener("abort", killProc, { once: true });
            }

            if (procAbortController.signal.aborted) {
                killProc();
            } else {
                procAbortController.signal.addEventListener("abort", () => {
                    proc.kill("SIGTERM");
                    setTimeout(() => {
                        if (!proc.killed) proc.kill("SIGKILL");
                    }, 5000);
                }, { once: true });
            }
        });

        currentResult.exitCode = exitCode;
        if (attachableSession && sessionFilesBefore && subagentSessionDir) {
            const detected = detectNewSubagentSessionFile(subagentSessionDir, sessionFilesBefore, launchStartedAt);
            if (detected) {
                currentResult.sessionFile = detected;
            }
        }
        if (wasAborted) throw new Error("Subagent was aborted");
        return currentResult;
    } finally {
        if (!deferTempPromptCleanup) cleanupTempPromptFiles();
    }
}
