import type { AgentToolResult } from "@gsd/pi-agent-core";
import type { ImageContent, Message } from "@gsd/pi-ai";
import { createAgentSession, getAgentDir, SessionManager } from "@gsd/pi-coding-agent";
import type { AgentConfig } from "./agents.js";
import { resolveConfiguredSubagentModel } from "./configured-model.js";
import { resolveSubagentModel } from "./model-resolution.js";
import { readBudgetSubagentModelFromSettings } from "./legacy-runner.js";
import { loadEffectivePreferences } from "../shared/preferences.js";

const MAX_AGENT_DURATION_MS = 30 * 60 * 1000;
export const MAX_IN_PROCESS_SUBAGENT_DEPTH = 3;

export interface InProcessUsageStats {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens: number;
    turns: number;
}

export interface InProcessSingleResult {
    agent: string;
    agentSource: "bundled" | "user" | "project" | "unknown";
    task: string;
    exitCode: number;
    messages: Message[];
    stderr: string;
    usage: InProcessUsageStats;
    model?: string;
    stopReason?: string;
    errorMessage?: string;
    step?: number;
    backgroundJobId?: string;
    sessionFile?: string;
    parentSessionFile?: string;
}

export interface SubagentHandle {
    result: Promise<InProcessSingleResult>;
    sessionId?: string;
    isBusy: () => boolean;
    prompt: (message: string, images?: ImageContent[]) => Promise<void>;
    steer: (message: string, images?: ImageContent[]) => Promise<void>;
    followUp: (message: string, images?: ImageContent[]) => Promise<void>;
    abort: () => void;
    dispose: () => void;
}

export interface StartedInProcessSingleRun {
    handle: SubagentHandle;
    currentResult: InProcessSingleResult;
    resultPromise: Promise<InProcessSingleResult>;
}

export type InProcessOnUpdateCallback<TDetails> = (partial: AgentToolResult<TDetails>) => void;

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

function toErrorString(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function createUnknownAgentResult(
    agents: AgentConfig[],
    agentName: string,
    task: string,
    step: number | undefined,
    parentSessionFile: string | undefined,
): InProcessSingleResult {
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
        parentSessionFile,
    };
}

function createResolvedHandle(result: InProcessSingleResult): StartedInProcessSingleRun {
    const resultPromise = Promise.resolve(result);
    const handle: SubagentHandle = {
        result: resultPromise,
        isBusy: () => false,
        prompt: async () => undefined,
        steer: async () => undefined,
        followUp: async () => undefined,
        abort: () => undefined,
        dispose: () => undefined,
    };
    return { handle, currentResult: result, resultPromise };
}

