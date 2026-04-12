import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

interface CapturedCommand {
	name: string;
	handler: (args: string, ctx: any) => Promise<void>;
	getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string; description?: string }>;
}

function makeCtx(model: any) {
	const notifyCalls: Array<{ message: string; type?: string }> = [];
	return {
		model,
		ui: {
			notify(message: string, type?: string) {
				notifyCalls.push({ message, type });
			},
		},
		notifyCalls,
	};
}

function readFastModeSetting(agentDir: string): boolean | undefined {
	const path = join(agentDir, "settings.json");
	if (!existsSync(path)) return undefined;
	const parsed = JSON.parse(readFileSync(path, "utf8")) as { fastMode?: boolean };
	return parsed.fastMode;
}

async function loadFastCommand(): Promise<CapturedCommand> {
	const mod = await import("../resources/extensions/slash-commands/fast.ts");
	let captured: CapturedCommand | undefined;
	mod.default({
		registerCommand(name: string, options: any) {
			captured = { name, ...options };
		},
	} as any);
	assert.ok(captured, "fast command should register");
	return captured!;
}

test("/fast status reflects persisted setting", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "lsd-fast-command-"));
	const previous = process.env.LSD_CODING_AGENT_DIR;
	process.env.LSD_CODING_AGENT_DIR = agentDir;

	try {
		const cmd = await loadFastCommand();
		const ctx = makeCtx({
			provider: "openai",
			id: "gpt-5.4",
			api: "openai-responses",
			capabilities: { supportsServiceTier: true },
		});
		await cmd.handler("status", ctx);
		assert.match(ctx.notifyCalls[0]?.message ?? "", /Fast mode: OFF/i);
	} finally {
		if (previous === undefined) delete process.env.LSD_CODING_AGENT_DIR;
		else process.env.LSD_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("/fast on and /fast off persist fastMode in settings", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "lsd-fast-command-"));
	const previous = process.env.LSD_CODING_AGENT_DIR;
	process.env.LSD_CODING_AGENT_DIR = agentDir;

	try {
		const cmd = await loadFastCommand();
		const ctx = makeCtx({
			provider: "openai",
			id: "gpt-5.4",
			api: "openai-responses",
			capabilities: { supportsServiceTier: true },
		});

		await cmd.handler("on", ctx);
		assert.equal(readFastModeSetting(agentDir), true);
		assert.match(ctx.notifyCalls[ctx.notifyCalls.length - 1]?.message ?? "", /service_tier=priority/i);

		await cmd.handler("off", ctx);
		assert.equal(readFastModeSetting(agentDir), false);
		assert.match(ctx.notifyCalls[ctx.notifyCalls.length - 1]?.message ?? "", /omit service_tier/i);
	} finally {
		if (previous === undefined) delete process.env.LSD_CODING_AGENT_DIR;
		else process.env.LSD_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("/fast toggles and warns on unsupported model while still persisting", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "lsd-fast-command-"));
	const previous = process.env.LSD_CODING_AGENT_DIR;
	process.env.LSD_CODING_AGENT_DIR = agentDir;

	try {
		const cmd = await loadFastCommand();
		const ctx = makeCtx({
			provider: "anthropic",
			id: "claude-sonnet-4-6",
			api: "anthropic-messages",
		});
		await cmd.handler("", ctx);
		assert.equal(readFastModeSetting(agentDir), true);
		assert.match(ctx.notifyCalls[ctx.notifyCalls.length - 1]?.message ?? "", /does not support fast mode/i);
		assert.equal(ctx.notifyCalls[ctx.notifyCalls.length - 1]?.type, "warning");
	} finally {
		if (previous === undefined) delete process.env.LSD_CODING_AGENT_DIR;
		else process.env.LSD_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
