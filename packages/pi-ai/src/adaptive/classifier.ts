import { completeSimple } from "../stream.js";
import type { Message, Model } from "../types.js";

export const ADAPTIVE_SCORE_BANDS = {
	lowMax: 20,
	mediumMax: 70,
} as const;

export interface AdaptiveClassifierInput {
	latestUserMessage: Message;
	priorMessages?: Message[];
	toolNames?: string[];
	planModeActive?: boolean;
}

export interface AdaptiveClassifierResult {
	level: "low" | "medium" | "high";
	reasons: string[];
	score: number;
}

function getUserText(message: Message): string {
	if (message.role !== "user") {
		throw new Error("Adaptive classifier requires a user message");
	}
	if (typeof message.content === "string") {
		return message.content.trim();
	}
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join(" ")
		.trim();
}

function clampScore(score: number): number {
	if (score < 0) return 0;
	if (score > 100) return 100;
	return score;
}

function countCodeblockLines(text: string): number {
	const codeBlocks = text.match(/```[\s\S]*?```/g) ?? [];
	let total = 0;
	for (const block of codeBlocks) {
		total += block.split("\n").length;
	}
	return total;
}

function stripCodeBlocks(text: string): string {
	return text.replace(/```[\s\S]*?```/g, " ");
}

export function classifyAdaptiveThinking(input: AdaptiveClassifierInput): AdaptiveClassifierResult {
	const text = getUserText(input.latestUserMessage);
	if (!text) {
		throw new Error("Adaptive classifier requires non-empty user text");
	}
	const normalized = text.toLowerCase();
	const normalizedNoCode = stripCodeBlocks(normalized);
	const noCodeWords = normalizedNoCode.split(/\s+/).filter(Boolean);
	const codeLines = countCodeblockLines(text);
	const reasons: string[] = [];
	let score = 45;

	if (/^\s*(hi|hey|hello|thanks|thank you|thx|ok|okay|yes|yep|continue|go ahead)\s*[.!?]*\s*$/i.test(text)) {
		return { level: "low", reasons: ["short_acknowledgement"], score: 8 };
	}

	if (text.trim().length < 40 && codeLines === 0) {
		score -= 8;
		reasons.push("very_short_prompt");
	}

	if (/\b(fix|rename|format|typo|lint)\b/.test(normalized)) {
		score -= 4;
		reasons.push("small_edit_language");
	}

	const filePaths = normalized.match(/[\w./-]+\.[a-z0-9]{1,6}\b/g) ?? [];
	if (filePaths.length >= 3 || /\bacross the codebase\b|\bentire\b|\ball\b/.test(normalized)) {
		score += 28;
		reasons.push("broad_scope");
	} else if (filePaths.length === 1) {
		score -= 5;
		reasons.push("single_file_scope");
	}

	if (/\b(why|explain|how does|how do)\b/.test(normalized)) {
		score += 12;
		reasons.push("explanatory_request");
	}

	if (/\b(refactor|migrate|design|architect|debug)\b/.test(normalized)) {
		score += 30;
		reasons.push("high_complexity_verb");
	}

	if (/\b(typeerror|panic|exception|error:)\b/.test(normalized)) {
		score += 12;
		reasons.push("error_context");
	}

	if (codeLines > 0 && codeLines <= 40) {
		score -= 4;
		reasons.push("small_code_block");
	}

	if (noCodeWords.length > 300) {
		score += 12;
		reasons.push("long_prompt");
	}

	if (input.planModeActive) {
		score = Math.max(score + 20, 71);
		reasons.push("plan_mode_bias_high");
	}

	score = clampScore(score);
	const level = score <= ADAPTIVE_SCORE_BANDS.lowMax
		? "low"
		: score <= ADAPTIVE_SCORE_BANDS.mediumMax
			? "medium"
			: "high";

	return {
		level,
		reasons,
		score,
	};
}

// ---------------------------------------------------------------------------
// LLM-based classifier
// ---------------------------------------------------------------------------

const LLM_CLASSIFIER_SYSTEM = `You are a reasoning-effort classifier for a coding assistant.

Given the user's message, decide how much thinking effort the assistant should use:
- low: trivial tasks — short acknowledgements, tiny edits, simple lookups
- medium: moderate tasks — single-file changes, explanations, focused debugging
- high: complex tasks — multi-file refactors, architecture decisions, hard bugs

Reply with exactly one word: low, medium, or high.`;

export interface LLMClassifierInput extends AdaptiveClassifierInput {
	/** The model to use for classification */
	classifierModel: Model<any>;
	/** AbortSignal to cancel the request */
	signal?: AbortSignal;
}

/**
 * LLM-based adaptive thinking classifier.
 * Uses a configured small model to decide the reasoning level for the current turn.
 * Falls back to the heuristic classifier on error.
 */
export async function classifyAdaptiveThinkingWithLLM(
	input: LLMClassifierInput,
): Promise<AdaptiveClassifierResult> {
	const text = getUserText(input.latestUserMessage);
	if (!text) {
		throw new Error("Adaptive classifier requires non-empty user text");
	}

	const priorContext = (input.priorMessages ?? [])
		.slice(-4)
		.map((m) => {
			const role = m.role === "user" ? "User" : "Assistant";
			const content = typeof m.content === "string" ? m.content : m.content.map((b) => ("text" in b ? b.text : "")).join(" ");
			return `${role}: ${content.slice(0, 300)}`;
		})
		.join("\n");

	const userPrompt = priorContext
		? `Prior context:\n${priorContext}\n\nCurrent message:\n${text}`
		: text;

	try {
		const result = await completeSimple(
			input.classifierModel,
			{
				systemPrompt: LLM_CLASSIFIER_SYSTEM,
				messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
			},
			{ signal: input.signal },
		);

		const raw = result.content
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("")
			.trim()
			.toLowerCase();

		if (raw === "low" || raw === "medium" || raw === "high") {
			return { level: raw, reasons: ["llm_classified"], score: raw === "low" ? 10 : raw === "medium" ? 55 : 85 };
		}

		// Unexpected output — fall through to heuristic
	} catch {
		// Network/timeout/etc — fall through to heuristic
	}

	return classifyAdaptiveThinking(input);
}
