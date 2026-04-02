import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { __testing } from "../resources/extensions/usage/index.ts";

const { parseArgs, collectUsage } = __testing;

test("usage parseArgs defaults to today, all projects, by model", () => {
	const result = parseArgs("");
	assert.equal(result.label, "today");
	assert.equal(result.scope, "all-projects");
	assert.equal(result.groupBy, "model");
	assert.equal(result.json, false);
});

test("usage parseArgs supports project scope, group and json flags", () => {
	const result = parseArgs("7d --project-current --by project-model --json");
	assert.equal(result.label, "7d");
	assert.equal(result.scope, "current-project");
	assert.equal(result.groupBy, "project-model");
	assert.equal(result.json, true);
});

test("usage collectUsage aggregates assistant messages by model", () => {
	const dir = mkdtempSync(join(tmpdir(), "lsd-usage-"));
	const file = join(dir, "session.jsonl");
	const now = Date.now();

	try {
		writeFileSync(file, [
			JSON.stringify({ type: "session", cwd: "/tmp/proj-a" }),
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude-sonnet-4-6",
					timestamp: now,
					usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 5, cost: { total: 0.12 } },
				},
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude-sonnet-4-6",
					timestamp: now,
					usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.03 } },
				},
			}),
		].join("\n"));

		const report = collectUsage([file], now - 1000, now + 1000, "all-projects", "model");
		assert.equal(report.rows.length, 1);
		assert.equal(report.rows[0]?.key, "anthropic/claude-sonnet-4-6");
		assert.equal(report.rows[0]?.messages, 2);
		assert.equal(report.rows[0]?.input, 150);
		assert.equal(report.rows[0]?.output, 30);
		assert.equal(report.rows[0]?.cacheRead, 10);
		assert.equal(report.rows[0]?.cacheWrite, 5);
		assert.equal(report.rows[0]?.total, 195);
		assert.equal(report.rows[0]?.cost, 0.15);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
