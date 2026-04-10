import type { ExtensionCommandContext, Theme } from "@gsd/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@gsd/pi-tui";
import type { AgentSwitchTarget } from "./agent-switcher-model.js";

const MAX_VISIBLE_ROWS = 10;

function stateIcon(theme: Theme, target: AgentSwitchTarget): string {
	if (target.kind === "parent") return theme.fg("accent", "●");
	if (target.state === "running") return theme.fg("warning", "▶");
	if (target.state === "failed") return theme.fg("error", "✗");
	return theme.fg("success", "✓");
}

function stateBadge(theme: Theme, target: AgentSwitchTarget): string {
	if (target.kind === "parent") return theme.fg("muted", "parent");
	if (target.state === "running") return theme.fg("warning", "running");
	if (target.state === "failed") return theme.fg("error", "failed");
	return theme.fg("success", "completed");
}

function plainLabel(target: AgentSwitchTarget): string {
	if (target.kind === "parent") {
		const currentSuffix = target.isCurrent ? " (current)" : "";
		return `● parent — main session${currentSuffix}`;
	}
	const icon = target.state === "running" ? "▶" : target.state === "failed" ? "✗" : "✓";
	const currentSuffix = target.isCurrent ? " (current)" : "";
	return `${icon} ${target.agentName} — ${target.taskPreview}${currentSuffix}`;
}

class AgentSwitcherComponent {
	private readonly tui: { requestRender: () => void };
	private readonly theme: Theme;
	private readonly targets: AgentSwitchTarget[];
	private readonly done: (result: AgentSwitchTarget | undefined) => void;
	private selectedIndex: number;
	private statusLine: string | undefined;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		tui: { requestRender: () => void },
		theme: Theme,
		targets: AgentSwitchTarget[],
		done: (result: AgentSwitchTarget | undefined) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.targets = targets;
		this.done = done;
		this.selectedIndex = this.getInitialSelectionIndex();
	}

	private getInitialSelectionIndex(): number {
		const firstSwitchable = this.targets.findIndex((target) => target.selectionAction !== "blocked");
		return firstSwitchable >= 0 ? firstSwitchable : 0;
	}

	private move(delta: number): void {
		if (this.targets.length === 0) return;
		const next = Math.max(0, Math.min(this.targets.length - 1, this.selectedIndex + delta));
		if (next === this.selectedIndex) return;
		this.selectedIndex = next;
		this.statusLine = undefined;
		this.invalidate();
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.move(1);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.move(-MAX_VISIBLE_ROWS);
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.move(MAX_VISIBLE_ROWS);
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
			const selected = this.targets[this.selectedIndex];
			if (!selected) {
				this.done(undefined);
				return;
			}
			if (selected.selectionAction === "blocked") {
				this.statusLine = selected.blockedReason ?? "This row cannot be selected yet.";
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			this.done(selected);
		}
	}

	private getVisibleWindow(): { start: number; end: number } {
		if (this.targets.length <= MAX_VISIBLE_ROWS) return { start: 0, end: this.targets.length };
		const half = Math.floor(MAX_VISIBLE_ROWS / 2);
		let start = Math.max(0, this.selectedIndex - half);
		let end = Math.min(this.targets.length, start + MAX_VISIBLE_ROWS);
		if (end - start < MAX_VISIBLE_ROWS) {
			start = Math.max(0, end - MAX_VISIBLE_ROWS);
		}
		return { start, end };
	}

	private renderRow(target: AgentSwitchTarget, isSelected: boolean, width: number): string {
		const cursor = isSelected ? this.theme.fg("accent", "▸") : " ";
		const icon = stateIcon(this.theme, target);
		const baseLabel = target.kind === "parent"
			? "parent — main session"
			: `${target.agentName} — ${target.taskPreview}`;
		const currentTag = target.isCurrent ? this.theme.fg("accent", "(current)") : "";
		const badge = stateBadge(this.theme, target);
		const right = [currentTag, badge].filter(Boolean).join(" ");

		const leftRaw = `${cursor} ${icon} ${baseLabel}`;
		const rightWidth = right ? visibleWidth(right) + 1 : 0;
		const maxLeft = Math.max(10, width - 4 - rightWidth);
		const left = truncateToWidth(leftRaw, maxLeft, "…");
		const spacing = Math.max(1, width - 4 - visibleWidth(left) - visibleWidth(right));
		const composed = `${left}${" ".repeat(spacing)}${right}`;

		if (!isSelected) {
			if (target.selectionAction === "blocked") return this.theme.fg("dim", composed);
			return composed;
		}
		return this.theme.bold(composed);
	}

	private box(inner: string[], width: number): string[] {
		const bdr = (s: string) => this.theme.fg("borderMuted", s);
		const iw = width - 4;
		const lines: string[] = [];
		lines.push(bdr("╭" + "─".repeat(width - 2) + "╮"));
		for (const line of inner) {
			const truncated = truncateToWidth(line, iw, "…");
			const pad = Math.max(0, iw - visibleWidth(truncated));
			lines.push(bdr("│") + " " + truncated + " ".repeat(pad) + " " + bdr("│"));
		}
		lines.push(bdr("╰" + "─".repeat(width - 2) + "╯"));
		return lines;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const inner: string[] = [];
		inner.push(this.theme.bold(this.theme.fg("accent", "Agent session switcher")));
		inner.push(this.theme.fg("dim", "Parent + tracked subagents"));
		inner.push("");

		if (this.targets.length === 0) {
			inner.push(this.theme.fg("dim", "No switch targets available."));
		} else {
			const { start, end } = this.getVisibleWindow();
			for (let i = start; i < end; i++) {
				inner.push(this.renderRow(this.targets[i]!, i === this.selectedIndex, width));
			}
			if (start > 0 || end < this.targets.length) {
				inner.push("");
				inner.push(this.theme.fg("dim", `${this.selectedIndex + 1}/${this.targets.length}`));
			}
		}

		inner.push("");
		const actionHint = this.targets[this.selectedIndex]?.selectionAction === "attach_live"
			? "Enter attach live"
			: "Enter switch";
		inner.push(this.theme.fg("dim", `${actionHint} · Esc cancel`));
		if (this.statusLine) {
			inner.push(this.theme.fg("warning", this.statusLine));
		}

		this.cachedLines = this.box(inner, width);
		this.cachedWidth = width;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export async function showAgentSwitcher(
	ctx: ExtensionCommandContext,
	targets: AgentSwitchTarget[],
): Promise<AgentSwitchTarget | undefined> {
	const result = await ctx.ui.custom<AgentSwitchTarget | undefined>(
		(tui, theme, _kb, done) => new AgentSwitcherComponent(tui, theme, targets, done),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "65%",
				minWidth: 60,
				maxHeight: "70%",
			},
		},
	);

	if (result !== undefined && result !== null) {
		return result;
	}

	if (targets.length === 0) return undefined;
	const labels = targets.map((target, index) => `${index + 1}. ${plainLabel(target)}`);
	const selected = await ctx.ui.select("Switch agent session", labels);
	if (!selected || Array.isArray(selected)) return undefined;
	const selectedIndex = labels.indexOf(selected);
	if (selectedIndex < 0) return undefined;
	const target = targets[selectedIndex]!;
	if (target.selectionAction === "blocked") {
		ctx.ui.notify(target.blockedReason ?? "That target is not selectable yet.", "warning");
		return undefined;
	}
	return target;
}
