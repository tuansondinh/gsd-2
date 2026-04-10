/**
 * Request User Input — LLM tool for asking the user questions
 *
 * Thin wrapper around the shared interview-ui. The LLM presents 1-3
 * questions with 2-3 options each. Each question can be single-select (default)
 * or multi-select (allowMultiple: true). A free-form "None of the above" option
 * is added automatically to single-select questions.
 *
 * Based on: https://github.com/openai/codex (codex-rs/core/src/tools/handlers/ask_user_questions.rs)
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { sanitizeError } from "./shared/sanitize.js";
import { Text } from "@gsd/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	showInterviewRound,
	type Question,
	type QuestionOption,
	type RoundResult,
} from "./shared/tui.js";
import { isTelegramLiveRelayConnected } from "./remote-questions/telegram-live-relay.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface LocalResultDetails {
	remote?: false;
	questions: Question[];
	response: RoundResult | null;
	cancelled: boolean;
}

interface RemoteResultDetails {
	remote: true;
	channel: string;
	timed_out: boolean;
	promptId?: string;
	threadUrl?: string;
	status?: string;
	questions?: Question[];
	response?: import("./remote-questions/types.js").RemoteAnswer;
	error?: boolean;
}

type AskUserQuestionsDetails = LocalResultDetails | RemoteResultDetails;

// ─── Schema ───────────────────────────────────────────────────────────────────

const OptionSchema = Type.Object({
	label: Type.String({ description: "User-facing label (1-5 words)" }),
	description: Type.String({ description: "One short sentence explaining impact/tradeoff if selected" }),
});

const ShowWhenSchema = Type.Object({
	questionId: Type.String({ description: "Earlier question id this question depends on" }),
	selectedAnyOf: Type.Array(Type.String(), {
		description: "Show this question only when the earlier question selection includes one of these labels",
		minItems: 1,
	}),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Stable identifier for mapping answers (snake_case)" }),
	header: Type.String({ description: "Short header label shown in the UI (12 or fewer chars)" }),
	question: Type.String({ description: "Single-sentence prompt shown to the user" }),
	options: Type.Array(OptionSchema, {
		description:
			'Provide 2-3 mutually exclusive choices for single-select, or any number for multi-select. Put the recommended option first and suffix its label with "(Recommended)". Do not include an "Other" option for single-select; the client adds a free-form "None of the above" option automatically.',
	}),
	allowMultiple: Type.Optional(
		Type.Boolean({
			description:
				"If true, the user can select multiple options using SPACE to toggle and ENTER to confirm. No 'None of the above' option is added. Default: false.",
		}),
	),
	showWhen: Type.Optional(ShowWhenSchema),
});

const AskUserQuestionsParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		description: "Questions to show the user. Prefer 1 and do not exceed 3.",
	}),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const OTHER_OPTION_LABEL = "None of the above";

function errorResult(
	message: string,
	questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: AskUserQuestionsDetails } {
	return {
		content: [{ type: "text", text: sanitizeError(message) }],
		details: { questions, response: null, cancelled: true },
	};
}

/** Convert the shared RoundResult into the JSON the LLM expects. */
function selectedLabels(answer: { answers: string[] } | undefined): string[] {
	if (!answer) return [];
	return answer.answers.filter((item) => typeof item === "string" && !item.startsWith("user_note:"));
}

function shouldAskQuestion(
	question: Question,
	answers: Record<string, { answers: string[] }>,
): boolean {
	if (!question.showWhen) return true;
	const controlling = answers[question.showWhen.questionId];
	if (!controlling) return false;
	const selected = selectedLabels(controlling);
	return selected.some((label) => question.showWhen?.selectedAnyOf.includes(label));
}

function selectedRoundLabels(answer: { selected: string | string[]; notes: string } | undefined): string[] {
	if (!answer) return [];
	return (Array.isArray(answer.selected) ? answer.selected : [answer.selected]).filter(
		(item): item is string => typeof item === "string" && item.length > 0,
	);
}

function shouldRenderRoundQuestion(
	question: Question,
	answers: RoundResult["answers"],
): boolean {
	if (!question.showWhen) return true;
	const controlling = answers[question.showWhen.questionId];
	if (!controlling) return false;
	const selected = selectedRoundLabels(controlling);
	return selected.some((label) => question.showWhen?.selectedAnyOf.includes(label));
}

