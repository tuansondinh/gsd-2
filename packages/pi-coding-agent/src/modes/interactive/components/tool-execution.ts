import {
    Box,
    Container,
    getCapabilities,
    Image,
    imageFallback,
    Spacer,
    Text,
    type TUI,
    truncateToWidth,
} from "@gsd/pi-tui";
import stripAnsi from "strip-ansi";
import type { ToolDefinition } from "../../../core/extensions/types.js";
import {
	computeEditDiff,
	computeWriteDiff,
	type EditDiffError,
	type EditDiffResult,
} from "../../../core/tools/edit-diff.js";
import { allTools } from "../../../core/tools/index.js";
import { shouldCollapse } from "../../../core/tool-priority.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "../../../core/tools/truncate.js";
import { convertToPng } from "../../../utils/image-convert.js";
import { sanitizeBinaryOutput } from "../../../utils/shell.js";
import { renderTerminalText } from "../../../utils/terminal-serializer.js";
import { getLanguageFromPath, highlightCode, theme } from "../theme/theme.js";
import { type EditorScheme, editorLink } from "../utils/editor-link.js";
import { shortenPath } from "../utils/shorten-path.js";
import { renderDiff, renderDiffLines } from "./diff.js";
import { keyHint } from "./keybinding-hints.js";
import { truncateToVisualLines } from "./visual-truncate.js";

// Preview line limit for bash when not expanded
const BASH_PREVIEW_LINES = 5;
// Flash interval for tool status spinner (ms)
const SPINNER_INTERVAL_MS = 150;

// Spinner animation frames
const SPINNER_FRAMES = ["◯", "◔", "◑", "◕", "●"];
let spinnerFrame = 0;

// During partial write tool-call streaming, re-highlight the first N lines fully
// to keep multiline tokenization mostly correct without re-highlighting the full file.
const WRITE_PARTIAL_FULL_HIGHLIGHT_LINES = 50;

/**
 * Replace tabs with spaces for consistent rendering
 */
function replaceTabs(text: string): string {
    return text.replace(/\t/g, "   ");
}

/**
 * Normalize control characters for terminal preview rendering.
 * Keep tool arguments unchanged, sanitize only display text.
 */
function normalizeDisplayText(text: string): string {
    return text.replace(/\r/g, "");
}

/** Safely coerce value to string for display. Returns null if invalid type. */
function str(value: unknown): string | null {
    if (typeof value === "string") return value;
    if (value == null) return "";
    return null; // Invalid type
}

/**
 * Returns true if the bash output indicates a privilege escalation failure
 * that the agent process cannot resolve (sudo blocked, EPERM on root-owned files, etc.).
 */
function isBashPrivilegeError(output: string, command: string): boolean {
    // Already handled by OS sandbox-policy path
    if (/sandbox blocked this operation/i.test(output)) return false;
    // sudo explicitly rejected by OS
    if (/sudo.*operation not permitted/i.test(output)) return true;
    if (/command exited with code 126/i.test(output) && /sudo/i.test(output)) return true;
    // npm / other tools hitting root-owned cache files
    if (/cache folder contains root-owned files/i.test(output)) return true;
    // Generic EPERM when command involves sudo
    if (/EPERM|operation not permitted/i.test(output) && /sudo/i.test(command)) return true;
    // Permission denied when command involves sudo
    if (/permission denied/i.test(output) && /sudo/i.test(command)) return true;
    return false;
}

export interface ToolExecutionOptions {
    showImages?: boolean; // default: true (only used if terminal supports images)
    renderMode?: "minimal" | "normal";
    editorScheme?: EditorScheme; // URI scheme for Cmd+click file links (default: "auto")
}

type WriteHighlightCache = {
    rawPath: string | null;
    lang: string;
    rawContent: string;
    normalizedLines: string[];
    highlightedLines: string[];
};

/**
 * Component that renders a tool call with its result (updateable)
 */
export class ToolExecutionComponent extends Container {
    private contentBox: Box; // Used for custom tools and bash visual truncation
    private contentText: Text; // For built-in tools (with its own padding/bg)
    private imageComponents: Image[] = [];
    private imageSpacers: Spacer[] = [];
    private toolName: string;
    private args: any;
    private expanded = false;
    private renderMode: "minimal" | "normal";
    private showImages: boolean;
    private editorScheme: EditorScheme;
    private isPartial = true;
    private toolDefinition?: ToolDefinition;
    private ui: TUI;
    private cwd: string;
    private result?: {
        content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
        isError: boolean;
        details?: any;
    };
    // Cached edit diff preview (computed when args arrive, before tool executes)
    private editDiffPreview?: EditDiffResult | EditDiffError;
    private editDiffArgsKey?: string; // Track which args the preview is for
    // Cached write diff preview (computed when args arrive, before tool executes)
    private writeDiffPreview?: EditDiffResult | EditDiffError;
    private writeDiffArgsKey?: string; // Track which args the preview is for
    // Cached converted images for Kitty protocol (which requires PNG), keyed by index
    private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
    // Incremental syntax highlighting cache for write tool call args
    private writeHighlightCache?: WriteHighlightCache;
    // When true, this component intentionally renders no lines
    private hideComponent = false;
    private manuallyHidden = false;
    private indented = false;
    private startTime = Date.now();

    // Tool status spinner state
    private spinnerTimer: NodeJS.Timeout | null = null;
    private spinnerFrame = 0;

