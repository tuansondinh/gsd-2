import { describe, it } from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";

import { ToolSummaryLine, extractToolLabel } from "../tool-summary-line.js";
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
		assert.equal(summary.canGroupWith("find"), true);
		assert.equal(summary.canGroupWith("bash"), false);
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

	it("renders spinner and label line when pending tools exist", () => {
		const summary = new ToolSummaryLine();
		summary.addPendingTool("t1", "read", { path: "src/foo/bar.ts" });

		const rendered = stripAnsi(summary.render(160).join("\n"));
		assert.ok(!rendered.startsWith(" ●"));
		assert.ok(rendered.includes("  └ bar.ts"));
		assert.ok(rendered.includes("bar.ts"));
	});

	it("keeps last tool label after pending tool completes", () => {
		const summary = new ToolSummaryLine();
		summary.addPendingTool("t1", "read", { path: "file.ts" });
		assert.equal(summary.hasPendingTools(), true);

		summary.removePendingTool("t1");
		summary.addTool("read", 500);
		assert.equal(summary.hasPendingTools(), false);

		const rendered = stripAnsi(summary.render(160).join("\n"));
		assert.ok(rendered.includes("●"));
		assert.ok(rendered.includes("0.5s"));
		assert.ok(rendered.includes("└ file.ts"));
	});

	it("aggregates completed and pending tools in summary text", () => {
		const summary = new ToolSummaryLine();
		summary.addTool("read", 300);
		summary.addPendingTool("t1", "grep", { pattern: "TODO" });

		const rendered = stripAnsi(summary.render(160).join("\n"));
		assert.ok(rendered.includes("1 file"));
		assert.ok(rendered.includes("1 pattern"));
		assert.ok(rendered.includes("…"));
		assert.ok(rendered.includes("TODO"));
	});

	it("shows expand hint when set and tools are pending", () => {
		const summary = new ToolSummaryLine();
		summary.setExpandHint("(ctrl+o to expand)");
		summary.addPendingTool("t1", "read", { path: "test.ts" });

		const rendered = stripAnsi(summary.render(160).join("\n"));
		assert.ok(rendered.includes("ctrl+o to expand"));
	});

	it("does not show expand hint when no pending tools", () => {
		const summary = new ToolSummaryLine();
		summary.setExpandHint("(ctrl+o to expand)");
		summary.addTool("read", 300);

		const rendered = stripAnsi(summary.render(160).join("\n"));
		assert.ok(!rendered.includes("ctrl+o to expand"));
	});

	it("updates label when pending tool args change", () => {
		const summary = new ToolSummaryLine();
		summary.addPendingTool("t1", "read", { path: "old.ts" });

		let rendered = stripAnsi(summary.render(160).join("\n"));
		assert.ok(rendered.includes("old.ts"));

		summary.updatePendingToolArgs("t1", { path: "new.ts" });
		rendered = stripAnsi(summary.render(160).join("\n"));
		assert.ok(rendered.includes("new.ts"));
	});

	it("clears pending spinner without removing last label", () => {
		const summary = new ToolSummaryLine();
		summary.addPendingTool("t1", "read", { path: "file.ts" });

		summary.clearPendingTools();

		const rendered = stripAnsi(summary.render(160).join("\n"));
		assert.ok(!rendered.includes("◯"));
		assert.ok(!rendered.includes("◔"));
		assert.ok(!rendered.includes("◑"));
		assert.ok(!rendered.includes("◕"));
		assert.ok(!rendered.includes("● Listing"));
		assert.ok(!rendered.includes("…"));
		assert.ok(rendered === "" || rendered.includes("file.ts"));
	});

	it("canGroupWith considers pending tools", () => {
		const summary = new ToolSummaryLine();
		summary.addPendingTool("t1", "read", { path: "a.ts" });

		assert.equal(summary.canGroupWith("read"), true);
		assert.equal(summary.canGroupWith("grep"), true);
		assert.equal(summary.canGroupWith("bash"), false);
	});
});

describe("extractToolLabel", () => {
	it("extracts basename for read tool", () => {
		assert.equal(extractToolLabel("read", { path: "src/foo/bar.ts" }), "bar.ts");
		assert.equal(extractToolLabel("read", { file_path: "/abs/path/file.json" }), "file.json");
		assert.equal(extractToolLabel("read", {}), "read");
	});

	it("extracts pattern for grep tool", () => {
		assert.equal(extractToolLabel("grep", { pattern: "TODO" }), "TODO");
		assert.equal(extractToolLabel("grep", {}), "grep");
	});

	it("extracts pattern for find tool", () => {
		assert.equal(extractToolLabel("find", { pattern: "*.ts" }), "*.ts");
		assert.equal(extractToolLabel("find", {}), "find");
	});

	it("extracts path for ls tool", () => {
		assert.equal(extractToolLabel("ls", { path: "src/components" }), "components");
		assert.equal(extractToolLabel("ls", {}), ".");
	});

	it("extracts symbol or file for lsp tool", () => {
		assert.equal(extractToolLabel("lsp", { symbol: "MyClass" }), "MyClass");
		assert.equal(extractToolLabel("lsp", { file: "src/index.ts" }), "index.ts");
		assert.equal(extractToolLabel("lsp", { symbol: "foo", file: "bar.ts" }), "foo");
		assert.equal(extractToolLabel("lsp", {}), "lsp");
	});

	it("returns tool name for unknown tools", () => {
		assert.equal(extractToolLabel("custom_tool", { whatever: "value" }), "custom_tool");
	});
});
