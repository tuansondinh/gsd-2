import { describe, it } from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";

import { handleAgentEvent } from "../chat-controller.js";
import { ToolSummaryLine } from "../../components/tool-summary-line.js";
import { getMarkdownTheme, initTheme } from "../../theme/theme.js";

initTheme("dark");

function assistantMessage(content: any[] = []): any {
    return {
        role: "assistant",
        content,
        timestamp: Date.now(),
    };
}

function toolStartEvent(toolCallId: string, toolName: string, args: Record<string, unknown> = {}): any {
    return {
        type: "tool_execution_start",
        toolCallId,
        toolName,
        args,
    };
}

function toolEndEvent(toolCallId: string, toolName: string): any {
    return {
        type: "tool_execution_end",
        toolCallId,
        toolName,
        isError: false,
        result: {
            content: [],
            details: {},
        },
    };
}

function createChatContainer() {
    return {
        children: [] as any[],
        addChild(child: any) {
            this.children.push(child);
        },
        removeChild(child: any) {
            this.children = this.children.filter((c) => c !== child);
        },
        clear() {
            this.children = [];
        },
    };
}

function createHost(options: { collapseToolCalls?: boolean; collapsedToolCallsExpanded?: boolean; toolOutputExpanded?: boolean } = {}): any {
    const chatContainer = createChatContainer();
    return {
        isInitialized: true,
        init: async () => { },
        ui: {
            requestRender: () => { },
            terminal: { write: () => { } },
        },
        footer: { invalidate: () => { } },
        statusContainer: { clear: () => { }, addChild: () => { } },
        chatContainer,
        settingsManager: {
            getTimestampFormat: () => "date-time-iso",
            getShowImages: () => true,
            getToolOutputMode: () => "normal",
            getEditorScheme: () => "auto",
            getCollapseToolCalls: () => options.collapseToolCalls ?? true,
        },
        pendingTools: new Map(),
        collapsedToolSummaryLine: undefined,
        collapsedToolCallsExpanded: options.collapsedToolCallsExpanded ?? options.toolOutputExpanded ?? false,
        toolOutputExpanded: options.toolOutputExpanded ?? false,
        hideThinkingBlock: false,
        notificationSoundEnabled: false,
        defaultEditor: { onEscape: undefined, bottomHint: "" },
        session: {
            thinkingLevel: "off",
            retryAttempt: 0,
            abortCompaction: () => { },
            abortRetry: () => { },
        },
        keybindings: {},
        pendingMessagesContainer: { clear: () => { } },
        compactionQueuedMessages: [],
        defaultWorkingMessage: "",
        workingMessages: [],
        startLoadingTips: () => { },
        stopLoadingTips: () => { },
        getMarkdownThemeWithSettings: () => getMarkdownTheme(),
        addMessageToChat: () => { },
        formatWebSearchResult: () => "",
        getRegisteredToolDefinition: () => undefined,
        checkShutdownRequested: async () => { },
        rebuildChatFromMessages: () => { },
        flushCompactionQueue: async () => { },
        showStatus: () => { },
        showError: () => { },
        updatePendingMessagesDisplay: () => { },
        updateTerminalTitle: () => { },
        updateEditorBorderColor: () => { },
        updateEditorExpandHint: () => { },
        getAgentPtyComponent: () => undefined,
        ensureAgentPtyComponent: () => undefined,
        updateAgentPtyComponent: () => { },
        clearAgentPtyComponents: () => { },
    };
}

function addPendingTool(host: any, toolCallId: string, elapsed: number): { hidden?: boolean; component: any } {
    const state: { hidden?: boolean; component: any } = { hidden: false, component: undefined };
    const component = {
        render: () => (state.hidden ? [] : ["tool"]),
        updateResult: () => { },
        setHidden: (hidden: boolean) => {
            state.hidden = hidden;
        },
        isHidden: () => !!state.hidden,
        setArgsComplete: () => { },
        getElapsed: () => elapsed,
    };
    state.component = component;
    host.chatContainer.addChild(component);
    host.pendingTools.set(toolCallId, component);
    return state;
}

function summaryLines(host: any): ToolSummaryLine[] {
    return host.chatContainer.children.filter((child: any) => child instanceof ToolSummaryLine);
}

