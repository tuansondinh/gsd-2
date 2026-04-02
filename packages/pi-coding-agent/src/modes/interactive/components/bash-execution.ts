/**
 * Component for displaying bash command execution with streaming output.
 */

import { Container, Loader, Spacer, Text, type TUI } from "@gsd/pi-tui";
import stripAnsi from "strip-ansi";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateTail,
} from "../../../core/tools/truncate.js";
import { theme, type ThemeColor } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { editorKey, keyHint } from "./keybinding-hints.js";
import { truncateToVisualLines } from "./visual-truncate.js";

// Flash interval for RTK badge animation (ms)
const RTK_FLASH_INTERVAL_MS = 400;

// Preview line limit when not expanded (matches tool execution behavior)
const PREVIEW_LINES = 20;

type ToolOutputMode = "minimal" | "normal";

export class BashExecutionComponent extends Container {
	private command: string;
	private outputLines: string[] = [];
	private status: "running" | "complete" | "cancelled" | "error" = "running";
	private exitCode: number | undefined = undefined;
	private loader: Loader;
	private truncationResult?: TruncationResult;
	private fullOutputPath?: string;
	private expanded = false;
	private renderMode: ToolOutputMode;
	private contentContainer: Container;
	private ui: TUI;
	private colorKey: ThemeColor;
	private rtkActive: boolean;
	private rtkFlashOn = true;
	private rtkFlashTimer: NodeJS.Timeout | null = null;
	// Dedicated header node — updated in-place to avoid full container rebuild on flash tick
	private headerText: Text;

	constructor(command: string, ui: TUI, excludeFromContext = false, renderMode: ToolOutputMode = "normal", rtkActive = false) {
		super();
		this.command = command;
		this.ui = ui;
		this.renderMode = renderMode;
		this.rtkActive = rtkActive;

		// Use dim border for excluded-from-context commands (!! prefix)
		this.colorKey = (excludeFromContext ? "dim" : "bashMode") as ThemeColor;
		const borderColor = (str: string) => theme.fg(this.colorKey, str);

		// Add spacer
		this.addChild(new Spacer(1));

		// Top border
		this.addChild(new DynamicBorder(borderColor));

		// Content container (holds dynamic content between borders)
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		// Dedicated header Text node — updated directly for flash without full rebuild
		this.headerText = new Text(this.buildHeaderText(), 1, 0);
		this.contentContainer.addChild(this.headerText);

		// Loader
		this.loader = new Loader(
			ui,
			(spinner) => theme.fg(this.colorKey, spinner),
			(text) => theme.fg("muted", text),
			`Running... (${editorKey("selectCancel")} to cancel)`, // Plain text for loader
		);
		this.contentContainer.addChild(this.loader);

		// Bottom border
		this.addChild(new DynamicBorder(borderColor));

		// Start RTK flash animation if active
		if (this.rtkActive) {
			this.rtkFlashTimer = setInterval(() => {
				this.rtkFlashOn = !this.rtkFlashOn;
				// Only update the header node — no full container rebuild
				this.headerText.setText(this.buildHeaderText());
				this.ui.requestRender();
			}, RTK_FLASH_INTERVAL_MS);
		}
	}

	/** Build the header line text including the RTK badge when active. */
	private buildHeaderText(): string {
		let text = theme.fg(this.colorKey, theme.bold(`$ ${this.command}`));
		if (this.rtkActive) {
			const badge = this.rtkFlashOn
				? theme.fg("accent", "$ RTK")
				: theme.fg("dim", "$ RTK");
			text = `${text}  ${badge}`;
		}
		return text;
	}

	/**
	 * Stop all timers and release resources. Call when removing the component
	 * from the tree before setComplete() has been called (e.g. on clear/cancel).
	 */
	dispose(): void {
		if (this.rtkFlashTimer) {
			clearInterval(this.rtkFlashTimer);
			this.rtkFlashTimer = null;
		}
		this.loader.dispose();
	}

