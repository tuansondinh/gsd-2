import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { handleRemote } from "./remote-command.js";
import { TelegramLiveRelay } from "./telegram-live-relay.js";

function showLsdUsage(ctx: ExtensionCommandContext): void {
  ctx.ui.notify(
    [
      "LSD remote questions:",
      "  /lsd remote",
      "  /lsd remote slack",
      "  /lsd remote discord",
      "  /lsd remote telegram",
      "  /lsd remote status",
      "  /lsd remote disconnect",
      "",
      "Telegram live relay:",
      "  /lsd telegram connect",
      "  /lsd telegram status",
      "  /lsd telegram disconnect",
    ].join("\n"),
    "info",
  );
}

export default function RemoteQuestionsExtension(pi: ExtensionAPI): void {
  const relay = new TelegramLiveRelay(pi);

  pi.on("message_end", (event) => relay.onMessageEnd(event));
  pi.on("tool_execution_start", (event) => relay.onToolExecutionStart(event));
  pi.on("tool_execution_end", (event) => relay.onToolExecutionEnd(event));
  pi.on("session_switch", async (event) => relay.onSessionSwitch(event));
  pi.on("session_fork", async (event) => relay.onSessionFork(event));
  pi.on("session_shutdown", async (event) => relay.onSessionShutdown(event));
  pi.on("session_before_compact", (event) => relay.onSessionBeforeCompact(event));

  pi.registerCommand("remote", {
    description: "Configure remote questions (Slack, Discord, Telegram)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await handleRemote(args, ctx, pi);
    },
  });

  pi.registerCommand("lsd", {
    description: "LSD command alias for remote questions",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      if (trimmed === "" || trimmed === "help") {
        showLsdUsage(ctx);
        return;
      }

      if (await relay.handleLsdTelegram(trimmed, ctx)) {
        return;
      }

      if (trimmed === "remote" || trimmed.startsWith("remote ")) {
        await handleRemote(trimmed.replace(/^remote\s*/, "").trim(), ctx, pi);
        return;
      }

      ctx.ui.notify(`Unknown /lsd subcommand: ${trimmed}`, "warning");
      showLsdUsage(ctx);
    },
  });
}
