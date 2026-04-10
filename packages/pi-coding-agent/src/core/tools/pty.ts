import { randomUUID } from "node:crypto";
import type { AgentTool } from "@gsd/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { executeBashInPty, type PtyExecutionSession } from "../pty-executor.js";
import {
	createHeadlessTerminal,
	snapshotTerminalBufferText,
	snapshotTerminalViewportText,
	type HeadlessTerminal,
} from "../../utils/terminal-screen.js";

const ptyStartSchema = Type.Object({
	command: Type.String({ description: "Shell command to start inside the PTY" }),
	cols: Type.Optional(Type.Number({ description: "Terminal width in columns (default 80)" })),
	rows: Type.Optional(Type.Number({ description: "Terminal height in rows (default 24)" })),
	loginShell: Type.Optional(Type.Boolean({ description: "Whether to run the command in a login shell" })),
});

const ptySendSchema = Type.Object({
	sessionId: Type.String({ description: "PTY session id from pty_start" }),
	input: Type.String({ description: "Text or control sequence to send, e.g. \"y\\r\" or \"\\u001b[A\"" }),
});

const ptyReadSchema = Type.Object({
	sessionId: Type.String({ description: "PTY session id from pty_start" }),
	view: Type.Optional(Type.Union([
		Type.Literal("viewport"),
		Type.Literal("buffer"),
	], { description: "Read the visible screen (viewport) or the full logical buffer" })),
});

const ptyWaitSchema = Type.Object({
	sessionId: Type.String({ description: "PTY session id from pty_start" }),
	text: Type.Optional(Type.String({ description: "Wait until the viewport or buffer contains this text" })),
	view: Type.Optional(Type.Union([
		Type.Literal("viewport"),
		Type.Literal("buffer"),
	], { description: "Where to search for the text (default viewport)" })),
	timeoutMs: Type.Optional(Type.Number({ description: "How long to wait before timing out (default 30000)" })),
	stableMs: Type.Optional(Type.Number({ description: "If text is omitted, wait until the screen stops changing for this long (default 800)" })),
});

const ptyResizeSchema = Type.Object({
	sessionId: Type.String({ description: "PTY session id from pty_start" }),
	cols: Type.Number({ description: "Terminal width in columns" }),
	rows: Type.Number({ description: "Terminal height in rows" }),
});

const ptyKillSchema = Type.Object({
	sessionId: Type.String({ description: "PTY session id from pty_start" }),
});

export type PtyStartInput = Static<typeof ptyStartSchema>;
export type PtySendInput = Static<typeof ptySendSchema>;
export type PtyReadInput = Static<typeof ptyReadSchema>;
export type PtyWaitInput = Static<typeof ptyWaitSchema>;
export type PtyResizeInput = Static<typeof ptyResizeSchema>;
export type PtyKillInput = Static<typeof ptyKillSchema>;

interface ManagedPtySession {
	id: string;
	command: string;
	pty: PtyExecutionSession;
	terminal: HeadlessTerminal;
	writeChain: Promise<void>;
	completed: boolean;
	cancelled: boolean;
	exitCode?: number;
	createdAt: number;
	lastUpdateAt: number;
}

export interface PtyToolDetails {
	sessionId: string;
	pid?: number;
	completed?: boolean;
	cancelled?: boolean;
	exitCode?: number;
	view?: "viewport" | "buffer";
	screenText?: string;
}

class PtySessionManager {
	readonly sessions = new Map<string, ManagedPtySession>();

	constructor(private cwd: string) {}

