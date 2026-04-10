import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "../types.js";
import { ADAPTIVE_SCORE_BANDS, classifyAdaptiveThinking } from "./classifier.js";

function user(text: string): Message {
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

describe("classifyAdaptiveThinking", () => {
	it("classifies short acknowledgements as low", () => {
		const result = classifyAdaptiveThinking({ latestUserMessage: user("thanks") });
		assert.equal(result.level, "low");
		assert.match(result.reasons.join(" "), /short_acknowledgement/);
	});

	it("classifies explain-style requests as medium", () => {
		const result = classifyAdaptiveThinking({ latestUserMessage: user("Can you explain how this cache invalidation works?") });
		assert.equal(result.level, "medium");
	});

	it("classifies broad refactor tasks as high", () => {
		const result = classifyAdaptiveThinking({ latestUserMessage: user("Refactor and migrate auth across the entire codebase") });
		assert.equal(result.level, "high");
	});

	it("biases to high when plan mode is active", () => {
		const result = classifyAdaptiveThinking({
			latestUserMessage: user("Fix typo in footer"),
			planModeActive: true,
		});
		assert.equal(result.level, "high");
		assert.match(result.reasons.join(" "), /plan_mode_bias_high/);
	});

	it("throws for empty user text", () => {
		assert.throws(
			() => classifyAdaptiveThinking({ latestUserMessage: user("   ") }),
			/non-empty user text/,
		);
	});

	it("exports stable score bands", () => {
		assert.deepEqual(ADAPTIVE_SCORE_BANDS, {
			lowMax: 20,
			mediumMax: 70,
		});
	});
});
