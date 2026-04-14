import { basename } from "node:path";
import { Container, Text, type TUI } from "@gsd/pi-tui";

import { theme } from "../theme/theme.js";

interface CollapsedTool {
	name: string;
	elapsed: number;
}

interface PendingTool {
	name: string;
	label: string;
}

// Tools that can be mixed together in one summary line
const MIXED_GROUPABLE_TOOLS = new Set([
	"read", "find", "ls", "grep", "lsp",
]);

type SummaryDescriptor = {
	action: string;
	singular: string;
	plural: string;
};

const TOOL_SUMMARY_DESCRIPTORS: Record<string, SummaryDescriptor> = {
	read: { action: "reading", singular: "file", plural: "files" },
	write: { action: "editing", singular: "file", plural: "files" },
	edit: { action: "editing", singular: "file", plural: "files" },
	grep: { action: "searching for", singular: "pattern", plural: "patterns" },
	find: { action: "finding", singular: "path", plural: "paths" },
	ls: { action: "listing", singular: "directory", plural: "directories" },
	lsp: { action: "looking up", singular: "symbol", plural: "symbols" },
	bash: { action: "running", singular: "command", plural: "commands" },
	bg_shell: { action: "running", singular: "background command", plural: "background commands" },
	fetch_page: { action: "reading", singular: "page", plural: "pages" },
	resolve_library: { action: "searching for", singular: "library", plural: "libraries" },
	get_library_docs: { action: "reading", singular: "doc", plural: "docs" },
	web_search: { action: "searching web for", singular: "query", plural: "queries" },
	"search-the-web": { action: "searching web for", singular: "query", plural: "queries" },
	search_and_read: { action: "researching", singular: "topic", plural: "topics" },
	google_search: { action: "searching web for", singular: "query", plural: "queries" },
};

const SPINNER_FRAMES = ["◯", "◔", "◑", "◕", "●"];
const SPINNER_INTERVAL_MS = 150;

function formatCount(count: number, singular: string, plural: string): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

function summarizeToolGroup(name: string, count: number): string {
	if (name.startsWith("browser_")) {
		return `using browser for ${formatCount(count, "step", "steps")}`;
	}

	const descriptor = TOOL_SUMMARY_DESCRIPTORS[name];
	if (!descriptor) {
		return count > 1 ? `${name} ×${count}` : name;
	}

	return `${descriptor.action} ${formatCount(count, descriptor.singular, descriptor.plural)}`;
}

function capitalize(s: string): string {
	if (!s) return s;
	return s.charAt(0).toUpperCase() + s.slice(1);
}

export function extractToolLabel(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "read": {
			const path = (args.path ?? args.file_path) as string | undefined;
			return path ? basename(path) : toolName;
		}
		case "grep":
		case "find": {
			const pattern = args.pattern as string | undefined;
			return pattern ?? toolName;
		}
		case "ls": {
			const path = args.path as string | undefined;
			return path ? basename(path) || path : ".";
		}
		case "lsp": {
			const symbol = args.symbol as string | undefined;
			const file = args.file as string | undefined;
			if (symbol) return symbol;
			if (file) return basename(file);
			return toolName;
		}
		default:
			return toolName;
	}
}

export class ToolSummaryLine extends Container {
	private tools: CollapsedTool[] = [];
	private pendingTools: Map<string, PendingTool> = new Map();
	private hidden = false;
	private contentText: Text;
	private labelText: Text;
	private expandHint = "";
	private ui?: TUI;
	private spinnerTimer: NodeJS.Timeout | null = null;
	private spinnerFrame = 0;
	private lastToolLabel = "";

	canGroupWith(toolName: string): boolean {
		if (this.tools.length === 0 && this.pendingTools.size === 0) return true;
		const allCompletedMixed = this.tools.every((t) => MIXED_GROUPABLE_TOOLS.has(t.name));
		const allPendingMixed = [...this.pendingTools.values()].every((t) => MIXED_GROUPABLE_TOOLS.has(t.name));
		if (MIXED_GROUPABLE_TOOLS.has(toolName) && allCompletedMixed && allPendingMixed) {
			return true;
		}
		return this.tools.every((tool) => tool.name === toolName)
			&& [...this.pendingTools.values()].every((tool) => tool.name === toolName);
	}

	constructor(ui?: TUI) {
		super();
		this.ui = ui;
		this.contentText = new Text("", 1, 0);
		this.labelText = new Text("", 1, 0);
		this.addChild(this.contentText);
		this.addChild(this.labelText);
	}

