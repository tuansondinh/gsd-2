import { randomBytes } from "node:crypto";
import { createWriteStream, unlinkSync, type WriteStream } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processStreamChunk, type StreamState } from "@gsd/native";
import { getShellConfig, getShellEnv, sanitizeCommand } from "../utils/shell.js";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.js";
import type { BashResult } from "./bash-executor.js";

export interface PtyExecutorOptions {
	onChunk?: (chunk: string) => void;
	signal?: AbortSignal;
	cols?: number;
	rows?: number;
	loginShell?: boolean;
}

export interface PtyExecutionHandle {
	pid: number;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(): void;
	isActive(): boolean;
}

export interface PtyExecutionSession {
	handle: PtyExecutionHandle;
	result: Promise<BashResult>;
}

type PtyModule = {
	spawn: (
		file: string,
		args?: string[],
		options?: {
			name?: string;
			cols?: number;
			rows?: number;
			cwd?: string;
			env?: Record<string, string>;
		},
	) => {
		pid: number;
		write(data: string): void;
		resize(cols: number, rows: number): void;
		kill(signal?: string): void;
		onData(cb: (data: string) => void): { dispose(): void } | void;
		onExit(cb: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } | void;
	};
};

const ptyTempFiles = new Set<string>();
let cleanupRegistered = false;

function registerTempCleanup(): void {
	if (cleanupRegistered) return;
	cleanupRegistered = true;
	process.on("exit", () => {
		for (const file of ptyTempFiles) {
			try {
				unlinkSync(file);
			} catch {
				// Best-effort cleanup
			}
		}
	});
}

export async function loadPtyModule(): Promise<PtyModule | null> {
	const cjsRequire = createRequire(import.meta.url);
	for (const name of ["@lydell/node-pty", "node-pty"]) {
		try {
			return cjsRequire(name) as PtyModule;
		} catch {
			// Try next implementation
		}
	}
	return null;
}

export async function isPtyAvailable(): Promise<boolean> {
	return (await loadPtyModule()) !== null;
}

export async function executeBashInPty(command: string, options: PtyExecutorOptions = {}): Promise<PtyExecutionSession> {
	const pty = await loadPtyModule();
	if (!pty) {
		throw new Error("PTY support is unavailable (install @lydell/node-pty or node-pty)");
	}

	let shell: string;
	let args: string[];
	if (options.loginShell) {
		shell = process.env.SHELL || "/bin/bash";
		args = ["-l", "-c"];
	} else {
		({ shell, args } = getShellConfig());
	}

	const child = pty.spawn(shell, [...args, sanitizeCommand(command)], {
		name: "xterm-256color",
		cols: Math.max(20, options.cols ?? 80),
		rows: Math.max(5, options.rows ?? 24),
		cwd: process.cwd(),
		env: {
			...Object.fromEntries(
				Object.entries(getShellEnv()).map(([key, value]) => [key, String(value ?? "")]),
			),
			TERM: "xterm-256color",
		},
	});

	let active = true;
	let cancelled = false;
	const outputChunks: string[] = [];
	let outputBytes = 0;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;
	let tempFilePath: string | undefined;
	let tempFileStream: WriteStream | undefined;
	let totalBytes = 0;
	let streamState: StreamState | undefined;

	const handleData = (data: string) => {
		const buffer = Buffer.from(data, "utf8");
		totalBytes += buffer.length;

		const result = processStreamChunk(buffer, streamState);
		streamState = result.state;
		const text = result.text;

		if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
			registerTempCleanup();
			const id = randomBytes(8).toString("hex");
			tempFilePath = join(tmpdir(), `pi-pty-${id}.log`);
			ptyTempFiles.add(tempFilePath);
			tempFileStream = createWriteStream(tempFilePath);
			for (const chunk of outputChunks) {
				tempFileStream.write(chunk);
			}
		}

		if (tempFileStream) {
			tempFileStream.write(text);
		}

		outputChunks.push(text);
		outputBytes += text.length;
		while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
			const removed = outputChunks.shift()!;
			outputBytes -= removed.length;
		}

		options.onChunk?.(data);
	};

	const dataDisposable = child.onData(handleData);

	const result = new Promise<BashResult>((resolve) => {
		const onAbort = () => {
			cancelled = true;
			try {
				child.kill();
			} catch {
				// Best-effort
			}
		};

		if (options.signal) {
			if (options.signal.aborted) {
				onAbort();
			} else {
				options.signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		const finish = (exitCode: number | undefined) => {
			active = false;
			if (options.signal) {
				options.signal.removeEventListener("abort", onAbort);
			}
			dataDisposable?.dispose?.();
			tempFileStream?.end();

			const fullOutput = outputChunks.join("");
			const truncationResult = truncateTail(fullOutput);
			resolve({
				output: truncationResult.truncated ? truncationResult.content : fullOutput,
				exitCode: cancelled ? undefined : exitCode,
				cancelled,
				truncated: truncationResult.truncated,
				fullOutputPath: tempFilePath,
			});
		};

		const exitDisposable = child.onExit(({ exitCode }) => {
			exitDisposable?.dispose?.();
			finish(exitCode);
		});
	});

	return {
		handle: {
			pid: child.pid,
			write(data: string) {
				if (!active) return;
				child.write(data);
			},
			resize(cols: number, rows: number) {
				if (!active) return;
				child.resize(Math.max(20, cols), Math.max(5, rows));
			},
			kill() {
				if (!active) return;
				cancelled = true;
				try {
					child.kill();
				} catch {
					// Best-effort
				}
			},
			isActive() {
				return active;
			},
		},
		result,
	};
}
