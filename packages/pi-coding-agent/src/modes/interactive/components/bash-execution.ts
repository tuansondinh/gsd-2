/**
 * Component for displaying bash command execution with streaming output.
 */

import { Container, Loader, Text, type TUI } from "@gsd/pi-tui";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateTail,
} from "../../../core/tools/truncate.js";
import { renderTerminalLines } from "../../../utils/terminal-serializer.js";
import { theme, type ThemeColor } from "../theme/theme.js";
import { editorKey, keyHint } from "./keybinding-hints.js";
import { truncateToVisualLines } from "./visual-truncate.js";

// Preview line limit when not expanded (matches tool execution behavior)
const PREVIEW_LINES = 20;

/**
 * Returns true if the command failure looks like a privilege/sudo escalation
 * error that the agent cannot resolve — distinct from an OS sandbox policy block.
 */
function isPrivilegeError(output: string, command: string): boolean {
	// Already handled by sandbox-policy path
	if (/sandbox blocked this operation/i.test(output)) return false;
	// sudo explicitly rejected
	if (/sudo.*operation not permitted/i.test(output)) return true;
	if (/command exited with code 126/i.test(output) && /sudo/i.test(output)) return true;
	// Agent process itself hit EPERM (e.g. npm cache owned by root)
	if (/EPERM|operation not permitted/i.test(output) && /sudo/i.test(command)) return true;
	// npm cache root-owned files pattern
	if (/cache folder contains root-owned files/i.test(output)) return true;
	// Generic privilege denial patterns
	if (/permission denied/i.test(output) && /sudo/i.test(command)) return true;
	return false;
}

type ToolOutputMode = "minimal" | "normal";

export class BashExecutionComponent extends Container {
	private command: string;
	private outputLines: string[] = [];
	private rawOutput = "";
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
	private sandboxed: boolean;
	// Dedicated header node
	private headerText: Text;

	constructor(
		command: string,
		ui: TUI,
		excludeFromContext = false,
		renderMode: ToolOutputMode = "normal",
		_rtkActive = false,
		sandboxed = false,
	) {
		super();
		this.command = command;
		this.ui = ui;
		this.renderMode = renderMode;
		this.sandboxed = sandboxed;

		// Use dim tone for excluded-from-context commands (!! prefix)
		this.colorKey = (excludeFromContext ? "dim" : "bashMode") as ThemeColor;

		// Content container
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		// Header Text node
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
	}

	/** Build the header line text. */
	private buildHeaderText(): string {
		let text = `${theme.fg("toolTitle", theme.bold("bash"))} ${theme.fg(this.colorKey, theme.bold(`$ ${this.command}`))}`;
		if (this.sandboxed) {
			text += `  ${theme.fg("success", "[sandboxed]")}`;
		}
		return text;
	}

	/**
	 * Stop all timers and release resources. Call when removing the component
	 * from the tree before setComplete() has been called (e.g. on clear/cancel).
	 */
	dispose(): void {
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
		// Strip ANSI codes and preserve carriage-return semantics for display.
		this.rawOutput += chunk;
		this.outputLines = renderTerminalLines(this.rawOutput);
		this.updateDisplay();
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		truncationResult?: TruncationResult,
		fullOutputPath?: string,
		sandboxed?: boolean,
	): void {
		this.exitCode = exitCode;
		this.status = cancelled
			? "cancelled"
			: exitCode !== 0 && exitCode !== undefined && exitCode !== null
				? "error"
				: "complete";
		this.truncationResult = truncationResult;
		this.fullOutputPath = fullOutputPath;
		if (sandboxed !== undefined) {
			this.sandboxed = sandboxed;
		}

		// Stop loader
		this.loader.stop();

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
				// collapsed — no inline hint needed (shown in editor bottom border)
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

			// Show expand/collapse hint whenever there is output
			if (availableLines.length > 0) {
				if (this.expanded) {
					statusParts.push(`(${keyHint("expandTools", "to collapse")})`);
				} else if (this.renderMode === "minimal") {
					statusParts.push(`(${keyHint("expandTools", "to expand")})`);
				} else if (hiddenLineCount > 0) {
					// Normal mode: show line count + hint
					statusParts.push(
						`${theme.fg("muted", `... ${hiddenLineCount} more lines`)} (${keyHint("expandTools", "to expand")})`,
					);
				} else {
					// Normal mode: all preview lines visible, still offer expand
					statusParts.push(`(${keyHint("expandTools", "to expand")})`);
				}
			}

			if (this.status === "cancelled") {
				statusParts.push(theme.fg("warning", "(cancelled)"));
			} else if (this.status === "error") {
				statusParts.push(theme.fg("error", `(exit ${this.exitCode})`));
				if (this.sandboxed && /operation not permitted/i.test(fullOutput)) {
					statusParts.push(
						theme.fg(
							"warning",
							"Sandbox blocked this operation. Run /sandbox to inspect the active policy and allowed paths.",
						),
					);
				} else if (!this.sandboxed && isPrivilegeError(fullOutput, this.command)) {
					statusParts.push(
						theme.fg("warning", "⚠ This command requires elevated privileges the agent cannot use."),
					);
					statusParts.push(
						theme.fg("muted", `Run it manually in your terminal:\n  ${this.command}`),
					);
				}
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
