import assert from "node:assert/strict";
import test from "node:test";

import { __testing, streamSimpleOpenAICodexResponses } from "./openai-codex-responses.js";

function makeJwt(accountId: string): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `${header}.${payload}.sig`;
}

const codexModel = {
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
} as any;

const simpleContext = {
	systemPrompt: "",
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
} as any;

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
		const stream = streamSimpleOpenAICodexResponses(codexModel, simpleContext, {
			apiKey: makeJwt("acct_123"),
			transport: "sse",
		} as any);

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

test("codex request body maps fast mode to service_tier=priority and omits when off", () => {
	const onBody = __testing.buildRequestBody(codexModel, simpleContext, { fastMode: true } as any);
	assert.equal(onBody.service_tier, "priority");

	const offBody = __testing.buildRequestBody(codexModel, simpleContext, { fastMode: false } as any);
	assert.equal("service_tier" in offBody, false);
});

test("codex SSE payload includes priority when fast mode is on and omits when off", async () => {
	const originalFetch = globalThis.fetch;
	const bodies: any[] = [];

	globalThis.fetch = (async (_url, init) => {
		const rawBody = typeof init?.body === "string" ? init.body : "{}";
		bodies.push(JSON.parse(rawBody));
		const sse = [
			'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}',
			"",
		].join("\n");
		return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
	}) as typeof fetch;

	try {
		for (const fastMode of [true, false]) {
			const stream = streamSimpleOpenAICodexResponses(codexModel, simpleContext, {
				apiKey: makeJwt("acct_sse"),
				transport: "sse",
				fastMode,
			} as any);
			await stream.result();
		}

		assert.equal(bodies[0]?.service_tier, "priority");
		assert.equal("service_tier" in bodies[1], false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("codex websocket cache resets when fast mode changes on same session", async () => {
	const originalWebSocket = (globalThis as any).WebSocket;
	const originalFetch = globalThis.fetch;
	const sentPayloads: any[] = [];
	let constructorCalls = 0;

	class MockWebSocket {
		public readyState = 0;
		private listeners = new Map<string, Set<(event: any) => void>>();

		constructor(_url: string, _options?: unknown) {
			constructorCalls++;
			queueMicrotask(() => {
				this.readyState = 1;
				this.emit("open", {});
			});
		}

		send(data: string): void {
			sentPayloads.push(JSON.parse(data));
			queueMicrotask(() => {
				this.emit("message", {
					data: JSON.stringify({
						type: "response.completed",
						response: {
							status: "completed",
							usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
						},
					}),
				});
			});
		}

		close(): void {
			this.readyState = 3;
			this.emit("close", { code: 1000, reason: "closed" });
		}

		addEventListener(type: string, listener: (event: any) => void): void {
			if (!this.listeners.has(type)) this.listeners.set(type, new Set());
			this.listeners.get(type)!.add(listener);
		}

		removeEventListener(type: string, listener: (event: any) => void): void {
			this.listeners.get(type)?.delete(listener);
		}

		private emit(type: string, event: any): void {
			for (const listener of this.listeners.get(type) ?? []) {
				listener(event);
			}
		}
	}

	(globalThis as any).WebSocket = MockWebSocket as any;
	globalThis.fetch = (async () => {
		throw new Error("fetch should not be used in websocket transport test");
	}) as any;

	try {
		__testing.clearWebSocketSessionCache();
		for (const fastMode of [true, false]) {
			const stream = streamSimpleOpenAICodexResponses(codexModel, simpleContext, {
				apiKey: makeJwt("acct_ws"),
				transport: "websocket",
				sessionId: "session-fast-toggle",
				fastMode,
			} as any);
			await stream.result();
		}

		assert.equal(constructorCalls, 2, "websocket should reconnect when service tier state changes");
		assert.equal(sentPayloads[0]?.service_tier, "priority");
		assert.equal("service_tier" in sentPayloads[1], false);
	} finally {
		__testing.clearWebSocketSessionCache();
		(globalThis as any).WebSocket = originalWebSocket;
		globalThis.fetch = originalFetch;
	}
});
