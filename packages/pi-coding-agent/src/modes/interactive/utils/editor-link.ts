import { isAbsolute, resolve } from "path";

/**
 * Editor URI schemes for Cmd+click to open files in the user's editor.
 * "auto" detects from $VISUAL / $EDITOR environment variables.
 */
export type EditorScheme = "auto" | "vscode" | "cursor" | "zed" | "jetbrains" | "sublime" | "file";

/** Detect the best editor scheme from $VISUAL / $EDITOR env vars. */
export function detectEditorScheme(): Exclude<EditorScheme, "auto"> {
	const editorEnv = (process.env.VISUAL ?? process.env.EDITOR ?? "").toLowerCase();
	if (editorEnv.includes("cursor")) return "cursor";
	if (editorEnv.includes("code")) return "vscode";
	if (editorEnv.includes("zed")) return "zed";
	if (editorEnv.includes("subl")) return "sublime";
	if (
		editorEnv.includes("idea") ||
		editorEnv.includes("webstorm") ||
		editorEnv.includes("phpstorm") ||
		editorEnv.includes("pycharm") ||
		editorEnv.includes("rubymine") ||
		editorEnv.includes("clion") ||
		editorEnv.includes("goland")
	) {
		return "jetbrains";
	}
	return "file";
}

/** Build a URI that opens `absolutePath` (with optional line number) in the target editor. */
export function buildEditorUri(
	scheme: Exclude<EditorScheme, "auto">,
	absolutePath: string,
	line?: number,
): string {
	switch (scheme) {
		case "vscode":
			return line !== undefined
				? `vscode://file${absolutePath}:${line}:1`
				: `vscode://file${absolutePath}`;
		case "cursor":
			return line !== undefined
				? `cursor://file${absolutePath}:${line}:1`
				: `cursor://file${absolutePath}`;
		case "zed":
			return line !== undefined
				? `zed://file${absolutePath}:${line}`
				: `zed://file${absolutePath}`;
		case "jetbrains":
			return line !== undefined
				? `jetbrains://open?file=${encodeURIComponent(absolutePath)}&line=${line}`
				: `jetbrains://open?file=${encodeURIComponent(absolutePath)}`;
		case "sublime":
			return line !== undefined
				? `subl://open?url=${encodeURIComponent(`file://${absolutePath}`)}&line=${line}`
				: `subl://open?url=${encodeURIComponent(`file://${absolutePath}`)}`;
		case "file":
		default:
			return `file://${absolutePath}`;
	}
}

/**
 * Wrap `displayText` in an OSC 8 hyperlink that opens `filePath` in the user's editor.
 *
 * Terminals that don't support OSC 8 silently ignore the escape sequences — zero
 * visual regression. Width calculations in the native Rust module already treat
 * OSC 8 as zero-width.
 *
 * @param filePath    Absolute or relative file path.
 * @param displayText Pre-styled ANSI string to show as the clickable label.
 * @param options.cwd    Working directory for resolving relative paths (default: process.cwd()).
 * @param options.line   Optional 1-based line number to jump to.
 * @param options.scheme Override the editor scheme (default: "auto" — detect from env).
 */
export function editorLink(
	filePath: string,
	displayText: string,
	options: {
		cwd?: string;
		line?: number;
		scheme?: EditorScheme;
	} = {},
): string {
	// Skip empty or obviously invalid paths
	if (!filePath) return displayText;

	const { cwd = process.cwd(), line, scheme = "auto" } = options;

	// Resolve to absolute path
	const absolutePath = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);

	// Resolve scheme
	const resolvedScheme: Exclude<EditorScheme, "auto"> =
		scheme === "auto" ? detectEditorScheme() : scheme;

	const uri = buildEditorUri(resolvedScheme, absolutePath, line);

	// OSC 8 hyperlink: ESC ] 8 ; params ; uri BEL  text  ESC ] 8 ; ; BEL
	return `\x1b]8;;${uri}\x07${displayText}\x1b]8;;\x07`;
}
