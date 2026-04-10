import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { showConfirm } from "../confirm-ui.js";
import { showInterviewRound } from "../interview-ui.js";
import { collectOneSecretWithGuidance, showSecretsSummary } from "../../get-secrets-from-user.js";

describe("custom UI fallback paths", () => {
	it("showConfirm falls back to select when custom UI is unavailable", async () => {
		const selectCalls: Array<{ title: string; options: string[] }> = [];
		const ctx = {
			hasUI: true,
			ui: {
				custom: async () => undefined,
				select: async (title: string, options: string[]) => {
					selectCalls.push({ title, options });
					return "Yes";
				},
			},
		};

		const confirmed = await showConfirm(ctx as any, {
			title: "Dangerous action",
			message: "Continue?",
			confirmLabel: "Yes",
			declineLabel: "No",
		});

		assert.equal(confirmed, true);
		assert.equal(selectCalls.length, 1);
		assert.equal(selectCalls[0]?.title, "Dangerous action: Continue?");
		assert.deepEqual(selectCalls[0]?.options, ["Yes", "No"]);
	});

	it("showInterviewRound falls back to sequential select/input", async () => {
		const selectCalls: Array<{ title: string; options: string[] }> = [];
		const inputCalls: Array<{ title: string; placeholder?: string }> = [];
		const ctx = {
			hasUI: true,
			ui: {
				custom: async () => undefined,
				select: async (title: string, options: string[]) => {
					selectCalls.push({ title, options });
					return "None of the above";
				},
				input: async (title: string, placeholder?: string) => {
					inputCalls.push({ title, placeholder });
					return "My custom answer";
				},
			},
		};

		const result = await showInterviewRound(
			[
				{
					id: "q1",
					header: "Q1",
					question: "Choose one",
					options: [
						{ label: "A", description: "opt A" },
						{ label: "B", description: "opt B" },
					],
				},
			],
			{},
			ctx as any,
		);

		assert.equal(selectCalls.length, 1);
		assert.ok(selectCalls[0]?.options.includes("None of the above"));
		assert.equal(inputCalls.length, 1);
		assert.equal(result.answers.q1?.selected, "None of the above");
		assert.equal(result.answers.q1?.notes, "My custom answer");
	});

	it("showInterviewRound skips conditional question when condition is not met", async () => {
		const selectCalls: Array<{ title: string; options: string[] }> = [];
		const ctx = {
			hasUI: true,
			ui: {
				custom: async () => undefined,
				select: async (title: string, options: string[]) => {
					selectCalls.push({ title, options });
					if (title.startsWith("Q1:")) return "Review";
					return options[0];
				},
				input: async () => "",
			},
		};

		const result = await showInterviewRound(
			[
				{
					id: "q1",
					header: "Q1",
					question: "Approve?",
					options: [
						{ label: "Approve", description: "approve" },
						{ label: "Review", description: "review" },
					],
				},
				{
					id: "q2",
					header: "Q2",
					question: "Mode?",
					options: [
						{ label: "Auto", description: "auto" },
						{ label: "Bypass", description: "bypass" },
					],
					showWhen: { questionId: "q1", selectedAnyOf: ["Approve"] },
				},
			],
			{},
			ctx as any,
		);

		assert.equal(selectCalls.length, 1, "conditional question should be skipped in fallback mode");
		assert.equal(result.answers.q1?.selected, "Review");
		assert.equal(result.answers.q2, undefined);
	});

	it("collectOneSecret respects null from secure UI and does not fall back to plaintext input", async () => {
		let inputCalls = 0;
		const notifications: Array<{ message: string; type?: string }> = [];
		const ctx = {
			hasUI: true,
			ui: {
				custom: async () => null,
				input: async () => {
					inputCalls += 1;
					return "should-not-be-called";
				},
				notify: (message: string, type?: string) => {
					notifications.push({ message, type });
				},
			},
		};

		const result = await collectOneSecretWithGuidance(ctx as any, 0, 1, "OPENAI_API_KEY", "starts with sk-", []);
		assert.equal(result, null);
		assert.equal(inputCalls, 0);
		assert.equal(notifications.length, 0);
	});

	it("collectOneSecret warns and skips when secure UI is unavailable", async () => {
		let inputCalls = 0;
		const notifications: Array<{ message: string; type?: string }> = [];
		const ctx = {
			hasUI: true,
			ui: {
				custom: async () => undefined,
				input: async () => {
					inputCalls += 1;
					return "should-not-be-called";
				},
				notify: (message: string, type?: string) => {
					notifications.push({ message, type });
				},
			},
		};

		const result = await collectOneSecretWithGuidance(ctx as any, 0, 1, "OPENAI_API_KEY", "starts with sk-", []);
		assert.equal(result, null);
		assert.equal(inputCalls, 0);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0]?.message ?? "", /Secure input UI unavailable/);
		assert.equal(notifications[0]?.type, "warning");
	});

	it("showSecretsSummary does not double-render when custom UI handles dismissal", async () => {
		let notifyCalls = 0;
		const ctx = {
			hasUI: true,
			ui: {
				custom: async () => true,
				notify: () => {
					notifyCalls += 1;
				},
			},
		};

		await showSecretsSummary(
			ctx as any,
			[
				{ key: "OPENAI_API_KEY", status: "collected" },
				{ key: "ANTHROPIC_API_KEY", status: "skipped" },
			] as any,
			[],
		);

		assert.equal(notifyCalls, 0);
	});
});