	async start(command: string, options?: { cols?: number; rows?: number; loginShell?: boolean }): Promise<ManagedPtySession> {
		const id = `pty_${randomUUID().slice(0, 8)}`;
		const terminal = createHeadlessTerminal(options?.cols ?? 80, options?.rows ?? 24, 10000);
		const session: ManagedPtySession = {
			id,
			command,
			pty: undefined as unknown as PtyExecutionSession,
			terminal,
			writeChain: Promise.resolve(),
			completed: false,
			cancelled: false,
			createdAt: Date.now(),
			lastUpdateAt: Date.now(),
		};
		this.sessions.set(id, session);

		let pty: PtyExecutionSession;
		try {
			pty = await executeBashInPty(command, {
				cols: options?.cols,
				rows: options?.rows,
				cwd: this.cwd,
				loginShell: options?.loginShell,
				onChunk: (chunk) => {
					const current = this.sessions.get(id);
					if (!current) return;
					current.lastUpdateAt = Date.now();
					current.writeChain = current.writeChain.then(
						() =>
							new Promise<void>((resolve) => {
								current.terminal.write(chunk, () => resolve());
							}),
					);
				},
			});
		} catch (error) {
			this.sessions.delete(id);
			throw error;
		}
		session.pty = pty;

		pty.result
			.then((result) => {
				const current = this.sessions.get(id);
				if (!current) return;
				current.completed = true;
				current.cancelled = result.cancelled;
				current.exitCode = result.exitCode;
				current.lastUpdateAt = Date.now();
			})
			.catch(() => {
				const current = this.sessions.get(id);
				if (!current) return;
				current.completed = true;
				current.lastUpdateAt = Date.now();
			});

		return session;
	}

	get(sessionId: string): ManagedPtySession {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(`PTY session not found: ${sessionId}`);
		}
		return session;
	}

	async send(sessionId: string, input: string): Promise<ManagedPtySession> {
		const session = this.get(sessionId);
		if (session.completed || !session.pty.handle.isActive()) {
			throw new Error(`PTY session is no longer active: ${sessionId}`);
		}
		session.pty.handle.write(input);
		session.lastUpdateAt = Date.now();
		await new Promise((resolve) => setTimeout(resolve, 50));
		return session;
	}

	async resize(sessionId: string, cols: number, rows: number): Promise<ManagedPtySession> {
		const session = this.get(sessionId);
		const safeCols = Math.max(20, cols);
		const safeRows = Math.max(5, rows);
		session.pty.handle.resize(safeCols, safeRows);
		session.terminal.resize(safeCols, safeRows);
		session.lastUpdateAt = Date.now();
		return session;
	}

	async kill(sessionId: string): Promise<ManagedPtySession> {
		const session = this.get(sessionId);
		if (session.pty.handle.isActive()) {
			session.pty.handle.kill();
		}
		session.cancelled = true;
		session.completed = true;
		session.lastUpdateAt = Date.now();
		return session;
	}

	async read(sessionId: string, view: "viewport" | "buffer" = "viewport"): Promise<{ session: ManagedPtySession; text: string }> {
		const session = this.get(sessionId);
		await session.writeChain;
		const text = view === "buffer"
			? snapshotTerminalBufferText(session.terminal)
			: snapshotTerminalViewportText(session.terminal);
		return { session, text };
	}

	async wait(
		sessionId: string,
		options?: { text?: string; view?: "viewport" | "buffer"; timeoutMs?: number; stableMs?: number; signal?: AbortSignal; onUpdate?: (result: { content: Array<{ type: string; text: string }>; details: any }) => void },
	): Promise<{ session: ManagedPtySession; text: string }> {
		const timeoutMs = Math.max(50, options?.timeoutMs ?? 30000);
		const stableMs = Math.max(50, options?.stableMs ?? 800);
		const view = options?.view ?? "viewport";
		const signal = options?.signal;
		const onUpdate = options?.onUpdate;
		const start = Date.now();
		let lastSnapshot = "";
		let stableSince = Date.now();
		let lastUpdateText = "";

		while (Date.now() - start < timeoutMs) {
			if (signal?.aborted) {
				throw new Error(`pty_wait cancelled`);
			}
			const { text } = await this.read(sessionId, view);

			// Push live screen text updates to UI
			if (onUpdate && text !== lastUpdateText) {
				lastUpdateText = text;
				const session = this.get(sessionId);
				onUpdate({
					content: [{ type: "text", text: buildReadText(session, view, text) }],
					details: { sessionId, pid: session.pty.handle.pid, completed: session.completed, cancelled: session.cancelled, exitCode: session.exitCode, view, screenText: text },
				});
			}

			if (options?.text) {
				if (text.includes(options.text)) {
					return { session: this.get(sessionId), text };
				}
				if (this.get(sessionId).completed) {
					return { session: this.get(sessionId), text };
				}
			} else {
				if (text !== lastSnapshot) {
					lastSnapshot = text;
					stableSince = Date.now();
				} else if (Date.now() - stableSince >= stableMs || this.get(sessionId).completed) {
					return { session: this.get(sessionId), text };
				}
			}
			await new Promise<void>((resolve) => {
				const t = setTimeout(resolve, 100);
				signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
			});
		}

		await this.read(sessionId, view);
		throw new Error(
			options?.text
				? `Timed out waiting for text in PTY session ${sessionId}: ${options.text}`
				: `Timed out waiting for PTY session ${sessionId} to stabilize`,
		);
	}
}

