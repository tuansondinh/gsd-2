import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import type { AutocompleteItem } from "@gsd/pi-tui";
import { handleRemote } from "./remote-command.js";
import { TelegramLiveRelay } from "./telegram-live-relay.js";

const REMOTE_ARGUMENTS: AutocompleteItem[] = [
    { value: "slack", label: "slack", description: "Connect remote questions to Slack" },
    { value: "discord", label: "discord", description: "Connect remote questions to Discord" },
    { value: "telegram", label: "telegram", description: "Connect remote questions to Telegram" },
    { value: "status", label: "status", description: "Show current remote questions status" },
    { value: "disconnect", label: "disconnect", description: "Disconnect the configured remote channel" },
];

function filterArgumentCompletions(prefix: string, items: AutocompleteItem[]): AutocompleteItem[] | null {
    const normalized = prefix.toLowerCase().replace(/\s+/g, " ").trimStart();
    const query = normalized.trimEnd();
    const filtered = items.filter((item) => item.value.startsWith(query));
    return filtered.length > 0 ? filtered : null;
}

export default function RemoteQuestionsExtension(pi: ExtensionAPI): void {
    const relay = new TelegramLiveRelay(pi);

    pi.on("message_start", (event) => relay.onMessageStart(event));
    pi.on("message_update", (event) => relay.onMessageUpdate(event));
    pi.on("message_end", (event) => relay.onMessageEnd(event));
    pi.on("tool_execution_start", (event) => relay.onToolExecutionStart({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.args }));
    pi.on("tool_execution_end", (event) => relay.onToolExecutionEnd({ toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, result: event.result }));
    pi.on("session_switch", async (event) => relay.onSessionSwitch(event));
    pi.on("session_fork", async (event) => relay.onSessionFork(event));
    pi.on("session_shutdown", async (event) => relay.onSessionShutdown(event));
    pi.on("session_before_compact", (event) => relay.onSessionBeforeCompact(event));

    pi.registerCommand("remote", {
        description: "Configure remote questions (Slack, Discord, Telegram)",
        getArgumentCompletions: (prefix: string) => filterArgumentCompletions(prefix, REMOTE_ARGUMENTS),
        handler: async (args: string, ctx) => {
            await handleRemote(args, ctx, pi);
        },
    });
}
