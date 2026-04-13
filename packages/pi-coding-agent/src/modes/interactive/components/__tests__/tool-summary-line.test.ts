import { describe, it } from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";

import { ToolSummaryLine } from "../tool-summary-line.js";
import { initTheme } from "../../theme/theme.js";

initTheme("dark");

describe("ToolSummaryLine", () => {
	it("renders action-based summaries for grouped identical tools", () => {
		const summary = new ToolSummaryLine();
		summary.addTool("read", 600);
		summary.addTool("read", 150);

		const rendered = stripAnsi(summary.render(160).join("\n"));
		assert.match(rendered, /^ ● /);
		assert.ok(rendered.includes("reading 2 files · 0.8s"));
		assert.equal(summary.canGroupWith("read"), true);
		assert.equal(summary.canGroupWith("find"), false);
		assert.equal(rendered.includes("collapsed tools"), false);
		assert.equal(rendered.includes("⎯"), false);
	});

	it("keeps fallback format for unknown tools", () => {
		const summary = new ToolSummaryLine();
		summary.addTool("custom_tool", 100);

		const rendered = stripAnsi(summary.render(160).join("\n"));
		assert.ok(rendered.includes("custom_tool · 0.1s"));
	});

	it("renders nothing when empty or hidden", () => {
		const summary = new ToolSummaryLine();
		assert.deepEqual(summary.render(80), []);

		summary.addTool("grep", 100);
		summary.setHidden(true);
		assert.deepEqual(summary.render(80), []);
	});
});