function formatSessionSummary(session: ManagedPtySession): string {
	const bits = [`session ${session.id}`, `pid ${session.pty.handle.pid}`];
	if (session.completed) {
		bits.push(session.cancelled ? "cancelled" : `completed${session.exitCode !== undefined ? ` exit ${session.exitCode}` : ""}`);
	} else {
		bits.push("running");
	}
	return bits.join(" · ");
}

function buildReadText(session: ManagedPtySession, view: "viewport" | "buffer", text: string): string {
	const header = `[${formatSessionSummary(session)} · ${view}]`;
	return text ? `${header}\n${text}` : `${header}\n(no visible text)`;
}

export interface PtyToolsResult {
	pty_start: AgentTool<any, PtyToolDetails>;
	pty_send: AgentTool<any, PtyToolDetails>;
	pty_read: AgentTool<any, PtyToolDetails>;
	pty_wait: AgentTool<any, PtyToolDetails>;
	pty_resize: AgentTool<any, PtyToolDetails>;
	pty_kill: AgentTool<any, PtyToolDetails>;
	writeToSession: (sessionId: string, input: string) => void;
}

export function createPtyTools(cwd: string): PtyToolsResult {
	const manager = new PtySessionManager(cwd);

	const ptyStartTool: AgentTool<typeof ptyStartSchema, PtyToolDetails> = {
		name: "pty_start",
		label: "pty_start",
		description: "Start an agent-controlled interactive PTY session. Use this when a command requires terminal interaction, prompts, or a full-screen TUI. Returns a sessionId for follow-up pty_send/pty_read/pty_wait/pty_kill calls.",
		parameters: ptyStartSchema,
		execute: async (_toolCallId, { command, cols, rows, loginShell }) => {
			const session = await manager.start(command, { cols, rows, loginShell });
			const { text } = await manager.read(session.id, "viewport");
			return {
				content: [{ type: "text", text: `Started PTY session ${session.id} for: ${command}\n${buildReadText(session, "viewport", text)}` }],
				details: { sessionId: session.id, pid: session.pty.handle.pid, completed: session.completed, cancelled: session.cancelled, exitCode: session.exitCode, view: "viewport", screenText: text },
			};
		},
	};

	const ptySendTool: AgentTool<typeof ptySendSchema, PtyToolDetails> = {
		name: "pty_send",
		label: "pty_send",
		description: "Send text or control sequences to an existing PTY session, e.g. \"y\\r\" or \"\\u001b[A\".",
		parameters: ptySendSchema,
		execute: async (_toolCallId, { sessionId, input }) => {
			const session = await manager.send(sessionId, input);
			const { text } = await manager.read(sessionId, "viewport");
			return {
				content: [{ type: "text", text: `Sent input to ${sessionId}: ${JSON.stringify(input)}\n${buildReadText(session, "viewport", text)}` }],
				details: { sessionId, pid: session.pty.handle.pid, completed: session.completed, cancelled: session.cancelled, exitCode: session.exitCode, view: "viewport", screenText: text },
			};
		},
	};

	const ptyReadTool: AgentTool<typeof ptyReadSchema, PtyToolDetails> = {
		name: "pty_read",
		label: "pty_read",
		description: "Read the current PTY screen state. Use view='viewport' for the visible screen or view='buffer' for the full logical buffer.",
		parameters: ptyReadSchema,
		execute: async (_toolCallId, { sessionId, view }) => {
			const effectiveView = view ?? "viewport";
			const { session, text } = await manager.read(sessionId, effectiveView);
			return {
				content: [{ type: "text", text: buildReadText(session, effectiveView, text) }],
				details: { sessionId, pid: session.pty.handle.pid, completed: session.completed, cancelled: session.cancelled, exitCode: session.exitCode, view: effectiveView, screenText: text },
			};
		},
	};

	const ptyWaitTool: AgentTool<typeof ptyWaitSchema, PtyToolDetails> = {
		name: "pty_wait",
		label: "pty_wait",
		description: "Wait until text appears in a PTY session or until the PTY screen stops changing. Useful between pty_send calls.",
		parameters: ptyWaitSchema,
		execute: async (_toolCallId, { sessionId, text, view, timeoutMs, stableMs }, signal, onUpdate) => {
			const effectiveView = view ?? "viewport";
			const result = await manager.wait(sessionId, { text, view: effectiveView, timeoutMs, stableMs, signal, onUpdate: onUpdate as ((result: { content: Array<{ type: string; text: string }>; details: any }) => void) | undefined });
			return {
				content: [{ type: "text", text: buildReadText(result.session, effectiveView, result.text) }],
				details: { sessionId, pid: result.session.pty.handle.pid, completed: result.session.completed, cancelled: result.session.cancelled, exitCode: result.session.exitCode, view: effectiveView, screenText: result.text },
			};
		},
	};

	const ptyResizeTool: AgentTool<typeof ptyResizeSchema, PtyToolDetails> = {
		name: "pty_resize",
		label: "pty_resize",
		description: "Resize an active PTY session to the given terminal dimensions.",
		parameters: ptyResizeSchema,
		execute: async (_toolCallId, { sessionId, cols, rows }) => {
			const session = await manager.resize(sessionId, cols, rows);
			const { text } = await manager.read(sessionId, "viewport");
			return {
				content: [{ type: "text", text: `Resized ${sessionId} to ${cols}x${rows}\n${buildReadText(session, "viewport", text)}` }],
				details: { sessionId, pid: session.pty.handle.pid, completed: session.completed, cancelled: session.cancelled, exitCode: session.exitCode, view: "viewport", screenText: text },
			};
		},
	};

	const ptyKillTool: AgentTool<typeof ptyKillSchema, PtyToolDetails> = {
		name: "pty_kill",
		label: "pty_kill",
		description: "Terminate an agent-controlled PTY session.",
		parameters: ptyKillSchema,
		execute: async (_toolCallId, { sessionId }) => {
			const session = await manager.kill(sessionId);
			return {
				content: [{ type: "text", text: `Terminated PTY session ${sessionId}. ${formatSessionSummary(session)}` }],
				details: { sessionId, pid: session.pty.handle.pid, completed: session.completed, cancelled: session.cancelled, exitCode: session.exitCode },
			};
		},
	};

	/** Write raw input to an active PTY session by ID. Used by the UI when the user focuses and types into an agent PTY terminal. */
	function writeToSession(sessionId: string, input: string): void {
		const session = manager.sessions.get(sessionId);
		if (session && !session.completed && session.pty.handle.isActive()) {
			session.pty.handle.write(input);
		}
	}

	return {
		pty_start: ptyStartTool,
		pty_send: ptySendTool,
		pty_read: ptyReadTool,
		pty_wait: ptyWaitTool,
		pty_resize: ptyResizeTool,
		pty_kill: ptyKillTool,
		writeToSession,
	};
}

export const ptyToolNames = ["pty_start", "pty_send", "pty_read", "pty_wait", "pty_resize", "pty_kill"] as const;