export async function startInProcessSingleAgent<TDetails>(
    defaultCwd: string,
    agents: AgentConfig[],
    agentName: string,
    task: string,
    cwd: string | undefined,
    step: number | undefined,
    modelOverride: string | undefined,
    parentModel: { provider: string; id: string } | undefined,
    signal: AbortSignal | undefined,
    onUpdate: InProcessOnUpdateCallback<TDetails> | undefined,
    makeDetails: (results: InProcessSingleResult[]) => TDetails,
    parentSessionFile: string | undefined,
    depth: number | undefined,
    onSubagentEvent?: (event: any, currentResult: InProcessSingleResult) => void,
): Promise<StartedInProcessSingleRun> {
    const agent = agents.find((candidate) => candidate.name === agentName);
    if (!agent) {
        return createResolvedHandle(createUnknownAgentResult(agents, agentName, task, step, parentSessionFile));
    }

    const nestingDepth = depth ?? 1;
    if (nestingDepth > MAX_IN_PROCESS_SUBAGENT_DEPTH) {
        return createResolvedHandle({
            agent: agentName,
            agentSource: agent.source,
            task,
            exitCode: 1,
            messages: [],
            stderr: `Max subagent depth (${MAX_IN_PROCESS_SUBAGENT_DEPTH}) exceeded.`,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
            step,
            parentSessionFile,
        });
    }

    const preferences = loadEffectivePreferences()?.preferences;
    const settingsBudgetModel = readBudgetSubagentModelFromSettings();
    const resolvedModel = resolveConfiguredSubagentModel(agent, preferences, settingsBudgetModel);
    const inferredModel = resolveSubagentModel(
        { name: agent.name, model: resolvedModel },
        { overrideModel: modelOverride, parentModel },
    );

    const currentResult: InProcessSingleResult = {
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
        if (!onUpdate) return;
        onUpdate({
            content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
            details: makeDetails([currentResult]),
        });
    };

    const effectiveCwd = cwd ?? defaultCwd;
    const sessionManager = SessionManager.inMemory(effectiveCwd);
    const { session } = await createAgentSession({
        cwd: effectiveCwd,
        agentDir: getAgentDir(),
        sessionManager,
    });

    if (inferredModel) {
        const [provider, modelId] = inferredModel.split("/");
        if (provider && modelId) {
            const model = session.modelRegistry.find(provider, modelId);
            if (!model) {
                session.dispose();
                currentResult.exitCode = 1;
                currentResult.stderr = `Unable to resolve model ${inferredModel} for in-process subagent.`;
                return createResolvedHandle(currentResult);
            }
            await session.setModel(model);
            currentResult.model = `${model.provider}/${model.id}`;
        }
    }

    if (agent.tools && agent.tools.length > 0) {
        session.setActiveToolsByName(agent.tools);
    }

    const antiRecursionPrompt = [
        `You are already the ${agentName} subagent for this session.`,
        "Do not spawn or delegate to another subagent with the same name as yourself.",
        `If the user asks you to continue ${agentName} work, do that work directly in this session.`,
        `Original delegated task: ${task}`,
        `Current subagent depth: ${nestingDepth}/${MAX_IN_PROCESS_SUBAGENT_DEPTH}.`,
    ].join("\n");
    const appendedParts = [antiRecursionPrompt, agent.systemPrompt.trim()].filter((part) => part.length > 0);
    if (appendedParts.length > 0) {
        const appendedPrompt = `${session.systemPrompt}\n\n${appendedParts.join("\n\n")}`;
        session.agent.setSystemPrompt(appendedPrompt);
    }

    let completed = false;
    let disposed = false;
    const unsubscribe = session.subscribe((event: any) => {
        onSubagentEvent?.(event, currentResult);

        if (event?.type !== "message_end" || !event.message) return;
        const message = event.message as Message;
        currentResult.messages.push(message);

        if (message.role === "assistant") {
            currentResult.usage.turns++;
            const usage = message.usage;
            if (usage) {
                currentResult.usage.input += usage.input || 0;
                currentResult.usage.output += usage.output || 0;
                currentResult.usage.cacheRead += usage.cacheRead || 0;
                currentResult.usage.cacheWrite += usage.cacheWrite || 0;
                currentResult.usage.cost += usage.cost?.total || 0;
                currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            if (message.model) currentResult.model = message.model;
            if (message.stopReason) currentResult.stopReason = message.stopReason;
            if (message.errorMessage) currentResult.errorMessage = message.errorMessage;
        }

        emitUpdate();
    });

    const dispose = () => {
        if (disposed) return;
        disposed = true;
        unsubscribe();
        session.dispose();
    };

    const handle: SubagentHandle = {
        result: Promise.resolve(currentResult),
        sessionId: session.sessionId,
        isBusy: () => session.isStreaming,
        prompt: (message: string, images?: ImageContent[]) => session.prompt(message, { images }),
        steer: (message: string, images?: ImageContent[]) => session.steer(message, images),
        followUp: (message: string, images?: ImageContent[]) => session.followUp(message, images),
        abort: () => {
            void session.abort();
        },
        dispose,
    };

    const timeoutPromise = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
            handle.abort();
            reject(new Error(`In-process subagent timed out after ${MAX_AGENT_DURATION_MS}ms.`));
        }, MAX_AGENT_DURATION_MS);
        if (typeof timer === "object" && "unref" in timer) timer.unref();
    });

    const runPromise = (async () => {
        if (signal?.aborted) {
            handle.abort();
            throw new Error("Subagent was aborted");
        }

        const onAbort = () => handle.abort();
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
            await session.prompt(task);
            completed = true;
        } finally {
            signal?.removeEventListener("abort", onAbort);
        }
    })();

    const resultPromise = (async () => {
        try {
            await Promise.race([runPromise, timeoutPromise]);
        } catch (error) {
            currentResult.exitCode = 1;
            currentResult.stderr = toErrorString(error);
            if (signal?.aborted) currentResult.stopReason = "aborted";
        } finally {
            if (!completed && signal?.aborted) {
                currentResult.stopReason = "aborted";
            }
            dispose();
        }
        return currentResult;
    })();

    handle.result = resultPromise;

    return {
        handle,
        currentResult,
        resultPromise,
    };
}

export async function runInProcessSingleAgent<TDetails>(
    defaultCwd: string,
    agents: AgentConfig[],
    agentName: string,
    task: string,
    cwd: string | undefined,
    step: number | undefined,
    modelOverride: string | undefined,
    parentModel: { provider: string; id: string } | undefined,
    signal: AbortSignal | undefined,
    onUpdate: InProcessOnUpdateCallback<TDetails> | undefined,
    makeDetails: (results: InProcessSingleResult[]) => TDetails,
    parentSessionFile: string | undefined,
    depth: number | undefined,
    onSubagentEvent?: (event: any, currentResult: InProcessSingleResult) => void,
): Promise<InProcessSingleResult> {
    const started = await startInProcessSingleAgent(
        defaultCwd,
        agents,
        agentName,
        task,
        cwd,
        step,
        modelOverride,
        parentModel,
        signal,
        onUpdate,
        makeDetails,
        parentSessionFile,
        depth,
        onSubagentEvent,
    );
    return started.resultPromise;
}