    constructor(
        toolName: string,
        args: any,
        options: ToolExecutionOptions = {},
        toolDefinition: ToolDefinition | undefined,
        ui: TUI,
        cwd: string = process.cwd(),
    ) {
        super();
        this.toolName = toolName;
        this.args = args;
        this.showImages = options.showImages ?? true;
        this.renderMode = options.renderMode ?? "normal";
        this.editorScheme = options.editorScheme ?? "auto";
        this.toolDefinition = toolDefinition;
        this.ui = ui;
        this.cwd = cwd;

        // Always create both - contentBox for custom tools/bash, contentText for other built-ins
        this.contentBox = new Box(1, 0, (text: string) => theme.bg("toolPendingBg", text));
        this.contentText = new Text("", 1, 0, (text: string) => theme.bg("toolPendingBg", text));

        // Use contentBox for bash (visual truncation) or custom tools with custom renderers
        // Use contentText for built-in tools (including overrides without custom renderers)
        if (toolName === "bash" || (toolDefinition && !this.shouldUseBuiltInRenderer())) {
            this.addChild(this.contentBox);
        } else {
            this.addChild(this.contentText);
        }

        this.updateDisplay();
    }

    /**
     * Check if we should use built-in rendering for this tool.
     * Returns true if the tool name is a built-in AND either there's no toolDefinition
     * or the toolDefinition doesn't provide custom renderers.
     */
    private shouldUseBuiltInRenderer(): boolean {
        const isBuiltInName = this.toolName in allTools;
        const hasCustomRenderers = this.toolDefinition?.renderCall || this.toolDefinition?.renderResult;
        return isBuiltInName && !hasCustomRenderers;
    }

    private setPrimaryContent(useBox: boolean): void {
        const hasBox = this.children.includes(this.contentBox);
        const hasText = this.children.includes(this.contentText);

        if (useBox) {
            if (hasText) this.removeChild(this.contentText);
            if (!hasBox) this.addChild(this.contentBox);
        } else {
            if (hasBox) this.removeChild(this.contentBox);
            if (!hasText) this.addChild(this.contentText);
        }
    }

    private getDiffTextToRender(): string | undefined {
        if (this.toolName === "write") {
            if (!this.isPartial && this.writeDiffPreview && !("error" in this.writeDiffPreview) && this.writeDiffPreview.diff) {
                return this.writeDiffPreview.diff;
            }
            return undefined;
        }

        if (this.toolName !== "edit" || this.result?.isError) {
            return undefined;
        }

        if (this.result?.details?.diff) {
            return this.result.details.diff;
        }
        if (this.editDiffPreview && !("error" in this.editDiffPreview) && this.editDiffPreview.diff) {
            return this.editDiffPreview.diff;
        }
        return undefined;
    }

    updateArgs(args: any): void {
        this.args = args;
        if (this.toolName === "write" && this.isPartial) {
            this.updateWriteHighlightCacheIncremental();
        }
        this.updateDisplay();
    }

    private highlightSingleLine(line: string, lang: string): string {
        const highlighted = highlightCode(line, lang);
        return highlighted[0] ?? "";
    }

    private refreshWriteHighlightPrefix(cache: WriteHighlightCache): void {
        const prefixCount = Math.min(WRITE_PARTIAL_FULL_HIGHLIGHT_LINES, cache.normalizedLines.length);
        if (prefixCount === 0) return;

        const prefixSource = cache.normalizedLines.slice(0, prefixCount).join("\n");
        const prefixHighlighted = highlightCode(prefixSource, cache.lang);
        for (let i = 0; i < prefixCount; i++) {
            cache.highlightedLines[i] =
                prefixHighlighted[i] ?? this.highlightSingleLine(cache.normalizedLines[i] ?? "", cache.lang);
        }
    }

    private rebuildWriteHighlightCacheFull(rawPath: string | null, fileContent: string): void {
        const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
        if (!lang) {
            this.writeHighlightCache = undefined;
            return;
        }

        const displayContent = normalizeDisplayText(fileContent);
        const normalized = replaceTabs(displayContent);
        this.writeHighlightCache = {
            rawPath,
            lang,
            rawContent: fileContent,
            normalizedLines: normalized.split("\n"),
            highlightedLines: highlightCode(normalized, lang),
        };
    }

    private updateWriteHighlightCacheIncremental(): void {
        const rawPath = str(this.args?.file_path ?? this.args?.path);
        const fileContent = str(this.args?.content);
        if (rawPath === null || fileContent === null) {
            this.writeHighlightCache = undefined;
            return;
        }

        const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
        if (!lang) {
            this.writeHighlightCache = undefined;
            return;
        }

        if (!this.writeHighlightCache) {
            this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
            return;
        }

        const cache = this.writeHighlightCache;
        if (cache.lang !== lang || cache.rawPath !== rawPath) {
            this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
            return;
        }

        if (!fileContent.startsWith(cache.rawContent)) {
            this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
            return;
        }

        if (fileContent.length === cache.rawContent.length) {
            return;
        }

        const deltaRaw = fileContent.slice(cache.rawContent.length);
        const deltaDisplay = normalizeDisplayText(deltaRaw);
        const deltaNormalized = replaceTabs(deltaDisplay);
        cache.rawContent = fileContent;

        if (cache.normalizedLines.length === 0) {
            cache.normalizedLines.push("");
            cache.highlightedLines.push("");
        }

        const segments = deltaNormalized.split("\n");
        const lastIndex = cache.normalizedLines.length - 1;
        cache.normalizedLines[lastIndex] += segments[0];
        cache.highlightedLines[lastIndex] = this.highlightSingleLine(cache.normalizedLines[lastIndex], cache.lang);

        for (let i = 1; i < segments.length; i++) {
            cache.normalizedLines.push(segments[i]);
            cache.highlightedLines.push(this.highlightSingleLine(segments[i], cache.lang));
        }

        this.refreshWriteHighlightPrefix(cache);
    }

