import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@gsd/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { resolveRemoteConfig } from "./config.js";
import { apiRequest } from "./http-client.js";
import { telegramPullUpdates, telegramSyncLatestUpdateId, telegramMarkConsumerSeen } from "./telegram-update-stream.js";

const TELEGRAM_API = "https://api.telegram.org";
const TOOL_FLUSH_MS = 2000;
const TELEGRAM_MESSAGE_LIMIT = 4000;

interface RelayState {
  connected: boolean;
  channel: "telegram";
  chatId: string;
  lastUpdateId: number;
  connectedAt: number;
  sessionKey: string;
  nonce?: string;
  awaitingHandshake?: boolean;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id?: number;
    date?: number;
    text?: string;
    chat?: { id?: number | string; type?: string };
    from?: { id?: number | string; is_bot?: boolean; username?: string };
  };
}

export class TelegramLiveRelay {
  private readonly pi: ExtensionAPI;
  private state: RelayState | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private isPolling = false;
  private shuttingDown = false;
  private botUserId: number | null = null;
  private toolBuffer: string[] = [];
  private toolFlushTimer: NodeJS.Timeout | null = null;
  private readonly consumerId: string;
  private readonly recentInboundFingerprints = new Map<string, number>();

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    this.consumerId = `telegram-live:${randomUUID()}`;
    this.state = this.readState();
  }

  async connect(ctx: ExtensionCommandContext): Promise<void> {
    const config = resolveRemoteConfig();
    if (!config || config.channel !== "telegram") {
      ctx.ui.notify("Telegram is not configured. Run /lsd remote telegram first.", "warning");
      return;
    }

    try {
      const me = await this.telegramApi(config.token, "getMe");
      if (!me?.ok || !me?.result?.id) {
        ctx.ui.notify("Telegram bot validation failed. Re-run /lsd remote telegram.", "error");
        return;
      }
      this.botUserId = me.result.id;

      const baseline = await telegramSyncLatestUpdateId(config.token, ["message"]);
      telegramMarkConsumerSeen(config.token, this.consumerId, baseline);
      const nonce = randomUUID().slice(0, 6).toUpperCase();
      this.state = {
        connected: false,
        awaitingHandshake: true,
        nonce,
        channel: "telegram",
        chatId: config.channelId,
        lastUpdateId: baseline,
        connectedAt: Date.now(),
        sessionKey: sessionKey(),
      };
      this.writeState();
      this.startPollingLoop();
      ctx.ui.notify(`Telegram relay handshake started for chat ${config.channelId}. Confirm in Telegram with /bind ${nonce}.`, "success");
      await this.safeSendTelegram([
        "🔐 LSD live relay handshake",
        "",
        `Reply with: /bind ${nonce}`,
        "",
        "Only this bound chat can control the current LSD session.",
      ].join("\n"), true);
      this.setStatus();
    } catch (err) {
      ctx.ui.notify(`Telegram live relay connect failed: ${this.errorMessage(err)}`, "error");
    }
  }

  async disconnect(ctx?: ExtensionCommandContext, reason?: string): Promise<void> {
    const wasConnected = !!this.state?.connected;
    this.stopPollingLoop();
    this.flushToolBuffer();
    if (wasConnected) {
      const message = reason ? `Telegram live relay disconnected: ${reason}` : "Telegram live relay disconnected.";
      ctx?.ui.notify(message, "info");
      if (!this.shuttingDown) {
        await this.safeSendTelegram(`🔌 ${message}`);
      }
    }
    this.state = null;
    this.writeState();
    this.setStatus();
  }

  async status(ctx: ExtensionCommandContext): Promise<void> {
    if (this.state) {
      await this.pollOnce();
      await this.tryDirectHandshakeCatchup();
    }
    if (!this.state) {
      ctx.ui.notify("Telegram live relay: disconnected. Use /lsd telegram connect.", "info");
      return;
    }
    const since = new Date(this.state.connectedAt).toLocaleString();
    ctx.ui.notify([
      `Telegram live relay: ${this.state.connected ? "connected" : this.state.awaitingHandshake ? "awaiting handshake" : "disconnected"}`,
      `  chat: ${this.state.chatId}`,
      `  connected: ${since}`,
      `  last_update_id: ${this.state.lastUpdateId}`,
      ...(this.state.awaitingHandshake && this.state.nonce ? [`  nonce: ${this.state.nonce}`] : []),
    ].join("\n"), "info");
  }

  async handleLsdTelegram(args: string, ctx: ExtensionCommandContext): Promise<boolean> {
    const trimmed = args.trim();
    if (!trimmed.startsWith("telegram")) return false;
    const sub = trimmed.replace(/^telegram\s*/, "").trim();
    if (sub === "" || sub === "help") {
      ctx.ui.notify([
        "Telegram live relay:",
        "  /lsd telegram connect",
        "  /lsd telegram status",
        "  /lsd telegram disconnect",
      ].join("\n"), "info");
      return true;
    }
    if (sub === "connect") {
      await this.connect(ctx);
      return true;
    }
    if (sub === "status") {
      await this.status(ctx);
      return true;
    }
    if (sub === "disconnect") {
      await this.disconnect(ctx);
      return true;
    }
    ctx.ui.notify(`Unknown /lsd telegram subcommand: ${sub}`, "warning");
    return true;
  }

  onMessageEnd(event: { message?: { role?: string; content?: unknown } }): void {
    if (!this.state?.connected) return;
    if (event.message?.role !== "assistant") return;
    const text = extractText(event.message.content);
    if (!text.trim()) return;
    if (this.wasRecentlyReceivedFromTelegram(text)) return;
    void this.safeSendTelegramChunks(text);
  }

  onToolExecutionStart(event: { toolName: string }): void {
    if (!this.state?.connected) return;
    this.bufferToolEvent(`🔧 ${event.toolName} started`);
  }

  onToolExecutionEnd(event: { toolName: string; isError: boolean }): void {
    if (!this.state?.connected) return;
    const status = event.isError ? "❌" : "✅";
    this.bufferToolEvent(`${status} ${event.toolName} finished`);
  }

  async onSessionSwitch(_event: unknown): Promise<void> {
    if (!this.state?.connected) return;
    await this.disconnect(undefined, "session switched");
  }

  async onSessionFork(_event: unknown): Promise<void> {
    if (!this.state?.connected) return;
    await this.disconnect(undefined, "session forked");
  }

  async onSessionShutdown(_event: unknown): Promise<void> {
    this.shuttingDown = true;
    if (!this.state?.connected) return;
    await this.disconnect(undefined, "session shutdown");
  }

  onSessionBeforeCompact(_event: unknown): void {
    if (!this.state?.connected) return;
    void this.safeSendTelegram("🗜️ LSD is compacting context. Relay stays connected.");
  }

  private setStatus(): void {
    this.pi.sendMessage({
      customType: "telegram_live_relay_status",
      content: this.state
        ? this.state.connected
          ? `Telegram live relay connected (${this.state.chatId})`
          : this.state.awaitingHandshake
            ? `Telegram live relay awaiting handshake (${this.state.chatId})`
            : "Telegram live relay disconnected"
        : "Telegram live relay disconnected",
      display: false,
      details: this.state
        ? {
            connected: this.state.connected,
            awaitingHandshake: !!this.state.awaitingHandshake,
            chatId: this.state.chatId,
            sessionKey: this.state.sessionKey,
          }
        : { connected: false },
    });
  }

  private startPollingLoop(): void {
    this.stopPollingLoop();
    const tick = async () => {
      if (this.isPolling || !this.state) return;
      this.isPolling = true;
      try {
        await this.pollOnce();
      } finally {
        this.isPolling = false;
        if (this.state) this.pollTimer = setTimeout(tick, 1500);
      }
    };
    this.pollTimer = setTimeout(tick, 250);
  }

  private stopPollingLoop(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private async pollOnce(): Promise<void> {
    const config = resolveRemoteConfig();
    if (!config || config.channel !== "telegram" || !this.state) return;

    try {
      const updates = await telegramPullUpdates(config.token, this.consumerId, ["message"]);
      for (const update of updates) {
        if (typeof update.update_id === "number" && update.update_id > this.state.lastUpdateId) {
          this.state.lastUpdateId = update.update_id;
        }
        await this.handleUpdate(update);
      }
      this.writeState();
    } catch {
      // keep trying on next tick
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (!this.state || !update.message?.text) return;
    const msg = update.message;
    if (String(msg.chat?.id ?? "") !== this.state.chatId) return;
    if (msg.from?.is_bot) return;

    const textRaw = msg.text ?? "";
    const text = textRaw.trim();
    if (!text) return;

    if (this.state.awaitingHandshake && this.state.nonce) {
      if (text === `/bind ${this.state.nonce}`) {
        this.state.connected = true;
        this.state.awaitingHandshake = false;
        delete this.state.nonce;
        this.writeState();
        this.setStatus();
        await this.safeSendTelegram("🔗 LSD live relay connected. Send messages here to continue this session.", true);
      } else {
        await this.safeSendTelegram(`🔐 Handshake pending. Reply with /bind ${this.state.nonce}`, true);
      }
      return;
    }

    if (!this.state.connected) return;

    if (text === "/disconnect") {
      await this.safeSendTelegram("🔌 Disconnecting live relay.", true);
      await this.disconnect(undefined, "requested from Telegram");
      return;
    }
    if (text === "/status") {
      await this.safeSendTelegram(`✅ Live relay connected. Chat ${this.state.chatId}.`, true);
      return;
    }
    if (text === "/help") {
      await this.safeSendTelegram("Commands: /status, /disconnect. Any other text is forwarded to LSD.", true);
      return;
    }

    this.rememberInboundText(text);
    await this.safeSendTelegram("📨 Message queued for LSD.", true);
    this.pi.sendUserMessage(text, { deliverAs: "followUp" });
  }

  private bufferToolEvent(line: string): void {
    this.toolBuffer.push(line);
    if (this.toolFlushTimer) return;
    this.toolFlushTimer = setTimeout(() => this.flushToolBuffer(), TOOL_FLUSH_MS);
  }

  private flushToolBuffer(): void {
    if (this.toolFlushTimer) clearTimeout(this.toolFlushTimer);
    this.toolFlushTimer = null;
    if (this.toolBuffer.length === 0) return;
    const lines = [...this.toolBuffer];
    this.toolBuffer = [];
    void this.safeSendTelegram(lines.slice(0, 12).join("\n"));
  }

  private async tryDirectHandshakeCatchup(): Promise<void> {
    if (!this.state?.awaitingHandshake || !this.state.nonce) return;
    const config = resolveRemoteConfig();
    if (!config || config.channel !== "telegram") return;

    try {
      const res = await this.telegramApi(config.token, "getUpdates", {
        timeout: 0,
        allowed_updates: ["message"],
      });
      if (!res?.ok || !Array.isArray(res.result)) return;

      const match = (res.result as TelegramUpdate[]).find((update) => {
        const text = update.message?.text?.trim();
        const chatId = String(update.message?.chat?.id ?? "");
        return chatId === this.state?.chatId && text === `/bind ${this.state?.nonce}`;
      });

      if (!match) return;

      this.state.connected = true;
      this.state.awaitingHandshake = false;
      if (typeof match.update_id === "number" && match.update_id > this.state.lastUpdateId) {
        this.state.lastUpdateId = match.update_id;
      }
      telegramMarkConsumerSeen(config.token, this.consumerId, this.state.lastUpdateId);
      delete this.state.nonce;
      this.writeState();
      this.setStatus();
      await this.safeSendTelegram("🔗 LSD live relay connected. Send messages here to continue this session.", true);
    } catch {
      // best effort
    }
  }

  private async safeSendTelegram(text: string, allowDuringHandshake = false): Promise<void> {
    const config = resolveRemoteConfig();
    if (!config || config.channel !== "telegram" || !this.state) return;
    if (!allowDuringHandshake && !this.state.connected) return;
    try {
      await this.telegramApi(config.token, "sendMessage", {
        chat_id: this.state.chatId,
        text,
      });
    } catch {
      // best effort
    }
  }

  private async safeSendTelegramChunks(text: string): Promise<void> {
    const chunks = chunkText(text, TELEGRAM_MESSAGE_LIMIT);
    for (let i = 0; i < chunks.length; i++) {
      const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n` : "";
      await this.safeSendTelegram(prefix + chunks[i]);
    }
  }

  private rememberInboundText(text: string): void {
    const now = Date.now();
    this.recentInboundFingerprints.set(fingerprint(text), now);
    for (const [key, ts] of this.recentInboundFingerprints) {
      if (now - ts > 2 * 60 * 1000) this.recentInboundFingerprints.delete(key);
    }
  }

  private wasRecentlyReceivedFromTelegram(text: string): boolean {
    const key = fingerprint(text);
    const ts = this.recentInboundFingerprints.get(key);
    if (!ts) return false;
    if (Date.now() - ts > 2 * 60 * 1000) {
      this.recentInboundFingerprints.delete(key);
      return false;
    }
    return true;
  }

  private async telegramApi(token: string, method: string, params?: Record<string, unknown>): Promise<any> {
    return apiRequest(`${TELEGRAM_API}/bot${token}/${method}`, "POST", params, { errorLabel: "Telegram API" });
  }

  private readState(): RelayState | null {
    const path = relayStatePath();
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as RelayState;
    } catch {
      return null;
    }
  }

  private writeState(): void {
    const path = relayStatePath();
    mkdirSync(dirname(path), { recursive: true });
    if (!this.state) {
      try { writeFileSync(path, "null\n", "utf-8"); } catch { /* ignore */ }
      return;
    }
    try {
      writeFileSync(path, JSON.stringify(this.state, null, 2) + "\n", "utf-8");
    } catch {
      // ignore
    }
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}

function relayStatePath(): string {
  return join(process.env.LSD_HOME || join(homedir(), ".lsd"), "runtime", "relay", sessionKey(), "telegram-live.json");
}

function sessionKey(): string {
  return createHash("sha256").update(process.cwd()).digest("hex").slice(0, 12);
}

function fingerprint(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text?: string } => typeof part === "object" && part !== null && "type" in part)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("");
}

function chunkText(text: string, limit: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n\n", limit);
    if (splitAt < Math.floor(limit * 0.5)) splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < Math.floor(limit * 0.5)) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
}