	/**
	 * Set whether the output is expanded (shows full output) or collapsed (preview only).
	 */
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setRenderMode(mode: ToolOutputMode): void {
		if (this.renderMode !== mode) {
			this.renderMode = mode;
			this.updateDisplay();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	appendOutput(chunk: string): void {
		// Strip ANSI codes and normalize line endings
		// Note: binary data is already sanitized in tui-renderer.ts executeBashCommand
		const clean = stripAnsi(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

		// Append to output lines
		const newLines = clean.split("\n");
		if (this.outputLines.length > 0 && newLines.length > 0) {
			// Append first chunk to last line (incomplete line continuation)
			this.outputLines[this.outputLines.length - 1] += newLines[0];
			this.outputLines.push(...newLines.slice(1));
		} else {
			this.outputLines.push(...newLines);
		}

		this.updateDisplay();
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		truncationResult?: TruncationResult,
		fullOutputPath?: string,
	): void {
		this.exitCode = exitCode;
		this.status = cancelled
			? "cancelled"
			: exitCode !== 0 && exitCode !== undefined && exitCode !== null
				? "error"
				: "complete";
		this.truncationResult = truncationResult;
		this.fullOutputPath = fullOutputPath;

		// Stop loader
		this.loader.stop();

		// Stop RTK flash — settle to steady dim state
		if (this.rtkFlashTimer) {
			clearInterval(this.rtkFlashTimer);
			this.rtkFlashTimer = null;
			this.rtkFlashOn = false;
			// Final header update to ensure dim badge is shown
			this.headerText.setText(this.buildHeaderText());
		}

		this.updateDisplay();
	}

	private updateDisplay(): void {
		// Apply truncation for LLM context limits (same limits as bash tool)
		const fullOutput = this.outputLines.join("\n");
		const contextTruncation = truncateTail(fullOutput, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});

		// Get the lines to potentially display (after context truncation)
		const availableLines = contextTruncation.content ? contextTruncation.content.split("\n") : [];

		// Apply preview truncation based on expanded state
		const previewLogicalLines = availableLines.slice(-PREVIEW_LINES);
		const hiddenLineCount = availableLines.length - previewLogicalLines.length;

		// Rebuild content container
		this.contentContainer.clear();

		// Header — re-add the dedicated node (clear() removed it, setText keeps its current value)
		this.contentContainer.addChild(this.headerText);

		// Output
		if (availableLines.length > 0) {
			if (this.expanded) {
				// Show all lines
				const displayText = availableLines.map((line) => theme.fg("muted", line)).join("\n");
				this.contentContainer.addChild(new Text(`\n${displayText}`, 1, 0));
			} else if (this.renderMode === "minimal") {
				this.contentContainer.addChild(new Text(`\n${theme.fg("muted", `(${keyHint("expandTools", "to expand")})`)}`, 1, 0));
			} else {
				// Use shared visual truncation utility
				const styledOutput = previewLogicalLines.map((line) => theme.fg("muted", line)).join("\n");
				const { visualLines } = truncateToVisualLines(
					`\n${styledOutput}`,
					PREVIEW_LINES,
					this.ui.terminal.columns,
					1, // padding
				);
				this.contentContainer.addChild({ render: () => visualLines, invalidate: () => {} });
			}
		}

		// Loader or status
		if (this.status === "running") {
			this.contentContainer.addChild(this.loader);
		} else {
			const statusParts: string[] = [];

			// Show how many lines are hidden (collapsed preview)
			if (hiddenLineCount > 0) {
				if (this.expanded) {
					statusParts.push(`(${keyHint("expandTools", "to collapse")})`);
				} else {
					statusParts.push(
						`${theme.fg("muted", `... ${hiddenLineCount} more lines`)} (${keyHint("expandTools", "to expand")})`,
					);
				}
			}

			if (this.status === "cancelled") {
				statusParts.push(theme.fg("warning", "(cancelled)"));
			} else if (this.status === "error") {
				statusParts.push(theme.fg("error", `(exit ${this.exitCode})`));
			}

			// Add truncation warning (context truncation, not preview truncation)
			const wasTruncated = this.truncationResult?.truncated || contextTruncation.truncated;
			if (wasTruncated && this.fullOutputPath) {
				statusParts.push(theme.fg("warning", `Output truncated. Full output: ${this.fullOutputPath}`));
			}

			if (statusParts.length > 0) {
				this.contentContainer.addChild(new Text(`\n${statusParts.join("\n")}`, 1, 0));
			}
		}
	}

	/**
	 * Get the raw output for creating BashExecutionMessage.
	 */
	getOutput(): string {
		return this.outputLines.join("\n");
	}

	/**
	 * Get the command that was executed.
	 */
	getCommand(): string {
		return this.command;
	}
}
