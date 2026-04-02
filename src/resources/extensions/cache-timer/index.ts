/**
 * Cache Timer Extension
 *
 * Shows elapsed time since the last LLM response in the TUI footer.
 * Useful for tracking Claude's 5-minute prompt cache window.
 *
 * - Starts counting up when the agent finishes a response
 * - Resets when a new request begins
 * - Color: dim (0–5 min), yellow (5–10 min), red (10+ min)
 * - Toggle with /cache-timer command
 * - Persists enabled state in settings.json under `cacheTimer.enabled`
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionUIContext } from "@gsd/pi-coding-agent";
import { getAgentDir } from "@gsd/pi-coding-agent";

const STATUS_KEY = "cache-timer";

// ANSI color codes for timer display
const ANSI_RESET = "\x1b[0m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_RED = "\x1b[31m";

function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

function readEnabled(): boolean {
	try {
		const path = getSettingsPath();
		if (!existsSync(path)) return true;
		const settings = JSON.parse(readFileSync(path, "utf-8"));
		// SettingsManager stores `cacheTimer` as a top-level boolean (default true)
		return settings?.cacheTimer !== false;
	} catch {
		return true;
	}
}

function writeEnabled(enabled: boolean): void {
	const path = getSettingsPath();
	let settings: Record<string, unknown> = {};
	try {
		if (existsSync(path)) {
			settings = JSON.parse(readFileSync(path, "utf-8"));
		}
	} catch {
		// ignore parse errors, start fresh
	}
	settings.cacheTimer = enabled;
	writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

function formatElapsed(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	const time = `${minutes}:${seconds.toString().padStart(2, "0")}`;

	if (ms >= 10 * 60 * 1000) {
		// 10+ minutes: red
		return `${ANSI_RED}⏱ ${time}${ANSI_RESET}`;
	} else if (ms >= 5 * 60 * 1000) {
		// 5–10 minutes: yellow
		return `${ANSI_YELLOW}⏱ ${time}${ANSI_RESET}`;
	}
	// Under 5 minutes: plain (inherits footer dim styling)
	return `⏱ ${time}`;
}

export default function cacheTimerExtension(pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let startTime: number | null = null;
	let enabled = readEnabled();

	// We capture the ui reference on first use — it stays valid for the session lifetime
	let ui: ExtensionUIContext | null = null;

	function startTimer(uiCtx: ExtensionUIContext): void {
		stopTimer();
		if (!enabled) return;
		ui = uiCtx;
		startTime = Date.now();
		uiCtx.setStatus(STATUS_KEY, formatElapsed(0));
		timer = setInterval(() => {
			if (startTime !== null && ui !== null) {
				ui.setStatus(STATUS_KEY, formatElapsed(Date.now() - startTime));
			}
		}, 1000);
	}

	function stopTimer(): void {
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
		startTime = null;
		if (ui !== null) {
			ui.setStatus(STATUS_KEY, undefined);
		}
	}

	// When the agent finishes a response, start counting up
	pi.on("agent_end", async (_event, ctx) => {
		startTimer(ctx.ui);
	});

	// When the user submits a new request, clear the timer
	pi.on("agent_start", async (_event, ctx) => {
		ui = ctx.ui;
		stopTimer();
	});

	// Clean up on session shutdown
	pi.on("session_shutdown", () => {
		stopTimer();
	});

	// /cache-timer — toggle on/off
	pi.registerCommand("cache-timer", {
		description: "Toggle the cache elapsed-time timer in the footer",
		async handler(_args, ctx) {
			enabled = !enabled;
			writeEnabled(enabled);
			if (enabled) {
				ctx.ui.notify("Cache timer enabled", "info");
			} else {
				stopTimer();
				ctx.ui.notify("Cache timer disabled", "info");
			}
		},
	});
}
