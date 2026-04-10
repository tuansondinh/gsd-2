/**
 * Embedded PTY terminal for user-triggered bash commands.
 * Renders a framed terminal surface and forwards keystrokes to a PTY handle.
 */

import { decodeKittyPrintable, matchesKey, parseKey, type Focusable, type TUI } from "@gsd/pi-tui";
import { truncateToWidth, visibleWidth } from "@gsd/pi-tui";
import type { PtyExecutionHandle } from "../../../core/pty-executor.js";
import { createHeadlessTerminal, snapshotTerminalLines, type HeadlessTerminal } from "../../../utils/terminal-screen.js";
import { theme } from "../theme/theme.js";

type ToolOutputMode = "minimal" | "normal";

export class EmbeddedTerminalComponent implements Focusable {
    public focused = false;

    private command: string;
    private status: "running" | "complete" | "cancelled" | "error" = "running";
    private exitCode: number | undefined;
    private focusKeyLabel: string;
    private renderedLines: string[] = [];
    private rawOutput = "";
    private terminal: HeadlessTerminal;
    private terminalWriteChain: Promise<void> = Promise.resolve();
    private handle?: PtyExecutionHandle;
    private releaseFocus?: () => void;
    private statusOverride?: string;

    constructor(
        command: string,
        _ui: TUI,
        _renderMode: ToolOutputMode,
        focusKeyLabel: string,
        _excludeFromContext = false,
    ) {
        this.command = command;
        this.focusKeyLabel = focusKeyLabel;
        this.terminal = createHeadlessTerminal();
    }

    setHandle(handle: PtyExecutionHandle, releaseFocus: () => void): void {
        this.handle = handle;
        this.releaseFocus = releaseFocus;
    }

    setScreenText(text: string): void {
        this.rawOutput = text;
        this.renderedLines = text ? text.split("\n") : [];
    }

    setStatusOverride(text: string | undefined): void {
        this.statusOverride = text;
    }

    resize(cols: number, rows: number): void {
        const safeCols = Math.max(20, cols);
        const safeRows = Math.max(5, rows);
        this.handle?.resize(safeCols, safeRows);
        this.terminal.resize(safeCols, safeRows);
        this.renderedLines = snapshotTerminalLines(this.terminal);
    }

    setExpanded(_expanded: boolean): void {
        // Interactive terminals are always rendered expanded for now.
    }

    setRenderMode(_mode: ToolOutputMode): void {
        // Interactive terminals are always rendered expanded for now.
    }

    appendOutput(chunk: string): void {
        this.rawOutput += chunk;
        this.terminalWriteChain = this.terminalWriteChain.then(
            () =>
                new Promise<void>((resolve) => {
                    this.terminal.write(chunk, () => {
                        this.renderedLines = snapshotTerminalLines(this.terminal);
                        resolve();
                    });
                }),
        );
    }

    setComplete(exitCode: number | undefined, cancelled: boolean): void {
        this.exitCode = exitCode;
        this.status = cancelled
            ? "cancelled"
            : exitCode !== undefined && exitCode !== 0
                ? "error"
                : "complete";
    }

    getOutput(): string {
        return this.rawOutput;
    }

    handleInput(data: string): void {
        if (matchesKey(data, "escape") || matchesKey(data, "tab")) {
            this.releaseFocus?.();
            return;
        }

        const kittyPrintable = decodeKittyPrintable(data);
        if (kittyPrintable !== undefined) {
            this.handle?.write(kittyPrintable);
            return;
        }

        const key = parseKey(data);
        switch (key) {
            case "enter":
            case "shift+enter":
                this.handle?.write("\r");
                return;
            case "shift+tab":
            case "tab":
                this.handle?.write("\t");
                return;
            case "backspace":
            case "shift+backspace":
                this.handle?.write("\x7f");
                return;
            case "up":
                this.handle?.write("\x1b[A");
                return;
            case "down":
                this.handle?.write("\x1b[B");
                return;
            case "right":
                this.handle?.write("\x1b[C");
                return;
            case "left":
                this.handle?.write("\x1b[D");
                return;
            case "ctrl+c":
                this.handle?.write("\x03");
                return;
            case "ctrl+d":
                this.handle?.write("\x04");
                return;
        }

        if (data.length === 1 && data >= " " && data !== "\x7f") {
            this.handle?.write(data);
        }
    }

    invalidate(): void {
        // No-op; render reads directly from current state.
    }

    render(width: number): string[] {
        const innerWidth = Math.max(10, width - 2);
        const frameColor = this.status === "error"
            ? "error"
            : this.focused
                ? "success"
                : "success";
        const border = (text: string) => theme.fg(frameColor, text);

        const lines: string[] = [];
        lines.push(border(`╭${"─".repeat(innerWidth)}╮`));

        for (const line of this.buildBodyLines(innerWidth)) {
            const content = truncateToWidth(line, innerWidth, "", true);
            lines.push(`${border("│")}${content}${border("│")}`);
        }

        lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
        return lines;
    }

    private buildBodyLines(innerWidth: number): string[] {
        const body: string[] = [];
        body.push(this.buildHeaderText(innerWidth));
        body.push("");

        const visibleTerminalLines = this.getVisibleTerminalLines();
        if (visibleTerminalLines.length > 0) {
            body.push(...visibleTerminalLines);
        } else if (this.status === "running") {
            body.push(theme.fg("dim", "Terminal waiting for output…"));
        }

        body.push("");
        body.push(this.buildStatusText(innerWidth));
        return body;
    }

    private getVisibleTerminalLines(): string[] {
        const lines = [...this.renderedLines];
        while (lines.length > 0 && lines[lines.length - 1] === "") {
            lines.pop();
        }
        return lines;
    }

    private buildHeaderText(innerWidth: number): string {
        const prefix = this.focused
            ? theme.fg("success", theme.bold(" TERMINAL "))
            : theme.fg("success", " terminal ");
        const command = theme.bold(`$ ${this.command}`);
        const hint = this.focused
            ? theme.fg("muted", "Tab/Esc return · Shift+Tab sends Tab")
            : theme.fg("muted", `${this.focusKeyLabel} to focus`);

        const left = `${prefix} ${command}`;
        const leftWidth = visibleWidth(left);
        const hintWidth = visibleWidth(hint);
        if (leftWidth + 2 + hintWidth <= innerWidth) {
            return left + " ".repeat(innerWidth - leftWidth - hintWidth) + hint;
        }
        return truncateToWidth(`${left}  ${hint}`, innerWidth, "...");
    }

    private buildStatusText(innerWidth: number): string {
        let statusText: string;
        if (this.status === "running") {
            statusText = this.statusOverride
                ? this.statusOverride
                : this.focused
                    ? theme.fg("success", theme.bold("INPUT CAPTURED")) + theme.fg("muted", " — typing goes to the terminal")
                    : theme.fg("muted", `Press ${this.focusKeyLabel} to focus this terminal`);
        } else if (this.status === "cancelled") {
            statusText = theme.fg("warning", "(cancelled)");
        } else if (this.status === "error") {
            statusText = theme.fg("error", `(exit ${this.exitCode})`);
        } else {
            statusText = theme.fg("success", "(done)");
        }
        return truncateToWidth(statusText, innerWidth, "...");
    }
}