    /**
     * Signal that args are complete (tool is about to execute).
     * This triggers diff computation for edit tool.
     */
    setArgsComplete(): void {
        if (this.toolName === "write") {
            const rawPath = str(this.args?.file_path ?? this.args?.path);
            const fileContent = str(this.args?.content);
            if (rawPath !== null && fileContent !== null) {
                this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
            }
            this.maybeComputeWriteDiff();
        }
        this.maybeComputeEditDiff();
    }

    /**
     * Compute write diff preview when we have complete args.
     * This runs async and updates display when done.
     */
    private maybeComputeWriteDiff(): void {
        if (this.toolName !== "write") return;

        const path = this.args?.path ?? this.args?.file_path;
        const content = this.args?.content;

        if (!path || content === undefined) return;

        const argsKey = JSON.stringify({ path, content });
        if (this.writeDiffArgsKey === argsKey) return;

        this.writeDiffArgsKey = argsKey;

        computeWriteDiff(path, content, this.cwd).then((result) => {
            if (this.writeDiffArgsKey === argsKey) {
                this.writeDiffPreview = result;
                this.updateDisplay();
                this.ui.requestRender();
            }
        });
    }

    /**
     * Compute edit diff preview when we have complete args.
     * This runs async and updates display when done.
     */
    private maybeComputeEditDiff(): void {
        if (this.toolName !== "edit") return;

        const path = this.args?.path;
        const oldText = this.args?.oldText;
        const newText = this.args?.newText;

        // Need all three params to compute diff
        if (!path || oldText === undefined || newText === undefined) return;

        // Create a key to track which args this computation is for
        const argsKey = JSON.stringify({ path, oldText, newText });

        // Skip if we already computed for these exact args
        if (this.editDiffArgsKey === argsKey) return;

        this.editDiffArgsKey = argsKey;

        // Compute diff async
        computeEditDiff(path, oldText, newText, this.cwd).then((result) => {
            // Only update if args haven't changed since we started
            if (this.editDiffArgsKey === argsKey) {
                this.editDiffPreview = result;
                this.updateDisplay();
                this.ui.requestRender();
            }
        });
    }

    updateResult(
        result: {
            content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
            details?: any;
            isError: boolean;
        },
        isPartial = false,
    ): void {
        this.result = result;
        this.isPartial = isPartial;

        if (this.toolName === "write" && !isPartial) {
            const rawPath = str(this.args?.file_path ?? this.args?.path);
            const fileContent = str(this.args?.content);
            if (rawPath !== null && fileContent !== null) {
                this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
            }
        }
        this.updateDisplay();
        // Convert non-PNG images to PNG for Kitty protocol (async)
        this.maybeConvertImagesForKitty();
    }

    /**
     * Convert non-PNG images to PNG for Kitty graphics protocol.
     * Kitty requires PNG format (f=100), so JPEG/GIF/WebP won't display.
     */
    private maybeConvertImagesForKitty(): void {
        const caps = getCapabilities();
        // Only needed for Kitty protocol
        if (caps.images !== "kitty") return;
        if (!this.result) return;

        const imageBlocks = this.result.content?.filter((c: any) => c.type === "image") || [];

        for (let i = 0; i < imageBlocks.length; i++) {
            const img = imageBlocks[i];
            if (!img.data || !img.mimeType) continue;
            // Skip if already PNG or already converted
            if (img.mimeType === "image/png") continue;
            if (this.convertedImages.has(i)) continue;

            // Convert async
            const index = i;
            convertToPng(img.data, img.mimeType).then((converted) => {
                if (converted) {
                    this.convertedImages.set(index, converted);
                    this.updateDisplay();
                    this.ui.requestRender();
                }
            });
        }
    }

    setExpanded(expanded: boolean): void {
        this.expanded = expanded;
        this.updateDisplay();
    }

    setHidden(hidden: boolean): void {
        this.manuallyHidden = hidden;
        this.updateDisplay();
    }

    setIndented(indented: boolean): void {
        this.indented = indented;
        this.updateDisplay();
    }

    isHidden(): boolean {
        return this.hideComponent;
    }

    getElapsed(): number {
        return Date.now() - this.startTime;
    }

    shouldHideWhenCollapsed(collapseToolCalls = true): boolean {
        return collapseToolCalls && !this.isPartial && shouldCollapse(this.toolName, this.result?.isError ?? false);
    }

    setRenderMode(mode: "minimal" | "normal"): void {
        if (this.renderMode !== mode) {
            this.renderMode = mode;
            this.updateDisplay();
        }
    }

    setEditorScheme(scheme: EditorScheme): void {
        this.editorScheme = scheme;
        this.updateDisplay();
    }

    setShowImages(show: boolean): void {
        this.showImages = show;
        this.updateDisplay();
    }

    dispose(): void {
        if (this.spinnerTimer) {
            clearInterval(this.spinnerTimer);
            this.spinnerTimer = null;
        }
    }

    override invalidate(): void {
        super.invalidate();
        this.updateDisplay();
    }

    override render(width: number): string[] {
        if (this.hideComponent) {
            return [];
        }
        const lines = super.render(width);
        if (this.indented) {
            const gutter = theme.fg("dim", "│");
            return lines.map((line, i) => {
                if (i === lines.length - 1 && line === "") {
                    // Trailing empty spacer line → gutter only
                    return gutter;
                }
                return gutter + " " + theme.fg("dim", line);
            });
        }
        return [...lines, ""];
    }

