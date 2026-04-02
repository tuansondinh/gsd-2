import assert from "node:assert/strict";
import test from "node:test";

import { resolveConfiguredSubagentModel } from "../resources/extensions/subagent/configured-model.ts";
import {
	inferProviderForBareModel,
	normalizeSubagentModel,
	resolveSubagentModel,
} from "../resources/extensions/subagent/model-resolution.ts";
import type { AgentConfig } from "../resources/extensions/subagent/agents.ts";

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "Worker agent",
		systemPrompt: "test",
		source: "user",
		filePath: "/tmp/worker.md",
		...overrides,
	};
}

test("inferProviderForBareModel infers providers for known bare model ids", () => {
	assert.equal(inferProviderForBareModel("claude-haiku-4-5"), "anthropic");
	assert.equal(inferProviderForBareModel("gemini-2.5-flash"), "google");
	assert.equal(inferProviderForBareModel("gpt-5.4"), "openai");
	assert.equal(inferProviderForBareModel("mystery-model"), undefined);
});

test("normalizeSubagentModel preserves already-qualified provider/id strings", () => {
	assert.equal(normalizeSubagentModel("anthropic/claude-sonnet-4-6"), "anthropic/claude-sonnet-4-6");
	assert.equal(normalizeSubagentModel(" claude-code/claude-sonnet-4-6 "), "claude-code/claude-sonnet-4-6");
});

test("normalizeSubagentModel upgrades known bare ids to provider/id format", () => {
	assert.equal(normalizeSubagentModel("claude-haiku-4-5"), "anthropic/claude-haiku-4-5");
	assert.equal(normalizeSubagentModel("gemini-2.5-pro"), "google/gemini-2.5-pro");
});

test("normalizeSubagentModel rejects empty and malformed model strings", () => {
	assert.equal(normalizeSubagentModel(undefined), undefined);
	assert.equal(normalizeSubagentModel("   "), undefined);
	assert.equal(normalizeSubagentModel("$budget_model"), undefined);
	assert.equal(normalizeSubagentModel("anthropic/claude/sonnet"), undefined);
	assert.equal(normalizeSubagentModel("/claude-sonnet-4-6"), undefined);
	assert.equal(normalizeSubagentModel("anthropic/"), undefined);
});

test("resolveConfiguredSubagentModel resolves $budget_model from settings to provider/id format", () => {
	const result = resolveConfiguredSubagentModel(
		agent({ model: "$budget_model" }),
		{ subagent: { budget_model: "google/gemini-2.5-flash" } },
		"claude-haiku-4-5",
	);

	assert.equal(result, "anthropic/claude-haiku-4-5");
});

test("resolveConfiguredSubagentModel falls back to preferences when settings are empty", () => {
	const result = resolveConfiguredSubagentModel(
		agent({ model: "$budget_model" }),
		{ subagent: { budget_model: "gemini-2.5-flash" } },
		"   ",
	);

	assert.equal(result, "google/gemini-2.5-flash");
});

test("resolveConfiguredSubagentModel returns undefined for missing or malformed budget models", () => {
	assert.equal(resolveConfiguredSubagentModel(agent({ model: "$budget_model" }), {}, undefined), undefined);
	assert.equal(
		resolveConfiguredSubagentModel(agent({ model: "$budget_model" }), {}, "not/a/valid/model"),
		undefined,
	);
});

test("resolveConfiguredSubagentModel normalizes explicit frontmatter models", () => {
	const result = resolveConfiguredSubagentModel(agent({ model: "claude-sonnet-4-6" }));
	assert.equal(result, "anthropic/claude-sonnet-4-6");
});

test("resolveSubagentModel prefers explicit tool-call override and normalizes it", () => {
	const result = resolveSubagentModel(
		{ name: "worker", model: "anthropic/claude-sonnet-4-6" },
		{
			overrideModel: "gpt-5.4",
			parentModel: { provider: "google", id: "gemini-2.5-pro" },
		},
	);

	assert.equal(result, "openai/gpt-5.4");
});

test("resolveSubagentModel falls back to normalized agent frontmatter model", () => {
	const result = resolveSubagentModel(
		{ name: "worker", model: "claude-sonnet-4-6" },
		{ parentModel: { provider: "google", id: "gemini-2.5-pro" } },
	);

	assert.equal(result, "anthropic/claude-sonnet-4-6");
});

test("resolveSubagentModel falls back to parent session model in provider/id format", () => {
	const result = resolveSubagentModel(
		{ name: "worker", model: undefined },
		{ parentModel: { provider: "google", id: "gemini-2.5-pro" } },
	);

	assert.equal(result, "google/gemini-2.5-pro");
});

test("resolveSubagentModel ignores malformed override and falls back to parent model", () => {
	const result = resolveSubagentModel(
		{ name: "worker", model: undefined },
		{
			overrideModel: "anthropic/claude/sonnet",
			parentModel: { provider: "google", id: "gemini-2.5-pro" },
		},
	);

	assert.equal(result, "google/gemini-2.5-pro");
});

test("resolveSubagentModel returns undefined when nothing valid can be inferred", () => {
	const result = resolveSubagentModel({ name: "worker", model: "bogus-model" }, { overrideModel: "   " });
	assert.equal(result, undefined);
});