function formatForLLM(result: RoundResult): string {
	const answers: Record<string, { answers: string[] }> = {};
	for (const [id, answer] of Object.entries(result.answers)) {
		const list: string[] = [];
		if (Array.isArray(answer.selected)) {
			list.push(...answer.selected);
		} else {
			list.push(answer.selected);
		}
		if (answer.notes) {
			list.push(`user_note: ${answer.notes}`);
		}
		answers[id] = { answers: list };
	}
	return JSON.stringify({ answers });
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function AskUserQuestions(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_questions",
		label: "Request User Input",
		description:
			"Request user input for one to three short questions and wait for the response. Single-select questions have 2-3 mutually exclusive options with a free-form 'None of the above' added automatically. Multi-select questions (allowMultiple: true) let the user toggle multiple options with SPACE and confirm with ENTER.",
		promptGuidelines: [
			"Use ask_user_questions when you need the user to choose between concrete alternatives before proceeding.",
			"Keep questions to 1 when possible; never exceed 3.",
			"For single-select: each question must have 2-3 options. Put the recommended option first with '(Recommended)' suffix. Do not include an 'Other' or 'None of the above' option - the client adds one automatically.",
			"For multi-select: set allowMultiple: true. The user can pick any number of options. No 'None of the above' is added.",
			"For conditional follow-ups, use showWhen.questionId and showWhen.selectedAnyOf on a later question so it only appears after the matching earlier answer.",
		],
		parameters: AskUserQuestionsParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// Validation
			if (params.questions.length === 0 || params.questions.length > 3) {
				return errorResult("Error: questions must contain 1-3 items", params.questions);
			}

			for (const q of params.questions) {
				if (!q.options || q.options.length === 0) {
					return errorResult(
						`Error: ask_user_questions requires non-empty options for every question (question "${q.id}" has none)`,
						params.questions,
					);
				}
			}

			for (let i = 0; i < params.questions.length; i++) {
				const q = params.questions[i];
				if (!q.showWhen) continue;
				const controllerIndex = params.questions.findIndex((candidate) => candidate.id === q.showWhen?.questionId);
				if (controllerIndex < 0 || controllerIndex >= i) {
					return errorResult(
						`Error: question "${q.id}" has invalid showWhen.questionId "${q.showWhen.questionId}" (must reference an earlier question id)`,
						params.questions,
					);
				}
				if (!q.showWhen.selectedAnyOf || q.showWhen.selectedAnyOf.length === 0) {
					return errorResult(
						`Error: question "${q.id}" showWhen.selectedAnyOf must include at least one option label`,
						params.questions,
					);
				}
				const controller = params.questions[controllerIndex];
				const validLabels = [
					...controller.options.map((option) => option.label),
					...(!controller.allowMultiple ? [OTHER_OPTION_LABEL] : []),
				];
				const invalidLabels = q.showWhen.selectedAnyOf.filter((label) => !validLabels.includes(label));
				if (invalidLabels.length > 0) {
					return errorResult(
						`Error: question "${q.id}" showWhen.selectedAnyOf contains unknown option labels: ${invalidLabels.join(", ")}`,
						params.questions,
					);
				}
			}

			// Subagents have no human to respond — fail fast and tell the model to decide autonomously.
			if (process.argv.includes('--subagent-name')) {
				return errorResult(
					"Error: ask_user_questions cannot be used inside a subagent. " +
					"There is no human available. Make a reasonable autonomous decision and proceed.",
					params.questions,
				);
			}

			if (!ctx.hasUI) {
				return errorResult("Error: UI not available (non-interactive mode)", params.questions);
			}

			// Delegate to shared interview UI
			const preferSequentialPrompts = isTelegramLiveRelayConnected();
			const result = preferSequentialPrompts ? undefined : await showInterviewRound(params.questions, {}, ctx as any);

			// RPC mode fallback: custom() returns undefined, so showInterviewRound
			// may return undefined. Fall back to sequential ctx.ui.select() calls.
			if (!result) {
				const answers: Record<string, { answers: string[] }> = {};
				for (const q of params.questions) {
					if (!shouldAskQuestion(q, answers)) {
						continue;
					}
					const options = q.options.map((o) => o.label);
					if (!q.allowMultiple) {
						options.push(OTHER_OPTION_LABEL);
					}
					const selected = await ctx.ui.select(
						`${q.header}: ${q.question}`,
						options,
						{ signal, ...(q.allowMultiple ? { allowMultiple: true } : {}) },
					);
					if (selected === undefined) {
						return errorResult("ask_user_questions was cancelled", params.questions);
					}

					// When the user picks "None of the above" on a single-select
					// question, prompt for a free-text explanation so they are not
					// trapped in a re-asking loop (bug #2715).
					let freeTextNote = "";
					const selectedStr = Array.isArray(selected) ? selected[0] : selected;
					if (!q.allowMultiple && selectedStr === OTHER_OPTION_LABEL) {
						const note = await ctx.ui.input(
							`${q.header}: Please explain in your own words`,
							"Type your answer here…",
						);
						if (note) {
							freeTextNote = note;
						}
					}

					const answerList = Array.isArray(selected) ? selected : [selected];
					if (freeTextNote) {
						answerList.push(`user_note: ${freeTextNote}`);
					}
					answers[q.id] = { answers: answerList };
				}
				const roundResult: RoundResult = {
					endInterview: false,
					answers: Object.fromEntries(
						Object.entries(answers).map(([id, a]) => [
							id,
							{ selected: a.answers.length === 1 ? a.answers[0] : a.answers, notes: "" },
						]),
					),
				};
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ answers }) }],
					details: {
						questions: params.questions,
						response: roundResult,
						cancelled: false,
					} satisfies LocalResultDetails,
				};
			}

			// Check if cancelled (empty answers = user exited)
			const hasAnswers = Object.keys(result.answers).length > 0;
			if (!hasAnswers) {
				return {
					content: [{ type: "text", text: "ask_user_questions was cancelled before receiving a response" }],
					details: { questions: params.questions, response: null, cancelled: true } satisfies LocalResultDetails,
				};
			}

			return {
				content: [{ type: "text", text: formatForLLM(result) }],
				details: { questions: params.questions, response: result, cancelled: false } satisfies LocalResultDetails,
			};
		},

		// ─── Rendering ────────────────────────────────────────────────────────

		renderCall(args, theme) {
			const qs = (args.questions as Question[]) || [];
			let text = theme.fg("toolTitle", theme.bold("ask_user_questions "));
			text += theme.fg("muted", `${qs.length} question${qs.length !== 1 ? "s" : ""}`);
			if (qs.length > 0) {
				const headers = qs.map((q) => q.header).join(", ");
				text += theme.fg("dim", ` (${headers})`);
			}
			for (const q of qs) {
				const multiSel = !!q.allowMultiple;
				text += `\n  ${theme.fg("text", q.question)}`;
				const optLabels = multiSel
					? (q.options || []).map((o: QuestionOption) => o.label)
					: [...(q.options || []).map((o: QuestionOption) => o.label), OTHER_OPTION_LABEL];
				const prefix = multiSel ? "☐" : "";
				const numbered = optLabels.map((l, i) => `${prefix}${i + 1}. ${l}`).join(", ");
				text += `\n  ${theme.fg("dim", numbered)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskUserQuestionsDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			// Remote channel result (discriminated on details.remote === true)
			if (details.remote) {
				if (details.timed_out) {
					return new Text(
						`${theme.fg("warning", `${details.channel} — timed out`)}${details.threadUrl ? theme.fg("dim", ` ${details.threadUrl}`) : ""}`,
						0,
						0,
					);
				}

				const questions = (details.questions ?? []) as Question[];
				const lines: string[] = [];
				lines.push(theme.fg("dim", details.channel));
				if (details.response) {
					for (const q of questions) {
						if (!shouldAskQuestion(q, details.response.answers)) continue;
						const answer = details.response.answers[q.id];
						if (!answer) {
							lines.push(`${theme.fg("accent", q.header)}: ${theme.fg("dim", "(no answer)")}`);
							continue;
						}
						const answerText = answer.answers.length > 0 ? answer.answers.join(", ") : "(custom)";
						let line = `${theme.fg("success", "✓ ")}${theme.fg("accent", q.header)}: ${answerText}`;
						if (answer.user_note) {
							line += ` ${theme.fg("muted", `[note: ${answer.user_note}]`)}`;
						}
						lines.push(line);
					}
				}
				return new Text(lines.join("\n"), 0, 0);
			}

			if (details.cancelled || !details.response) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			const lines: string[] = [];
			for (const q of details.questions) {
				if (!shouldRenderRoundQuestion(q, details.response.answers)) continue;
				const answer = (details.response as RoundResult).answers[q.id];
				if (!answer) {
					lines.push(`${theme.fg("accent", q.header)}: ${theme.fg("dim", "(no answer)")}`);
					continue;
				}
				const selected = answer.selected;
				const notes = answer.notes;
				const multiSel = !!q.allowMultiple;
				const answerText = multiSel && Array.isArray(selected)
					? selected.join(", ")
					: (Array.isArray(selected) ? selected[0] : selected) ?? "(no answer)";
				let line = `${theme.fg("success", "✓ ")}${theme.fg("accent", q.header)}: ${answerText}`;
				if (notes) {
					line += ` ${theme.fg("muted", `[note: ${notes}]`)}`;
				}
				lines.push(line);
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