describe("chat-controller collapsed tool summary lifecycle", () => {
    it("hides collapsible tool calls immediately to avoid blink before grouping", async () => {
        const host = createHost();

        await handleAgentEvent(host, {
            type: "message_start",
            message: assistantMessage(),
        });

        await handleAgentEvent(host, toolStartEvent("tool-1", "read", { path: "README.md" }));
        const pending = host.pendingTools.get("tool-1");
        assert.ok(pending);
        assert.equal(pending.isHidden(), true);

        await handleAgentEvent(host, toolEndEvent("tool-1", "read"));
        assert.equal(summaryLines(host).length, 1);
    });

    it("hides streamed tool-call blocks immediately to avoid blink before grouping", async () => {
        const host = createHost();

        await handleAgentEvent(host, {
            type: "message_start",
            message: assistantMessage(),
        });

        await handleAgentEvent(host, {
            type: "message_update",
            message: assistantMessage([
                { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
            ]),
        } as any);

        const pending = host.pendingTools.get("tool-1");
        assert.ok(pending);
        assert.equal(pending.isHidden(), true);

        await handleAgentEvent(host, toolEndEvent("tool-1", "read"));
        assert.equal(summaryLines(host).length, 1);
    });

    it("reveals initially hidden on-error tools when they fail", async () => {
        const host = createHost();

        await handleAgentEvent(host, {
            type: "message_start",
            message: assistantMessage(),
        });

        await handleAgentEvent(host, toolStartEvent("tool-1", "bash", { command: "exit 1" }));
        const pending = host.pendingTools.get("tool-1");
        assert.ok(pending);
        assert.equal(pending.isHidden(), true);

        await handleAgentEvent(host, {
            type: "tool_execution_end",
            toolCallId: "tool-1",
            toolName: "bash",
            isError: true,
            result: {
                content: [{ type: "text", text: "failed" }],
                details: {},
            },
        });

        assert.equal(summaryLines(host).length, 0);
        assert.equal(pending.isHidden(), false);
    });

    it("groups consecutive identical collapsed tools", async () => {
        const host = createHost();

        await handleAgentEvent(host, {
            type: "message_start",
            message: assistantMessage(),
        });

        const first = addPendingTool(host, "tool-1", 400);
        await handleAgentEvent(host, toolEndEvent("tool-1", "read"));
        assert.equal(host.chatContainer.children.indexOf(summaryLines(host)[0]), host.chatContainer.children.indexOf(first.component) - 1);

        await handleAgentEvent(host, {
            type: "message_update",
            message: assistantMessage([{ type: "text", text: "streaming text" }]),
        } as any);

        addPendingTool(host, "tool-2", 600);
        await handleAgentEvent(host, toolEndEvent("tool-2", "read"));

        const summaries = summaryLines(host);
        assert.equal(summaries.length, 1);
        assert.ok(stripAnsi(summaries[0].render(160).join("\n")).includes("reading 2 files · 1.0s"));
    });

    it("does not group web fetches", async () => {
        const host = createHost();

        await handleAgentEvent(host, {
            type: "message_start",
            message: assistantMessage(),
        });

        addPendingTool(host, "tool-1", 200);
        await handleAgentEvent(host, toolEndEvent("tool-1", "fetch_page"));

        addPendingTool(host, "tool-2", 300);
        await handleAgentEvent(host, toolEndEvent("tool-2", "fetch_page"));

        const summaries = summaryLines(host);
        assert.equal(summaries.length, 2);
        assert.ok(stripAnsi(summaries[0].render(160).join("\n")).includes("reading 1 page · 0.2s"));
        assert.ok(stripAnsi(summaries[1].render(160).join("\n")).includes("reading 1 page · 0.3s"));
    });

    it("keeps different collapsed tool types in separate summaries", async () => {
        const host = createHost();

        await handleAgentEvent(host, {
            type: "message_start",
            message: assistantMessage(),
        });

        addPendingTool(host, "tool-1", 200);
        await handleAgentEvent(host, toolEndEvent("tool-1", "read"));

        addPendingTool(host, "tool-2", 300);
        await handleAgentEvent(host, toolEndEvent("tool-2", "find"));

        const summaries = summaryLines(host);
        assert.equal(summaries.length, 2);
        assert.ok(stripAnsi(summaries[0].render(160).join("\n")).includes("reading 1 file · 0.2s"));
        assert.ok(stripAnsi(summaries[1].render(160).join("\n")).includes("finding 1 path · 0.3s"));
    });

    it("resets grouping after visible tool result", async () => {
        const host = createHost();

        await handleAgentEvent(host, {
            type: "message_start",
            message: assistantMessage(),
        });

        addPendingTool(host, "tool-1", 200);
        await handleAgentEvent(host, toolEndEvent("tool-1", "read"));

        const visibleTool = addPendingTool(host, "tool-2", 300);
        await handleAgentEvent(host, toolEndEvent("tool-2", "write"));
        assert.equal(visibleTool.hidden, false);

        addPendingTool(host, "tool-3", 400);
        await handleAgentEvent(host, toolEndEvent("tool-3", "read"));

        const summaries = summaryLines(host);
        assert.equal(summaries.length, 2);
        assert.ok(stripAnsi(summaries[0].render(160).join("\n")).includes("0.2s"));
        assert.ok(stripAnsi(summaries[1].render(160).join("\n")).includes("0.4s"));
    });

    it("groups identical collapsed tools across empty assistant message boundaries", async () => {
        const host = createHost();

        await handleAgentEvent(host, {
            type: "message_start",
            message: assistantMessage(),
        });

        addPendingTool(host, "tool-1", 300);
        await handleAgentEvent(host, toolEndEvent("tool-1", "read"));

        await handleAgentEvent(host, {
            type: "message_start",
            message: assistantMessage(),
        });

        addPendingTool(host, "tool-2", 400);
        await handleAgentEvent(host, toolEndEvent("tool-2", "read"));

        const summaries = summaryLines(host);
        assert.equal(summaries.length, 1);
        assert.ok(stripAnsi(summaries[0].render(160).join("\n")).includes("reading 2 files · 0.7s"));
    });

    it("starts new collapsed group after visible assistant content", async () => {
        const host = createHost();

        await handleAgentEvent(host, {
            type: "message_start",
            message: assistantMessage(),
        });

        addPendingTool(host, "tool-1", 300);
        await handleAgentEvent(host, toolEndEvent("tool-1", "read"));

        await handleAgentEvent(host, {
            type: "message_start",
            message: assistantMessage(),
        });
        await handleAgentEvent(host, {
            type: "message_update",
            message: assistantMessage([{ type: "text", text: "visible reply" }]),
        } as any);

        addPendingTool(host, "tool-2", 400);
        await handleAgentEvent(host, toolEndEvent("tool-2", "read"));

        const summaries = summaryLines(host);
        assert.equal(summaries.length, 2);
        assert.ok(stripAnsi(summaries[0].render(160).join("\n")).includes("0.3s"));
        assert.ok(stripAnsi(summaries[1].render(160).join("\n")).includes("0.4s"));
    });

    it("keeps collapsed tool calls visible in intermediate mode", async () => {
        const host = createHost({ collapseToolCalls: true, collapsedToolCallsExpanded: true });

        await handleAgentEvent(host, {
            type: "message_start",
            message: assistantMessage(),
        });

        const tool = addPendingTool(host, "tool-1", 250);
        await handleAgentEvent(host, toolEndEvent("tool-1", "read"));

        const summaries = summaryLines(host);
        assert.equal(tool.hidden, false);
        assert.equal(summaries.length, 1);
        assert.deepEqual(summaries[0].render(160), []);
    });

    it("keeps collapsed tools visible when verbose mode is active", async () => {
        const host = createHost({ collapseToolCalls: true, toolOutputExpanded: true });

        await handleAgentEvent(host, {
            type: "message_start",
            message: assistantMessage(),
        });

        const tool = addPendingTool(host, "tool-1", 250);
        await handleAgentEvent(host, toolEndEvent("tool-1", "read"));

        const summaries = summaryLines(host);
        assert.equal(tool.hidden, false);
        assert.equal(summaries.length, 1);
        assert.deepEqual(summaries[0].render(160), []);
    });

    it("does not collapse tool calls when setting is disabled", async () => {
        const host = createHost({ collapseToolCalls: false });

        await handleAgentEvent(host, {
            type: "message_start",
            message: assistantMessage(),
        });

        const tool = addPendingTool(host, "tool-1", 250);
        await handleAgentEvent(host, toolEndEvent("tool-1", "read"));

        assert.equal(tool.hidden, false);
        assert.equal(summaryLines(host).length, 0);
    });
});
