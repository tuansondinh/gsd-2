/**
 * Embedded PTY terminal for user-triggered bash commands.
 * MVP: renders live ANSI text output and can forward keystrokes to a PTY handle.
 */

import { Container, decodeKittyPrintable, parseKey, type Focusable, Text, type TUI, matchesKey } from "@gsd/pi-tui";
import type { PtyExecutionHandle } from "../../../core/pty-executor.js";
import { theme, type ThemeColor } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

type ToolOutputMode = "minimal" | "normal";

export class EmbeddedTerminalComponent extends Container implements Focusable {
    public focused = false;

    private command: string;
    private status: "running" | "complete" | "cancelled" | "error" = "running";
    private exitCode: number | undefined;
    private contentContainer: Container;
    private colorKey: ThemeColor;
    private focusKeyLabel: string;
    private chunks: string[] = [];
    private rawOutput = "";
    private handle?: PtyExecutionHandle;
    private releaseFocus?: () => void;
    private headerText: Text;

    constructor(
        command: string,
        _ui: TUI,
        _renderMode: ToolOutputMode,
        focusKeyLabel: string,
        excludeFromContext = false,
    ) {
        super();
        this.command = command;
        this.focusKeyLabel = focusKeyLabel;
        this.colorKey = (excludeFromContext ? "dim" : "bashMode") as ThemeColor;

        const borderColor = (str: string) => theme.fg(this.colorKey, str);
        this.addChild(new DynamicBorder(borderColor));
        this.contentContainer = new Container();
        this.addChild(this.contentContainer);
        this.headerText = new Text(this.buildHeaderText(), 1, 0);
        this.contentContainer.addChild(this.headerText);
        this.addChild(new DynamicBorder(borderColor));
    }

    setHandle(handle: PtyExecutionHandle, releaseFocus: () => void): void {
        this.handle = handle;
        this.releaseFocus = releaseFocus;
        this.updateDisplay();
    }

    setExpanded(_expanded: boolean): void {
        // Interactive terminals are always rendered expanded for now.
        this.updateDisplay();
    }

    setRenderMode(_mode: ToolOutputMode): void {
        this.updateDisplay();
    }

    appendOutput(chunk: string): void {
        this.rawOutput += chunk;
        const normalized = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        this.chunks.push(normalized);
        this.updateDisplay();
    }

    setComplete(exitCode: number | undefined, cancelled: boolean): void {
        this.exitCode = exitCode;
        this.status = cancelled
            ? "cancelled"
            : exitCode !== undefined && exitCode !== 0
                ? "error"
                : "complete";
        this.updateDisplay();
    }

    getOutput(): string {
        return this.rawOutput;
    }

    handleInput(data: string): void {
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+f")) {
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

        // Plain printable single-byte input in non-kitty terminals.
        if (data.length === 1 && data >= " " && data !== "\x7f") {
            this.handle?.write(data);
        }
        // Ignore unknown escape/control sequences so we don't echo terminal protocol gibberish into the PTY.
    }

    invalidate(): void {
        super.invalidate();
        this.updateDisplay();
    }

    private buildHeaderText(): string {
        let text = theme.fg(this.colorKey, theme.bold(`$ ${this.command}`));
        if (this.focused && this.status === "running") {
            text += `  ${theme.fg("accent", "[terminal focused]")}`;
        } else if (this.status === "running") {
            text += `  ${theme.fg("muted", `[${this.focusKeyLabel} to interact]`)}`;
        }
        return text;
    }

    private updateDisplay(): void {
        this.contentContainer.clear();
        this.headerText.setText(this.buildHeaderText());
        this.contentContainer.addChild(this.headerText);

        const availableLines = this.chunks.join("").split("\n");
        if (availableLines.length > 0) {
            this.contentContainer.addChild(new Text(`\n${availableLines.join("\n")}`, 1, 0));
        }

        const statusParts: string[] = [];
        if (this.status === "running") {
            statusParts.push(theme.fg("muted", this.focused ? "Interactive terminal active" : "Interactive terminal ready"));
        } else if (this.status === "cancelled") {
            statusParts.push(theme.fg("warning", "(cancelled)"));
        } else if (this.status === "error") {
            statusParts.push(theme.fg("error", `(exit ${this.exitCode})`));
        } else {
            statusParts.push(theme.fg("success", "(done)"));
        }

        if (statusParts.length > 0) {
            this.contentContainer.addChild(new Text(`\n${statusParts.join("\n")}`, 1, 0));
        }
    }
}