	setUI(ui: TUI): void {
		this.ui = ui;
	}

	setExpandHint(hint: string): void {
		this.expandHint = hint;
		this.updateDisplay();
	}

	addPendingTool(toolCallId: string, name: string, args: Record<string, unknown>): void {
		const label = extractToolLabel(name, args);
		this.pendingTools.set(toolCallId, { name, label });
		this.lastToolLabel = label;
		this.startSpinner();
		this.updateDisplay();
	}

	removePendingTool(toolCallId: string): void {
		const removed = this.pendingTools.get(toolCallId);
		this.pendingTools.delete(toolCallId);
		if (removed) {
			this.lastToolLabel = removed.label;
		}
		if (this.pendingTools.size === 0) {
			this.stopSpinner();
		} else {
			const lastPending = [...this.pendingTools.values()].at(-1);
			if (lastPending) this.lastToolLabel = lastPending.label;
		}
		this.updateDisplay();
	}

	hasPendingTools(): boolean {
		return this.pendingTools.size > 0;
	}

	hasPendingTool(toolCallId: string): boolean {
		return this.pendingTools.has(toolCallId);
	}

	clearPendingTools(): void {
		const lastPending = [...this.pendingTools.values()].at(-1);
		if (lastPending) {
			this.lastToolLabel = lastPending.label;
		}
		this.pendingTools.clear();
		this.stopSpinner();
		this.updateDisplay();
	}

	updatePendingToolArgs(toolCallId: string, args: Record<string, unknown>): void {
		const pending = this.pendingTools.get(toolCallId);
		if (!pending) return;
		pending.label = extractToolLabel(pending.name, args);
		this.lastToolLabel = pending.label;
		this.updateDisplay();
	}

	private startSpinner(): void {
		if (this.spinnerTimer) return;
		this.spinnerTimer = setInterval(() => {
			this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
			this.updateDisplay();
			this.ui?.requestRender();
		}, SPINNER_INTERVAL_MS);
		this.spinnerTimer.unref?.();
	}

	private stopSpinner(): void {
		if (!this.spinnerTimer) return;
		clearInterval(this.spinnerTimer);
		this.spinnerTimer = null;
	}

	dispose(): void {
		this.stopSpinner();
	}

	addTool(name: string, elapsed: number): void {
		this.tools.push({ name, elapsed });
		this.updateDisplay();
	}

	setHidden(hidden: boolean): void {
		this.hidden = hidden;
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.hidden || (this.tools.length === 0 && this.pendingTools.size === 0)) {
			return [];
		}
		return super.render(width);
	}

	private updateDisplay(): void {
		if (this.tools.length === 0 && this.pendingTools.size === 0) {
			this.contentText.setText("");
			this.labelText.setText("");
			return;
		}

		if (this.pendingTools.size > 0) {
			const counts = new Map<string, number>();
			for (const tool of this.tools) {
				counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
			}
			for (const tool of this.pendingTools.values()) {
				counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
			}

			const groupedTools = [...counts.entries()]
				.map(([name, count]) => summarizeToolGroup(name, count))
				.map((value, index) => index === 0 ? capitalize(value) : value)
				.join(", ");
			const spinner = theme.fg("accent", SPINNER_FRAMES[this.spinnerFrame]);
			const hint = this.expandHint ? theme.fg("muted", ` ${this.expandHint}`) : "";
			this.contentText.setText(`${spinner} ${theme.fg("text", groupedTools)}${theme.fg("muted", "…")}${hint}`);

			const lastPending = [...this.pendingTools.values()].at(-1);
			this.labelText.setText(lastPending ? theme.fg("muted", `  └ ${lastPending.label}`) : "");
			return;
		}

		this.labelText.setText(this.lastToolLabel ? theme.fg("muted", `  └ ${this.lastToolLabel}`) : "");
		const counts = new Map<string, number>();
		let totalElapsed = 0;
		for (const tool of this.tools) {
			counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
			totalElapsed += tool.elapsed;
		}

		const groupedTools = [...counts.entries()]
			.map(([name, count]) => summarizeToolGroup(name, count))
			.join(" · ");
		const elapsed = (totalElapsed / 1000).toFixed(1);
		const indicator = theme.fg("success", "●");
		const details = theme.fg("text", groupedTools) + theme.fg("muted", ` · ${elapsed}s`);
		this.contentText.setText(`${indicator} ${details}`);
	}
}