    private updateDisplay(): void {
        // Status indicator with circle
        let statusIndicator = "";
        let statusColor = "";

        if (this.isPartial) {
            // Loading spinner - start timer on first partial render
            if (!this.spinnerTimer) {
                this.spinnerTimer = setInterval(() => {
                    this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
                    this.updateDisplay();
                    this.ui.requestRender();
                }, SPINNER_INTERVAL_MS);
            }
            statusIndicator = SPINNER_FRAMES[this.spinnerFrame];
        } else {
            // Stop spinner when no longer partial
            if (this.spinnerTimer) {
                clearInterval(this.spinnerTimer);
                this.spinnerTimer = null;
            }
            if (this.result?.isError) {
                // Failed - red circle
                statusIndicator = theme.fg("error", "●");
                statusColor = "error";
            } else {
                // Success - green circle
                statusIndicator = theme.fg("success", "●");
                statusColor = "success";
            }
        }

        const useBuiltInRenderer = this.shouldUseBuiltInRenderer();
        const diffTextToRender = this.getDiffTextToRender();
        let customRendererHasContent = false;

        // Use built-in rendering for built-in tools (or overrides without custom renderers)
        if (useBuiltInRenderer) {
            const useDiffBox = !!diffTextToRender && !this.shouldHideCollapsedPreview();
            this.setPrimaryContent(this.toolName === "bash" || useDiffBox);
            if (this.toolName === "bash") {
                // Bash uses Box with visual line truncation - no background
                this.contentBox.setBgFn((text: string) => text);
                this.contentBox.clear();
                this.renderBashContent(statusIndicator);
            } else if (useDiffBox && diffTextToRender) {
                this.contentBox.setBgFn((text: string) => text);
                this.contentBox.clear();
                this.renderBuiltInDiffContent(statusIndicator, diffTextToRender);
            } else {
                // Other built-in tools: use Text directly with caching - no background
                this.contentText.setCustomBgFn((text: string) => text);
                this.contentText.setText(this.formatToolExecution(statusIndicator));
            }
        } else if (this.toolDefinition) {
            // Custom tools use Box for flexible component rendering - no background
            this.contentBox.setBgFn((text: string) => text);
            this.contentBox.clear();

            // Render call component
            if (this.toolDefinition.renderCall) {
                try {
                    const callComponent = this.toolDefinition.renderCall(this.args, theme, { statusIndicator });
                    if (callComponent !== undefined) {
                        this.contentBox.addChild(callComponent);
                        customRendererHasContent = true;
                    }
                } catch {
                    // Fall back to default on error
                    this.contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0));
                    customRendererHasContent = true;
                }
            } else {
                // No custom renderCall, show tool name
                this.contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0));
                customRendererHasContent = true;
            }

            // Render result component if we have a result
            if (this.result && this.toolDefinition.renderResult) {
                try {
                    if (this.shouldHideCollapsedPreview()) {
                        const output = this.getTextOutput();
                        const hasDetails = output.trim().length > 0 || this.imageComponents.length > 0 || this.result.details !== undefined;
                        const collapsedHint = this.collapsedHintWithPrefix("\n");
                        if (hasDetails && collapsedHint) {
                            this.contentBox.addChild(new Text(collapsedHint, 0, 0));
                            customRendererHasContent = true;
                        }
                    } else {
                        const resultComponent = this.toolDefinition.renderResult(
                            { content: this.result.content as any, details: this.result.details },
                            { expanded: this.expanded, isPartial: this.isPartial },
                            theme,
                        );
                        if (resultComponent !== undefined) {
                            this.contentBox.addChild(resultComponent);
                            customRendererHasContent = true;
                            // bg_shell: show /bg hint after start/list/digest actions
                            if (this.toolName === 'bg_shell' && this.result && !this.isPartial) {
                                const details = this.result.details as Record<string, unknown> | undefined;
                                const action = details?.action as string | undefined;
                                if (action === 'start' || action === 'list' || action === 'digest') {
                                    this.contentBox.addChild(new Text(
                                        '\n' + theme.fg('muted', 'Tip: run /bg to manage background processes'),
                                        0, 0,
                                    ));
                                }
                            }
                        }
                    }
                } catch {
                    // Fall back to showing raw output on error
                    const output = this.getTextOutput();
                    if (output) {
                        this.contentBox.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
                        customRendererHasContent = true;
                    }
                }
            } else if (this.result) {
                // Has result but no custom renderResult
                const output = this.getTextOutput();
                if (output) {
                    if (this.shouldHideCollapsedPreview()) {
                        const collapsedHint = this.collapsedHintWithPrefix("\n");
                        if (collapsedHint) {
                            this.contentBox.addChild(new Text(collapsedHint, 0, 0));
                        }
                    } else {
                        this.contentBox.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
                    }
                    customRendererHasContent = true;
                }
            }
        } else {
            // Unknown tool with no registered definition - show generic fallback
            this.contentText.setCustomBgFn((text: string) => text);
            this.contentText.setText(this.formatToolExecution(statusIndicator));
        }

        // Handle images (same for both custom and built-in)
        for (const img of this.imageComponents) {
            this.removeChild(img);
        }
        this.imageComponents = [];
        for (const spacer of this.imageSpacers) {
            this.removeChild(spacer);
        }
        this.imageSpacers = [];

        if (this.result) {
            const imageBlocks = this.result.content?.filter((c: any) => c.type === "image") || [];
            const caps = getCapabilities();

            for (let i = 0; i < imageBlocks.length; i++) {
                const img = imageBlocks[i];
                if (caps.images && this.showImages && img.data && img.mimeType) {
                    // Use converted PNG for Kitty protocol if available
                    const converted = this.convertedImages.get(i);
                    const imageData = converted?.data ?? img.data;
                    const imageMimeType = converted?.mimeType ?? img.mimeType;

                    // For Kitty, skip non-PNG images that haven't been converted yet
                    if (caps.images === "kitty" && imageMimeType !== "image/png") {
                        continue;
                    }

                    const spacer = new Spacer(1);
                    this.addChild(spacer);
                    this.imageSpacers.push(spacer);
                    const imageComponent = new Image(
                        imageData,
                        imageMimeType,
                        { fallbackColor: (s: string) => theme.fg("toolOutput", s) },
                        { maxWidthCells: 60 },
                    );
                    imageComponent.setOnDimensionsResolved(() => {
                        this.updateDisplay();
                        this.ui.requestRender();
                    });
                    this.imageComponents.push(imageComponent);
                    this.addChild(imageComponent);
                }
            }
        }

        const computedHidden = !useBuiltInRenderer && this.toolDefinition ? !customRendererHasContent && this.imageComponents.length === 0 : false;
        this.hideComponent = this.manuallyHidden || computedHidden;
    }

    /**
     * Render built-in edit/write diff blocks with width-aware full-line backgrounds.
     */
    private renderBuiltInDiffContent(statusIndicator: string, diffText: string): void {
        const header = this.formatToolExecution(statusIndicator).split("\n\n", 1)[0] ?? "";
        this.contentBox.addChild(new Text(header, 0, 0));
        this.contentBox.addChild({
            render: (width: number) => {
                const contentWidth = Math.max(1, width - 2);
                return ["", ...renderDiffLines(diffText, contentWidth).map((line) => ` ${line} `)];
            },
            invalidate: () => { },
        });
    }

    /**
     * Render bash content using visual line truncation (like bash-execution.ts)
     */
    private renderBashContent(statusIndicator: string): void {
        const command = str(this.args?.command);
        const timeout = this.args?.timeout as number | undefined;
        const body = new Container();

        this.contentBox.addChild(body);

        const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
        const sandboxBadge = this.result?.details?.sandboxed ? `  ${theme.fg("success", "[sandboxed]")}` : "";
        const toolLabel = theme.fg("toolTitle", theme.bold("bash"));
        const shellPrompt = theme.fg("muted", "$ ");

        // Always show only the first meaningful non-comment line in the header.
        // The full command is shown below the header when expanded.
        let commandDisplay: string;
        let commandLines: string[] = [];
        let isMultiLine = false;
        if (command === null) {
            commandDisplay = theme.fg("error", "[invalid arg]");
        } else if (!command) {
            commandDisplay = theme.fg("toolOutput", "...");
        } else {
            commandLines = command.split("\n");
            isMultiLine = commandLines.length > 1;
            const firstMeaningful = commandLines.find((l) => l.trim() && !l.trim().startsWith("#")) ?? commandLines[0];
            const suffix = isMultiLine ? theme.fg("muted", " …") : "";
            commandDisplay = theme.fg("toolOutput", firstMeaningful ?? "") + suffix;
        }

        body.addChild(new Text(`${statusIndicator} ${toolLabel} ${shellPrompt}${commandDisplay}${timeoutSuffix}${sandboxBadge}`, 0, 0));

        // When expanded, show the full command below the header (only for multi-line commands)
        if (this.expanded && isMultiLine) {
            const fullCommand = commandLines.map((line) => theme.fg("toolOutput", line)).join("\n");
            body.addChild(new Text(`\n${fullCommand}`, 0, 0));
        }

        if (this.result) {
            const output = this.getTextOutput().trim();

            if (output) {
                const styledOutput = output
                    .split("\n")
                    .map((line) => theme.fg("toolOutput", line))
                    .join("\n");

                if (this.expanded) {
                    body.addChild(new Text(`\n${styledOutput}`, 0, 0));
                } else if (this.renderMode === "minimal") {
                    const collapsedHint = this.collapsedHintWithPrefix("\n");
                    if (collapsedHint) {
                        body.addChild(new Text(collapsedHint, 1, 0));
                    }
                } else {
                    let cachedWidth: number | undefined;
                    let cachedLines: string[] | undefined;
                    let cachedSkipped: number | undefined;

                    body.addChild({
                        render: (width: number) => {
                            if (cachedLines === undefined || cachedWidth !== width) {
                                const result = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, Math.max(1, width - 1));
                                cachedLines = result.visualLines.map((line) => ` ${line}`);
                                cachedSkipped = result.skippedCount;
                                cachedWidth = width;
                            }
                            if (cachedSkipped && cachedSkipped > 0) {
                                const hint = theme.fg("muted", `... (${cachedSkipped} earlier lines)`);
                                return ["", truncateToWidth(` ${hint}`, width, "..."), ...cachedLines];
                            }
                            return ["", ...cachedLines];
                        },
                        invalidate: () => {
                            cachedWidth = undefined;
                            cachedLines = undefined;
                            cachedSkipped = undefined;
                        },
                    });
                }
            }

            const truncation = this.result.details?.truncation;
            const fullOutputPath = this.result.details?.fullOutputPath;
            if (truncation?.truncated || fullOutputPath) {
                const warnings: string[] = [];
                if (fullOutputPath) {
                    warnings.push(`Full output: ${fullOutputPath}`);
                }
                if (truncation?.truncated) {
                    if (truncation.truncatedBy === "lines") {
                        warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
                    } else {
                        warnings.push(
                            `Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
                        );
                    }
                }
                body.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
            }

            // Privilege escalation error — agent cannot sudo, show manual step callout
            if (this.result.isError && command !== null && isBashPrivilegeError(output, command)) {
                body.addChild(
                    new Text(
                        `\n${theme.fg("warning", "⚠ This command requires elevated privileges the agent cannot use.")}\n${theme.fg("muted", `Run it manually in your terminal:\n  ${command}`)}`,
                        0,
                        0,
                    ),
                );
            }
        }
    }

    private getTextOutput(): string {
        if (!this.result) return "";

        const textBlocks = this.result.content?.filter((c: any) => c.type === "text") || [];
        const imageBlocks = this.result.content?.filter((c: any) => c.type === "image") || [];

        let output = textBlocks
            .map((c: any) => {
                // Use sanitizeBinaryOutput to handle binary data that crashes string-width
                return sanitizeBinaryOutput(c.text || "");
            })
            .join("\n");

        if (this.toolName === "bash") {
            output = renderTerminalText(output);
        } else {
            output = output.replace(/\r/g, "");
            output = stripAnsi(output);
        }

        const caps = getCapabilities();
        if (imageBlocks.length > 0 && (!caps.images || !this.showImages)) {
            const imageIndicators = imageBlocks
                .map((img: any) => {
                    return imageFallback(img.mimeType);
                })
                .join("\n");
            output = output ? `${output}\n${imageIndicators}` : imageIndicators;
        }

        return output;
    }

    private shouldHideCollapsedPreview(): boolean {
        // Always hide preview for read tool when not expanded (like Claude Code)
        // For other tools, only hide in minimal mode without errors
        if (this.toolName === "read") {
            return !this.expanded && !this.result?.isError;
        }
        return !this.expanded && this.renderMode === "minimal" && !this.result?.isError;
    }

    private collapsedExpandHint(_label?: string): string {
        return ""; // hint is shown in editor bottom border instead
    }

    private collapsedHintWithPrefix(prefix = "\n\n"): string {
        const hint = this.collapsedExpandHint();
        return hint ? `${prefix}${hint}` : "";
    }

    private collapsedFirstLine(output: string): string | undefined {
        const first = output.split("\n").map((line) => line.trim()).find(Boolean);
        return first ? truncateToWidth(first, 120, "...") : undefined;
    }

    private formatToolExecution(statusIndicator: string): string {
        let text = "";
        const invalidArg = theme.fg("error", "[invalid arg]");
        const hideCollapsedPreview = this.shouldHideCollapsedPreview();

        if (this.toolName === "read") {
            const rawPath = str(this.args?.file_path ?? this.args?.path);
            const path = rawPath !== null ? shortenPath(rawPath) : null;
            const offset = this.args?.offset;
            const limit = this.args?.limit;

            const startLine = offset ?? 1;
            const endLine = limit !== undefined ? startLine + limit - 1 : "";
            const lineNum = offset !== undefined ? startLine : undefined;

            let styledPath = path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
            if (rawPath && path) {
                styledPath = editorLink(rawPath, styledPath, { cwd: this.cwd, line: lineNum, scheme: this.editorScheme });
            }
            let pathDisplay = styledPath;
            if (offset !== undefined || limit !== undefined) {
                pathDisplay += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
            }

            text = `${statusIndicator} ${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}`;

            if (this.result) {
                const rawOutput = this.getTextOutput();
                // Strip hashline prefixes (e.g. "1#BQ:content") for TUI display
                const output = rawOutput.replace(/^(\s*)\d+#[ZPMQVRWSNKTXJBYH]{2}:/gm, "$1");
                const rawPath = str(this.args?.file_path ?? this.args?.path);
                const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
                const lines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");

                if (hideCollapsedPreview) {
                    if (output.trim()) {
                        text += this.collapsedHintWithPrefix();
                    }
                } else {
                    const maxLines = this.expanded ? lines.length : 10;
                    const displayLines = lines.slice(0, maxLines);
                    const remaining = lines.length - maxLines;

                    text +=
                        "\n\n" +
                        displayLines
                            .map((line: string) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line))))
                            .join("\n");
                    if (remaining > 0) {
                        text += theme.fg("muted", `\n... (${remaining} more lines)`);
                    }
                }

                const truncation = this.result.details?.truncation;
                if (truncation?.truncated) {
                    if (truncation.firstLineExceedsLimit) {
                        text +=
                            "\n" +
                            theme.fg(
                                "warning",
                                `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`,
                            );
                    } else if (truncation.truncatedBy === "lines") {
                        text +=
                            "\n" +
                            theme.fg(
                                "warning",
                                `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`,
                            );
                    } else {
                        text +=
                            "\n" +
                            theme.fg(
                                "warning",
                                `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`,
                            );
                    }
                }
            }
        } else if (this.toolName === "write") {
            const rawPath = str(this.args?.file_path ?? this.args?.path);
            const fileContent = str(this.args?.content);
            const path = rawPath !== null ? shortenPath(rawPath) : null;
            const firstChangedLine = this.writeDiffPreview && "firstChangedLine" in this.writeDiffPreview
                ? this.writeDiffPreview.firstChangedLine
                : undefined;

            let writePathDisplay = path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
            if (rawPath && path) {
                writePathDisplay = editorLink(rawPath, writePathDisplay, {
                    cwd: this.cwd,
                    line: firstChangedLine ?? undefined,
                    scheme: this.editorScheme,
                });
            }
            if (firstChangedLine) {
                writePathDisplay += theme.fg("warning", `:${firstChangedLine}`);
            }
            text = `${statusIndicator} ${theme.fg("toolTitle", theme.bold("write"))} ${writePathDisplay}`;

            if (fileContent === null) {
                text += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
            } else if (this.result?.isError) {
                const errorText = this.getTextOutput();
                if (errorText) {
                    text += `\n\n${theme.fg("error", errorText)}`;
                }
            } else if (!this.isPartial && this.writeDiffPreview) {
                if ("error" in this.writeDiffPreview) {
                    text += `\n\n${theme.fg("error", this.writeDiffPreview.error)}`;
                } else if (this.writeDiffPreview.diff) {
                    text += hideCollapsedPreview
                        ? this.collapsedHintWithPrefix()
                        : `\n\n${renderDiff(this.writeDiffPreview.diff, { filePath: rawPath ?? undefined })}`;
                }
            } else if (fileContent) {
                const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;

                let lines: string[];
                if (lang) {
                    const cache = this.writeHighlightCache;
                    if (cache && cache.lang === lang && cache.rawPath === rawPath && cache.rawContent === fileContent) {
                        lines = cache.highlightedLines;
                    } else {
                        const displayContent = normalizeDisplayText(fileContent);
                        const normalized = replaceTabs(displayContent);
                        lines = highlightCode(normalized, lang);
                        this.writeHighlightCache = {
                            rawPath,
                            lang,
                            rawContent: fileContent,
                            normalizedLines: normalized.split("\n"),
                            highlightedLines: lines,
                        };
                    }
                } else {
                    lines = normalizeDisplayText(fileContent).split("\n");
                    this.writeHighlightCache = undefined;
                }

                if (hideCollapsedPreview) {
                    text += this.collapsedHintWithPrefix();
                } else {
                    const totalLines = lines.length;
                    const maxLines = this.expanded ? lines.length : 10;
                    const displayLines = lines.slice(0, maxLines);
                    const remaining = lines.length - maxLines;

                    text +=
                        "\n\n" +
                        displayLines.map((line: string) => (lang ? line : theme.fg("toolOutput", replaceTabs(line)))).join("\n");
                    if (remaining > 0) {
                        text += theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total)`);
                    }
                }
            }
        } else if (this.toolName === "edit") {
            const rawPath = str(this.args?.file_path ?? this.args?.path);
            const path = rawPath !== null ? shortenPath(rawPath) : null;

            // Build path display, appending :line if we have diff info
            const firstChangedLine =
                (this.editDiffPreview && "firstChangedLine" in this.editDiffPreview
                    ? this.editDiffPreview.firstChangedLine
                    : undefined) ||
                (this.result && !this.result.isError ? this.result.details?.firstChangedLine : undefined);

            let styledEditPath = path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
            if (rawPath && path) {
                styledEditPath = editorLink(rawPath, styledEditPath, {
                    cwd: this.cwd,
                    line: firstChangedLine ?? undefined,
                    scheme: this.editorScheme,
                });
            }
            let pathDisplay = styledEditPath;
            if (firstChangedLine) {
                pathDisplay += theme.fg("warning", `:${firstChangedLine}`);
            }

            text = `${statusIndicator} ${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;

            if (this.result?.isError) {
                // Show error from result
                const errorText = this.getTextOutput();
                if (errorText) {
                    text += `\n\n${theme.fg("error", errorText)}`;
                }
            } else if (this.result?.details?.diff) {
                // Tool executed successfully - use the diff from result
                // This takes priority over editDiffPreview which may have a stale error
                // due to race condition (async preview computed after file was modified)
                text += hideCollapsedPreview
                    ? this.collapsedHintWithPrefix()
                    : `\n\n${renderDiff(this.result.details.diff, { filePath: rawPath ?? undefined })}`;
            } else if (this.editDiffPreview) {
                // Use cached diff preview (before tool executes)
                if ("error" in this.editDiffPreview) {
                    text += `\n\n${theme.fg("error", this.editDiffPreview.error)}`;
                } else if (this.editDiffPreview.diff) {
                    text += hideCollapsedPreview
                        ? this.collapsedHintWithPrefix()
                        : `\n\n${renderDiff(this.editDiffPreview.diff, { filePath: rawPath ?? undefined })}`;
                }
            }
        } else if (this.toolName === "ls") {
            const rawPath = str(this.args?.path);
            const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
            const limit = this.args?.limit;

            let lsPathDisplay = path === null ? invalidArg : theme.fg("accent", path);
            if (path && rawPath !== null) {
                lsPathDisplay = editorLink(rawPath || ".", lsPathDisplay, { cwd: this.cwd, scheme: this.editorScheme });
            }
            text = `${statusIndicator} ${theme.fg("toolTitle", theme.bold("ls"))} ${lsPathDisplay}`;
            if (limit !== undefined) {
                text += theme.fg("toolOutput", ` (limit ${limit})`);
            }

            if (this.result) {
                const output = this.getTextOutput().trim();
                if (output) {
                    if (hideCollapsedPreview) {
                        text += this.collapsedHintWithPrefix();
                    } else {
                        const lines = output.split("\n");
                        const maxLines = this.expanded ? lines.length : 20;
                        const displayLines = lines.slice(0, maxLines);
                        const remaining = lines.length - maxLines;

                        text += `\n\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
                        if (remaining > 0) {
                            text += theme.fg("muted", `\n... (${remaining} more lines)`);
                        }
                    }
                }

                const entryLimit = this.result.details?.entryLimitReached;
                const truncation = this.result.details?.truncation;
                if (entryLimit || truncation?.truncated) {
                    const warnings: string[] = [];
                    if (entryLimit) {
                        warnings.push(`${entryLimit} entries limit`);
                    }
                    if (truncation?.truncated) {
                        warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
                    }
                    text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
                }
            }
        } else if (this.toolName === "find") {
            const pattern = str(this.args?.pattern);
            const rawPath = str(this.args?.path);
            const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
            const limit = this.args?.limit;

            let findPathDisplay = path === null ? invalidArg : path;
            if (path && rawPath !== null) {
                findPathDisplay = editorLink(rawPath || ".", theme.fg("accent", findPathDisplay), { cwd: this.cwd, scheme: this.editorScheme });
            } else {
                findPathDisplay = theme.fg("accent", findPathDisplay);
            }
            text =
                `${statusIndicator} ${theme.fg("toolTitle", theme.bold("find"))}` +
                " " +
                (pattern === null ? invalidArg : theme.fg("accent", pattern || "")) +
                theme.fg("toolOutput", " in ") +
                findPathDisplay;
            if (limit !== undefined) {
                text += theme.fg("toolOutput", ` (limit ${limit})`);
            }

            if (this.result) {
                const output = this.getTextOutput().trim();
                if (output) {
                    if (hideCollapsedPreview) {
                        text += this.collapsedHintWithPrefix();
                    } else {
                        const lines = output.split("\n");
                        const maxLines = this.expanded ? lines.length : 20;
                        const displayLines = lines.slice(0, maxLines);
                        const remaining = lines.length - maxLines;

                        text += `\n\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
                        if (remaining > 0) {
                            text += theme.fg("muted", `\n... (${remaining} more lines)`);
                        }
                    }
                }

                const resultLimit = this.result.details?.resultLimitReached;
                const truncation = this.result.details?.truncation;
                if (resultLimit || truncation?.truncated) {
                    const warnings: string[] = [];
                    if (resultLimit) {
                        warnings.push(`${resultLimit} results limit`);
                    }
                    if (truncation?.truncated) {
                        warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
                    }
                    text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
                }
            }
        } else if (this.toolName === "grep") {
            const pattern = str(this.args?.pattern);
            const rawPath = str(this.args?.path);
            const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
            const glob = str(this.args?.glob);
            const limit = this.args?.limit;

            let grepPathDisplay = path === null ? invalidArg : path;
            if (path && rawPath !== null) {
                grepPathDisplay = editorLink(rawPath || ".", theme.fg("accent", grepPathDisplay), { cwd: this.cwd, scheme: this.editorScheme });
            } else {
                grepPathDisplay = theme.fg("accent", grepPathDisplay);
            }
            text =
                `${statusIndicator} ${theme.fg("toolTitle", theme.bold("grep"))}` +
                " " +
                (pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
                theme.fg("toolOutput", " in ") +
                grepPathDisplay;
            if (glob) {
                text += theme.fg("toolOutput", ` (${glob})`);
            }
            if (limit !== undefined) {
                text += theme.fg("toolOutput", ` limit ${limit}`);
            }

            if (this.result) {
                const output = this.getTextOutput().trim();
                if (output) {
                    if (hideCollapsedPreview) {
                        text += this.collapsedHintWithPrefix();
                    } else {
                        const lines = output.split("\n");
                        const maxLines = this.expanded ? lines.length : 15;
                        const displayLines = lines.slice(0, maxLines);
                        const remaining = lines.length - maxLines;

                        text += `\n\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
                        if (remaining > 0) {
                            text += theme.fg("muted", `\n... (${remaining} more lines)`);
                        }
                    }
                }

                const matchLimit = this.result.details?.matchLimitReached;
                const truncation = this.result.details?.truncation;
                const linesTruncated = this.result.details?.linesTruncated;
                if (matchLimit || truncation?.truncated || linesTruncated) {
                    const warnings: string[] = [];
                    if (matchLimit) {
                        warnings.push(`${matchLimit} matches limit`);
                    }
                    if (truncation?.truncated) {
                        warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
                    }
                    if (linesTruncated) {
                        warnings.push("some lines truncated");
                    }
                    text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
                }
            }
        } else if (this.toolName === "web_search") {
            // Server-side Anthropic web search
            text = `${statusIndicator} ${theme.fg("toolTitle", theme.bold("web search"))}`;

            if (process.env.PI_OFFLINE === "1") {
                text += "\n\n" + theme.fg("muted", "\u{1F50C} Offline \u{2014} web search unavailable");
            } else if (this.result) {
                const output = this.getTextOutput().trim();
                if (output) {
                    if (hideCollapsedPreview) {
                        text += this.collapsedHintWithPrefix();
                    } else {
                        const lines = output.split("\n");
                        const maxLines = this.expanded ? lines.length : 10;
                        const displayLines = lines.slice(0, maxLines);
                        const remaining = lines.length - maxLines;

                        text += `\n\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
                        if (remaining > 0) {
                            text += theme.fg("muted", `\n... (${remaining} more lines)`);
                        }
                    }
                }
            }
        } else if (this.toolName === "lsp") {
            const action = this.args?.action as string | undefined;
            const file = this.args?.file as string | undefined;
            const line = this.args?.line as number | undefined;
            const symbol = this.args?.symbol as string | undefined;
            const query = this.args?.query as string | undefined;
            const newName = this.args?.new_name as string | undefined;

            text = `${statusIndicator} ${theme.fg("toolTitle", theme.bold("lsp"))}`;
            if (action) text += ` ${theme.fg("accent", action)}`;
            if (file) {
                const shortFile = shortenPath(file);
                let styledFile = theme.fg("muted", shortFile);
                if (file && shortFile) {
                    styledFile = editorLink(file, styledFile, { cwd: this.cwd, line, scheme: this.editorScheme });
                }
                text += ` ${styledFile}`;
                if (line !== undefined) text += theme.fg("warning", `:${line}`);
            }
            if (symbol) text += ` ${theme.fg("toolOutput", symbol)}`;
            if (query) text += ` ${theme.fg("muted", `"${query}"`)}`;
            if (newName) text += ` → ${theme.fg("accent", newName)}`;

            if (this.result) {
                const output = this.getTextOutput().trim();
                if (output) {
                    if (hideCollapsedPreview) {
                        text += this.collapsedHintWithPrefix();
                    } else {
                        const lines = output.split("\n");
                        const maxLines = this.expanded ? lines.length : 10;
                        const displayLines = lines.slice(0, maxLines);
                        const remaining = lines.length - maxLines;
                        text += `\n\n${displayLines.map((l: string) => theme.fg("toolOutput", l)).join("\n")}`;
                        if (remaining > 0) text += theme.fg("muted", `\n... (${remaining} more lines)`);
                    }
                }
            }
        } else {
            // Generic tool (shouldn't reach here for custom tools)
            text = `${statusIndicator} ${theme.fg("toolTitle", theme.bold(this.toolName))}`;

            const content = JSON.stringify(this.args, null, 2);
            text += hideCollapsedPreview ? this.collapsedHintWithPrefix() : `\n\n${content}`;
            const output = this.getTextOutput();
            if (output && !hideCollapsedPreview) {
                text += `\n${output}`;
            }
        }

        return text;
    }
}
