import * as Diff from "diff";
import chalk from "chalk";
import { theme } from "../theme/theme.js";

const DIFF_BG = {
	addedLine: "#0f2f1a",
	removedLine: "#3a1116",
	addedToken: "#1b5e20",
	removedToken: "#7f1d1d",
} as const;

/**
 * Parse diff line to extract prefix, line number, and content.
 * Format: "+123 content" or "-123 content" or " 123 content" or "     ..."
 */
function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

/**
 * Replace tabs with spaces for consistent rendering.
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function formatLineNum(raw: string, width: number): string {
	const trimmed = raw.trim();
	if (!trimmed) return "".padStart(width, " ");
	return trimmed.padStart(width, " ");
}

function styleRemovedToken(value: string): string {
	return chalk.bgHex(DIFF_BG.removedToken)(theme.bold(value));
}

function styleAddedToken(value: string): string {
	return chalk.bgHex(DIFF_BG.addedToken)(theme.bold(value));
}

function styleAddedLine(text: string): string {
	return chalk.bgHex(DIFF_BG.addedLine)(theme.fg("toolDiffAdded", text));
}

function styleRemovedLine(text: string): string {
	return chalk.bgHex(DIFF_BG.removedLine)(theme.fg("toolDiffRemoved", text));
}

/**
 * Compute word-level diff and render changed tokens with subtle emphasis.
 * Uses diffWords which groups whitespace with adjacent words for cleaner highlighting.
 * Strips leading whitespace from highlighted token spans.
 */
function renderIntraLineDiff(oldContent: string, newContent: string): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWords(oldContent, newContent);

	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;

	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				removedLine += leadingWs;
				isFirstRemoved = false;
			}
			if (value) {
				removedLine += styleRemovedToken(value);
			}
		} else if (part.added) {
			let value = part.value;
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				addedLine += leadingWs;
				isFirstAdded = false;
			}
			if (value) {
				addedLine += styleAddedToken(value);
			}
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}

	return { removedLine, addedLine };
}

export interface RenderDiffOptions {
	/** File path (unused, kept for API compatibility) */
	filePath?: string;
}

/**
 * Render a diff string with Claude-like colored lines.
 * - Context lines: muted gray
 * - Removed lines: red text on subtle red background
 * - Added lines: green text on subtle green background
 * - Changed tokens: slightly stronger background + bold
 */
export function renderDiff(diffText: string, _options: RenderDiffOptions = {}): string {
	const lines = diffText.split("\n");
	const result: string[] = [];

	const parsedLines = lines.map(parseDiffLine).filter((p): p is { prefix: string; lineNum: string; content: string } => !!p);
	const lineNumWidth = Math.max(
		1,
		...parsedLines
			.map((p) => p.lineNum.trim())
			.filter(Boolean)
			.map((n) => n.length),
	);

	const formatLine = (prefix: "+" | "-" | " ", lineNum: string, content: string): string => {
		const num = formatLineNum(lineNum, lineNumWidth);
		return `${prefix}${num} ${replaceTabs(content)}`;
	};

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const parsed = parseDiffLine(line);

		if (!parsed) {
			result.push(theme.fg("toolDiffContext", line));
			i++;
			continue;
		}

		if (parsed.prefix === "-") {
			const removedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "-") break;
				removedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			const addedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "+") break;
				addedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			if (removedLines.length === 1 && addedLines.length === 1) {
				const removed = removedLines[0];
				const added = addedLines[0];

				const { removedLine, addedLine } = renderIntraLineDiff(
					replaceTabs(removed.content),
					replaceTabs(added.content),
				);

				result.push(styleRemovedLine(formatLine("-", removed.lineNum, removedLine)));
				result.push(styleAddedLine(formatLine("+", added.lineNum, addedLine)));
			} else {
				for (const removed of removedLines) {
					result.push(styleRemovedLine(formatLine("-", removed.lineNum, removed.content)));
				}
				for (const added of addedLines) {
					result.push(styleAddedLine(formatLine("+", added.lineNum, added.content)));
				}
			}
		} else if (parsed.prefix === "+") {
			result.push(styleAddedLine(formatLine("+", parsed.lineNum, parsed.content)));
			i++;
		} else {
			result.push(theme.fg("toolDiffContext", formatLine(" ", parsed.lineNum, parsed.content)));
			i++;
		}
	}

	return result.join("\n");
}
