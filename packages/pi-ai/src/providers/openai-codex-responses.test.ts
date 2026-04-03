import assert from "node:assert/strict";
import test from "node:test";

import { streamSimpleOpenAICodexResponses } from "./openai-codex-responses.js";

test("codex provider does not internally retry ChatGPT usage-plan 429s", async () => {
	const originalFetch = globalThis.fetch;
	let fetchCalls = 0;

	globalThis.fetch = (async () => {
		fetchCalls++;
		return new Response(
			JSON.stringify({
				error: {
					code: "rate_limit_exceeded",
					plan_type: "team",
					resets_at: Math.floor(Date.now() / 1000) + 60 * 60,
					message: "usage plan exhausted",
				},
			}),
			{ status: 429, statusText: "Too Many Requests" },
		);
	}) as typeof fetch;

	try {
		const stream = streamSimpleOpenAICodexResponses(
			{
				id: "gpt-5.4",
				name: "gpt-5.4",
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: "https://chatgpt.com/backend-api",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			} as any,
			{
				systemPrompt: "",
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			} as any,
			{ apiKey: "test-key" },
		);

		let finalError = "";
		for await (const event of stream) {
			if (event.type === "error") {
				finalError = event.error.errorMessage || "";
			}
		}

		assert.equal(fetchCalls, 1, "usage-plan exhaustion should bubble immediately for account rotation");
		assert.match(finalError, /usage limit|usage plan exhausted|team plan/i);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
