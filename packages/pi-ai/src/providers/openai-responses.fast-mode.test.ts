import assert from "node:assert/strict";
import test from "node:test";

import { __testing } from "./openai-responses.js";

test("openai-responses fast mode maps to service_tier=priority for supported models", () => {
	const model = {
		id: "gpt-5.4",
		name: "gpt-5.4",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32768,
		capabilities: { supportsServiceTier: true },
	} as any;
	const context = {
		systemPrompt: "",
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
	} as any;

	const params = __testing.buildParams(model, context, { fastMode: true });
	assert.equal(params.service_tier, "priority");
});

test("openai-responses fast mode off omits service_tier", () => {
	const model = {
		id: "gpt-5.4",
		name: "gpt-5.4",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32768,
		capabilities: { supportsServiceTier: true },
	} as any;
	const context = {
		systemPrompt: "",
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
	} as any;

	const params = __testing.buildParams(model, context, { fastMode: false });
	assert.equal("service_tier" in params, false);
});

test("openai-responses fast mode is scoped to provider=openai", () => {
	const model = {
		id: "gpt-5.4",
		name: "gpt-5.4",
		api: "openai-responses",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32768,
		capabilities: { supportsServiceTier: true },
	} as any;
	const context = {
		systemPrompt: "",
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
	} as any;

	const params = __testing.buildParams(model, context, { fastMode: true });
	assert.equal("service_tier" in params, false);
});
