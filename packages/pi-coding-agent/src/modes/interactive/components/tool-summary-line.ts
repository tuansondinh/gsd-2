import { Container, Text } from "@gsd/pi-tui";

import { theme } from "../theme/theme.js";

interface CollapsedTool {
	name: string;
	elapsed: number;
}

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
	"search-the-web": { action: "searching web for", singular: "query", plural: "queries" },
	search_and_read: { action: "researching", singular: "topic", plural: "topics" },
	google_search: { action: "searching web for", singular: "query", plural: "queries" },
};

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

export class ToolSummaryLine extends Container {
	private tools: CollapsedTool[] = [];
	private hidden = false;
	private contentText: Text;

	constructor() {
		super();
		this.contentText = new Text("", 1, 0);
		this.addChild(this.contentText);
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
		if (this.hidden || this.tools.length === 0) {
			return [];
		}
		return super.render(width);
	}

	private updateDisplay(): void {
		if (this.tools.length === 0) {
			this.contentText.setText("");
			return;
		}

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
		const details = theme.fg("muted", `${groupedTools} · ${elapsed}s`);
		this.contentText.setText(`${indicator} ${details}`);
	}
}
