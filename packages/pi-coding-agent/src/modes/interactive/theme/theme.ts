import * as fs from "node:fs";
import * as path from "node:path";
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@gsd/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import chalk from "chalk";
import {
	highlightCode as nativeHighlightCode,
	supportsLanguage,
	type HighlightColors,
} from "@gsd/native";
import { getCustomThemesDir } from "../../../config.js";
import { builtinThemes } from "./themes.js";
import { editorLink, detectEditorScheme } from "../utils/editor-link.js";

// Issue #453: native preview highlighting can wedge the entire interactive
// session after a successful file tool. Keep the safer plain-text path as the
// default and allow native highlighting only as an explicit opt-in.
const NATIVE_TUI_HIGHLIGHT_ENABLED = process.env.GSD_ENABLE_NATIVE_TUI_HIGHLIGHT === "1";

// ============================================================================
// Types & Schema
// ============================================================================

const ColorValueSchema = Type.Union([
	Type.String(), // hex "#ff0000", var ref "primary", or empty ""
	Type.Integer({ minimum: 0, maximum: 255 }), // 256-color index
]);

type ColorValue = Static<typeof ColorValueSchema>;

const ThemeJsonSchema = Type.Object({
	$schema: Type.Optional(Type.String()),
	name: Type.String(),
	vars: Type.Optional(Type.Record(Type.String(), ColorValueSchema)),
	colors: Type.Object({
		// Core UI (10 colors)
		accent: ColorValueSchema,
		border: ColorValueSchema,
		borderAccent: ColorValueSchema,
		borderMuted: ColorValueSchema,
		success: ColorValueSchema,
		error: ColorValueSchema,
		warning: ColorValueSchema,
		violet: ColorValueSchema,
		muted: ColorValueSchema,
		dim: ColorValueSchema,
		text: ColorValueSchema,
		thinkingText: ColorValueSchema,
		// Backgrounds & Content Text (11 colors)
		selectedBg: ColorValueSchema,
		userMessageBg: ColorValueSchema,
		userMessageText: ColorValueSchema,
		customMessageBg: ColorValueSchema,
		customMessageText: ColorValueSchema,
		customMessageLabel: ColorValueSchema,
		toolPendingBg: ColorValueSchema,
		toolSuccessBg: ColorValueSchema,
		toolErrorBg: ColorValueSchema,
		toolTitle: ColorValueSchema,
		toolOutput: ColorValueSchema,
		// Markdown (10 colors)
		mdHeading: ColorValueSchema,
		mdLink: ColorValueSchema,
		mdLinkUrl: ColorValueSchema,
		mdCode: ColorValueSchema,
		mdCodeBlock: ColorValueSchema,
		mdCodeBlockBorder: ColorValueSchema,
		mdQuote: ColorValueSchema,
		mdQuoteBorder: ColorValueSchema,
		mdHr: ColorValueSchema,
		mdListBullet: ColorValueSchema,
		// Tool Diffs (3 colors)
		toolDiffAdded: ColorValueSchema,
		toolDiffRemoved: ColorValueSchema,
		toolDiffContext: ColorValueSchema,
		// Syntax Highlighting (9 colors)
		syntaxComment: ColorValueSchema,
		syntaxKeyword: ColorValueSchema,
		syntaxFunction: ColorValueSchema,
		syntaxVariable: ColorValueSchema,
		syntaxString: ColorValueSchema,
		syntaxNumber: ColorValueSchema,
		syntaxType: ColorValueSchema,
		syntaxOperator: ColorValueSchema,
		syntaxPunctuation: ColorValueSchema,
		// Thinking Level Borders (6 colors)
		thinkingOff: ColorValueSchema,
		thinkingMinimal: ColorValueSchema,
		thinkingLow: ColorValueSchema,
		thinkingMedium: ColorValueSchema,
		thinkingHigh: ColorValueSchema,
		thinkingXhigh: ColorValueSchema,
		// Bash Mode (1 color)
		bashMode: ColorValueSchema,
	}),
	export: Type.Optional(
		Type.Object({
			pageBg: Type.Optional(ColorValueSchema),
			cardBg: Type.Optional(ColorValueSchema),
			infoBg: Type.Optional(ColorValueSchema),
		}),
	),
});

export type ThemeJson = Static<typeof ThemeJsonSchema>;

const validateThemeJson = TypeCompiler.Compile(ThemeJsonSchema);

export type ThemeColor =
	| "accent"
	| "border"
	| "borderAccent"
	| "borderMuted"
	| "success"
	| "error"
	| "warning"
	| "violet"
	| "muted"
	| "dim"
	| "text"
	| "thinkingText"
	| "userMessageText"
	| "customMessageText"
	| "customMessageLabel"
	| "toolTitle"
	| "toolOutput"
	| "mdHeading"
	| "mdLink"
	| "mdLinkUrl"
	| "mdCode"
	| "mdCodeBlock"
	| "mdCodeBlockBorder"
	| "mdQuote"
	| "mdQuoteBorder"
	| "mdHr"
	| "mdListBullet"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffContext"
	| "syntaxComment"
	| "syntaxKeyword"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxType"
	| "syntaxOperator"
	| "syntaxPunctuation"
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "bashMode";

export type ThemeBg =
	| "selectedBg"
	| "userMessageBg"
	| "customMessageBg"
	| "toolPendingBg"
	| "toolSuccessBg"
	| "toolErrorBg";

type ColorMode = "truecolor" | "256color";

export const THEME_ACCENT_PRESETS = ["default", "golden-yellow", "blue", "green", "violet", "red"] as const;

export type ThemeAccentPreset = (typeof THEME_ACCENT_PRESETS)[number];

export interface ThemeAccentInfo {
	label: string;
	description: string;
	accent: string | undefined;
	thinking: readonly string[] | undefined;
}

type ResolvedThemeAccentPreset = Exclude<ThemeAccentPreset, "default">;

const THEME_ACCENT_INFO: Record<ThemeAccentPreset, ThemeAccentInfo> = {
	default: {
		label: "Default",
		description: "Use the active theme’s native accent colors.",
		accent: undefined,
		thinking: undefined,
	},
	"golden-yellow": {
		label: "Golden yellow",
		description: "Warm amber accent (#F59E0B).",
		accent: "#F59E0B",
		thinking: ["#92400E", "#B45309", "#D97706", "#F59E0B", "#FBBF24", "#FCD34D"],
	},
	blue: {
		label: "Blue",
		description: "Bright blue accent (#60A5FA).",
		accent: "#60A5FA",
		thinking: ["#1D4ED8", "#2563EB", "#3B82F6", "#60A5FA", "#93C5FD", "#BFDBFE"],
	},
	green: {
		label: "Green",
		description: "Emerald accent (#34D399).",
		accent: "#34D399",
		thinking: ["#047857", "#059669", "#10B981", "#34D399", "#6EE7B7", "#A7F3D0"],
	},
	violet: {
		label: "Violet",
		description: "Soft violet accent (#A78BFA).",
		accent: "#A78BFA",
		thinking: ["#6D28D9", "#7C3AED", "#8B5CF6", "#A78BFA", "#C4B5FD", "#DDD6FE"],
	},
	red: {
		label: "Red",
		description: "Coral red accent (#F87171).",
		accent: "#F87171",
		thinking: ["#B91C1C", "#DC2626", "#EF4444", "#F87171", "#FCA5A5", "#FECACA"],
	},
};

export function getThemeAccentInfo(accent: ThemeAccentPreset): ThemeAccentInfo {
	return THEME_ACCENT_INFO[accent];
}

export function getThemeAccentLabel(accent: ThemeAccentPreset): string {
	return THEME_ACCENT_INFO[accent].label;
}

export function getAvailableThemeAccents(): ThemeAccentPreset[] {
	return [...THEME_ACCENT_PRESETS];
}

function isThemeAccentPreset(value: string | undefined): value is ThemeAccentPreset {
	return value !== undefined && THEME_ACCENT_PRESETS.includes(value as ThemeAccentPreset);
}

function normalizeThemeAccent(accent: string | undefined): ResolvedThemeAccentPreset | undefined {
	if (accent === undefined || accent === "default" || !isThemeAccentPreset(accent)) {
		return undefined;
	}
	return accent as ResolvedThemeAccentPreset;
}

// ============================================================================
// Color Utilities
// ============================================================================

function detectColorMode(): ColorMode {
	const colorterm = process.env.COLORTERM;
	if (colorterm === "truecolor" || colorterm === "24bit") {
		return "truecolor";
	}
	// Windows Terminal supports truecolor
	if (process.env.WT_SESSION) {
		return "truecolor";
	}
	const term = process.env.TERM || "";
	// Fall back to 256color for truly limited terminals
	if (term === "dumb" || term === "" || term === "linux") {
		return "256color";
	}
	// Terminal.app also doesn't support truecolor
	if (process.env.TERM_PROGRAM === "Apple_Terminal") {
		return "256color";
	}
	// GNU screen doesn't support truecolor unless explicitly opted in via COLORTERM=truecolor.
	// TERM under screen is typically "screen", "screen-256color", or "screen.xterm-256color".
	if (term === "screen" || term.startsWith("screen-") || term.startsWith("screen.")) {
		return "256color";
	}
	// Assume truecolor for everything else - virtually all modern terminals support it
	return "truecolor";
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const cleaned = hex.replace("#", "");
	if (cleaned.length !== 6) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	const r = parseInt(cleaned.substring(0, 2), 16);
	const g = parseInt(cleaned.substring(2, 4), 16);
	const b = parseInt(cleaned.substring(4, 6), 16);
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	return { r, g, b };
}

// The 6x6x6 color cube channel values (indices 0-5)
const CUBE_VALUES = [0, 95, 135, 175, 215, 255];

// Grayscale ramp values (indices 232-255, 24 grays from 8 to 238)
const GRAY_VALUES = Array.from({ length: 24 }, (_, i) => 8 + i * 10);

function findClosestCubeIndex(value: number): number {
	let minDist = Infinity;
	let minIdx = 0;
	for (let i = 0; i < CUBE_VALUES.length; i++) {
		const dist = Math.abs(value - CUBE_VALUES[i]);
		if (dist < minDist) {
			minDist = dist;
			minIdx = i;
		}
	}
	return minIdx;
}

function findClosestGrayIndex(gray: number): number {
	let minDist = Infinity;
	let minIdx = 0;
	for (let i = 0; i < GRAY_VALUES.length; i++) {
		const dist = Math.abs(gray - GRAY_VALUES[i]);
		if (dist < minDist) {
			minDist = dist;
			minIdx = i;
		}
	}
	return minIdx;
}

function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
	// Weighted Euclidean distance (human eye is more sensitive to green)
	const dr = r1 - r2;
	const dg = g1 - g2;
	const db = b1 - b2;
	return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

function rgbTo256(r: number, g: number, b: number): number {
	// Find closest color in the 6x6x6 cube
	const rIdx = findClosestCubeIndex(r);
	const gIdx = findClosestCubeIndex(g);
	const bIdx = findClosestCubeIndex(b);
	const cubeR = CUBE_VALUES[rIdx];
	const cubeG = CUBE_VALUES[gIdx];
	const cubeB = CUBE_VALUES[bIdx];
	const cubeIndex = 16 + 36 * rIdx + 6 * gIdx + bIdx;
	const cubeDist = colorDistance(r, g, b, cubeR, cubeG, cubeB);

	// Find closest grayscale
	const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
	const grayIdx = findClosestGrayIndex(gray);
	const grayValue = GRAY_VALUES[grayIdx];
	const grayIndex = 232 + grayIdx;
	const grayDist = colorDistance(r, g, b, grayValue, grayValue, grayValue);

	// Check if color has noticeable saturation (hue matters)
	// If max-min spread is significant, prefer cube to preserve tint
	const maxC = Math.max(r, g, b);
	const minC = Math.min(r, g, b);
	const spread = maxC - minC;

	// Only consider grayscale if color is nearly neutral (spread < 10)
	// AND grayscale is actually closer
	if (spread < 10 && grayDist < cubeDist) {
		return grayIndex;
	}

	return cubeIndex;
}

function hexTo256(hex: string): number {
	const { r, g, b } = hexToRgb(hex);
	return rgbTo256(r, g, b);
}

function fgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[39m";
	if (typeof color === "number") return `\x1b[38;5;${color}m`;
	if (color.startsWith("#")) {
		if (mode === "truecolor") {
			const { r, g, b } = hexToRgb(color);
			return `\x1b[38;2;${r};${g};${b}m`;
		} else {
			const index = hexTo256(color);
			return `\x1b[38;5;${index}m`;
		}
	}
	throw new Error(`Invalid color value: ${color}`);
}

function bgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[49m";
	if (typeof color === "number") return `\x1b[48;5;${color}m`;
	if (color.startsWith("#")) {
		if (mode === "truecolor") {
			const { r, g, b } = hexToRgb(color);
			return `\x1b[48;2;${r};${g};${b}m`;
		} else {
			const index = hexTo256(color);
			return `\x1b[48;5;${index}m`;
		}
	}
	throw new Error(`Invalid color value: ${color}`);
}

function resolveVarRefs(
	value: ColorValue,
	vars: Record<string, ColorValue>,
	visited = new Set<string>(),
): string | number {
	if (typeof value === "number" || value === "" || value.startsWith("#")) {
		return value;
	}
	if (visited.has(value)) {
		throw new Error(`Circular variable reference detected: ${value}`);
	}
	if (!(value in vars)) {
		throw new Error(`Variable reference not found: ${value}`);
	}
	visited.add(value);
	return resolveVarRefs(vars[value], vars, visited);
}

function resolveThemeColors<T extends Record<string, ColorValue>>(
	colors: T,
	vars: Record<string, ColorValue> = {},
): Record<keyof T, string | number> {
	const resolved: Record<string, string | number> = {};
	for (const [key, value] of Object.entries(colors)) {
		resolved[key] = resolveVarRefs(value, vars);
	}
	return resolved as Record<keyof T, string | number>;
}

// ============================================================================
// Theme Class
// ============================================================================

export class Theme {
	readonly name?: string;
	readonly sourcePath?: string;
	private fgColors: Map<ThemeColor, string>;
	private bgColors: Map<ThemeBg, string>;
	private mode: ColorMode;

	constructor(
		fgColors: Record<ThemeColor, string | number>,
		bgColors: Record<ThemeBg, string | number>,
		mode: ColorMode,
		options: { name?: string; sourcePath?: string } = {},
	) {
		this.name = options.name;
		this.sourcePath = options.sourcePath;
		this.mode = mode;
		this.fgColors = new Map();
		for (const [key, value] of Object.entries(fgColors) as [ThemeColor, string | number][]) {
			this.fgColors.set(key, fgAnsi(value, mode));
		}
		this.bgColors = new Map();
		for (const [key, value] of Object.entries(bgColors) as [ThemeBg, string | number][]) {
			this.bgColors.set(key, bgAnsi(value, mode));
		}
	}

	fg(color: ThemeColor, text: string): string {
		const ansi = this.fgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return `${ansi}${text}\x1b[39m`; // Reset only foreground color
	}

	bg(color: ThemeBg, text: string): string {
		const ansi = this.bgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return `${ansi}${text}\x1b[49m`; // Reset only background color
	}

	bold(text: string): string {
		return chalk.bold(text);
	}

	italic(text: string): string {
		return chalk.italic(text);
	}

	underline(text: string): string {
		return chalk.underline(text);
	}

	inverse(text: string): string {
		return chalk.inverse(text);
	}

	strikethrough(text: string): string {
		return chalk.strikethrough(text);
	}

	getFgAnsi(color: ThemeColor): string {
		const ansi = this.fgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return ansi;
	}

	getBgAnsi(color: ThemeBg): string {
		const ansi = this.bgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return ansi;
	}

	getColorMode(): ColorMode {
		return this.mode;
	}

	getThinkingBorderColor(level: "off" | "low" | "medium" | "high" | "xhigh" | "adaptive"): (str: string) => string {
		// Map thinking levels to dedicated theme colors
		switch (level) {
			case "off":
				return (str: string) => this.fg("thinkingOff", str);
			case "adaptive":
				return (str: string) => this.fg("thinkingHigh", str);
			case "low":
				return (str: string) => this.fg("thinkingLow", str);
			case "medium":
				return (str: string) => this.fg("thinkingMedium", str);
			case "high":
				return (str: string) => this.fg("thinkingHigh", str);
			case "xhigh":
				return (str: string) => this.fg("thinkingXhigh", str);
			default:
				return (str: string) => this.fg("thinkingOff", str);
		}
	}

	getBashModeBorderColor(): (str: string) => string {
		return (str: string) => this.fg("bashMode", str);
	}
}

// ============================================================================
// Theme Loading
// ============================================================================

function getBuiltinThemes(): Record<string, ThemeJson> {
	return builtinThemes;
}

export function getAvailableThemes(): string[] {
	const themes = new Set<string>(Object.keys(getBuiltinThemes()));
	const customThemesDir = getCustomThemesDir();
	if (fs.existsSync(customThemesDir)) {
		const files = fs.readdirSync(customThemesDir);
		for (const file of files) {
			if (file.endsWith(".json")) {
				themes.add(file.slice(0, -5));
			}
		}
	}
	for (const name of registeredThemes.keys()) {
		themes.add(name);
	}
	return Array.from(themes).sort();
}

export interface ThemeInfo {
	name: string;
	path: string | undefined;
}

export function getAvailableThemesWithPaths(): ThemeInfo[] {
	const customThemesDir = getCustomThemesDir();
	const result: ThemeInfo[] = [];

	// Built-in themes (embedded in code, no file path)
	for (const name of Object.keys(getBuiltinThemes())) {
		result.push({ name, path: undefined });
	}

	// Custom themes
	if (fs.existsSync(customThemesDir)) {
		for (const file of fs.readdirSync(customThemesDir)) {
			if (file.endsWith(".json")) {
				const name = file.slice(0, -5);
				if (!result.some((t) => t.name === name)) {
					result.push({ name, path: path.join(customThemesDir, file) });
				}
			}
		}
	}

	for (const [name, theme] of registeredThemes.entries()) {
		if (!result.some((t) => t.name === name)) {
			result.push({ name, path: theme.sourcePath });
		}
	}

	return result.sort((a, b) => a.name.localeCompare(b.name));
}

function parseThemeJson(label: string, json: unknown): ThemeJson {
	if (!validateThemeJson.Check(json)) {
		const errors = Array.from(validateThemeJson.Errors(json));
		const missingColors: string[] = [];
		const otherErrors: string[] = [];

		for (const e of errors) {
			// Check for missing required color properties
			const match = e.path.match(/^\/colors\/(\w+)$/);
			if (match && e.message.includes("Required")) {
				missingColors.push(match[1]);
			} else {
				otherErrors.push(`  - ${e.path}: ${e.message}`);
			}
		}

		let errorMessage = `Invalid theme "${label}":\n`;
		if (missingColors.length > 0) {
			errorMessage += "\nMissing required color tokens:\n";
			errorMessage += missingColors.map((c) => `  - ${c}`).join("\n");
			errorMessage += '\n\nPlease add these colors to your theme\'s "colors" object.';
			errorMessage += "\nSee the built-in dark/light themes for reference values.";
		}
		if (otherErrors.length > 0) {
			errorMessage += `\n\nOther errors:\n${otherErrors.join("\n")}`;
		}

		throw new Error(errorMessage);
	}

	return json as ThemeJson;
}

function parseThemeJsonContent(label: string, content: string): ThemeJson {
	let json: unknown;
	try {
		json = JSON.parse(content);
	} catch (error) {
		throw new Error(`Failed to parse theme ${label}: ${error}`);
	}
	return parseThemeJson(label, json);
}

function loadThemeJson(name: string): ThemeJson {
	const builtinThemes = getBuiltinThemes();
	if (name in builtinThemes) {
		return builtinThemes[name];
	}
	const registeredTheme = registeredThemes.get(name);
	if (registeredTheme?.sourcePath) {
		const content = fs.readFileSync(registeredTheme.sourcePath, "utf-8");
		return parseThemeJsonContent(registeredTheme.sourcePath, content);
	}
	if (registeredTheme) {
		throw new Error(`Theme "${name}" does not have a source path for export`);
	}
	const customThemesDir = getCustomThemesDir();
	const themePath = path.join(customThemesDir, `${name}.json`);
	if (!fs.existsSync(themePath)) {
		throw new Error(`Theme not found: ${name}`);
	}
	const content = fs.readFileSync(themePath, "utf-8");
	return parseThemeJsonContent(name, content);
}

function applyThemeAccent(themeJson: ThemeJson, accent: ResolvedThemeAccentPreset | undefined): ThemeJson {
	if (!accent) {
		return themeJson;
	}

	const accentColor = THEME_ACCENT_INFO[accent].accent!;
	const thinkingPalette = THEME_ACCENT_INFO[accent].thinking!;
	const vars = { ...(themeJson.vars ?? {}) };
	const colors = { ...themeJson.colors };
	const originalAccent = resolveVarRefs(themeJson.colors.accent, themeJson.vars ?? {});
	const accentDrivenKeys: Array<keyof ThemeJson["colors"]> = [
		"accent",
		"borderAccent",
		"mdCode",
		"mdListBullet",
		"thinkingOff",
		"thinkingMinimal",
		"thinkingLow",
		"thinkingMedium",
		"thinkingHigh",
		"thinkingXhigh",
	];

	if ("accent" in vars) {
		vars.accent = accentColor;
	}

	colors.thinkingOff = thinkingPalette[0];
	colors.thinkingMinimal = thinkingPalette[1];
	colors.thinkingLow = thinkingPalette[2];
	colors.thinkingMedium = thinkingPalette[3];
	colors.thinkingHigh = thinkingPalette[4];
	colors.thinkingXhigh = thinkingPalette[5];

	for (const key of accentDrivenKeys) {
		if (
			key === "thinkingOff" ||
			key === "thinkingMinimal" ||
			key === "thinkingLow" ||
			key === "thinkingMedium" ||
			key === "thinkingHigh" ||
			key === "thinkingXhigh"
		) {
			continue;
		}
		const currentResolved = resolveVarRefs(themeJson.colors[key], themeJson.vars ?? {});
		if (key === "accent" || key === "borderAccent" || currentResolved === originalAccent) {
			colors[key] = accentColor;
		}
	}

	return {
		...themeJson,
		vars,
		colors,
	};
}

function createTheme(
	themeJson: ThemeJson,
	mode?: ColorMode,
	sourcePath?: string,
	accent?: ResolvedThemeAccentPreset,
): Theme {
	const colorMode = mode ?? detectColorMode();
	const resolvedThemeJson = applyThemeAccent(themeJson, accent);
	const resolvedColors = resolveThemeColors(resolvedThemeJson.colors, resolvedThemeJson.vars);
	const fgColors: Record<ThemeColor, string | number> = {} as Record<ThemeColor, string | number>;
	const bgColors: Record<ThemeBg, string | number> = {} as Record<ThemeBg, string | number>;
	const bgColorKeys: Set<string> = new Set([
		"selectedBg",
		"userMessageBg",
		"customMessageBg",
		"toolPendingBg",
		"toolSuccessBg",
		"toolErrorBg",
	]);
	for (const [key, value] of Object.entries(resolvedColors)) {
		if (bgColorKeys.has(key)) {
			bgColors[key as ThemeBg] = value;
		} else {
			fgColors[key as ThemeColor] = value;
		}
	}
	return new Theme(fgColors, bgColors, colorMode, {
		name: resolvedThemeJson.name,
		sourcePath,
	});
}

export function loadThemeFromPath(themePath: string, mode?: ColorMode, accent?: ResolvedThemeAccentPreset): Theme {
	const content = fs.readFileSync(themePath, "utf-8");
	const themeJson = parseThemeJsonContent(themePath, content);
	return createTheme(themeJson, mode, themePath, accent);
}

function loadTheme(name: string, mode?: ColorMode, accent?: ResolvedThemeAccentPreset): Theme {
	const registeredTheme = registeredThemes.get(name);
	if (registeredTheme) {
		if (!accent) {
			return registeredTheme;
		}
		if (registeredTheme.sourcePath) {
			return loadThemeFromPath(registeredTheme.sourcePath, mode, accent);
		}
	}
	const themeJson = loadThemeJson(name);
	return createTheme(themeJson, mode, undefined, accent);
}

export function getThemeByName(name: string, accent?: string): Theme | undefined {
	try {
		return loadTheme(name, undefined, normalizeThemeAccent(accent));
	} catch {
		return undefined;
	}
}

function detectTerminalBackground(): "dark" | "light" {
	const colorfgbg = process.env.COLORFGBG || "";
	if (colorfgbg) {
		const parts = colorfgbg.split(";");
		if (parts.length >= 2) {
			const bg = parseInt(parts[1], 10);
			if (!Number.isNaN(bg)) {
				const result = bg < 8 ? "dark" : "light";
				return result;
			}
		}
	}
	return "dark";
}

function getDefaultTheme(): string {
	return detectTerminalBackground();
}

// ============================================================================
// Global Theme Instance
// ============================================================================

// Use globalThis to share theme across module loaders (tsx + jiti in dev mode)
const THEME_KEY = Symbol.for("@gsd/pi-coding-agent:theme");

// Export theme as a getter that reads from globalThis
// This ensures all module instances (tsx, jiti) see the same theme
export const theme: Theme = new Proxy({} as Theme, {
	get(_target, prop) {
		const t = (globalThis as Record<symbol, Theme>)[THEME_KEY];
		if (!t) throw new Error("Theme not initialized. Call initTheme() first.");
		return (t as unknown as Record<string | symbol, unknown>)[prop];
	},
});

function setGlobalTheme(t: Theme): void {
	(globalThis as Record<symbol, Theme>)[THEME_KEY] = t;
}

let currentThemeName: string | undefined;
let currentThemeAccent: ResolvedThemeAccentPreset | undefined;
let themeWatcher: fs.FSWatcher | undefined;
const onThemeChangeCallbacks = new Set<() => void>();
const registeredThemes = new Map<string, Theme>();

export function setRegisteredThemes(themes: Theme[]): void {
	registeredThemes.clear();
	for (const theme of themes) {
		if (theme.name) {
			registeredThemes.set(theme.name, theme);
		}
	}
}

export function initTheme(themeName?: string, enableWatcher: boolean = false, accent?: string): void {
	const name = themeName ?? getDefaultTheme();
	const normalizedAccent = normalizeThemeAccent(accent);
	currentThemeName = name;
	currentThemeAccent = normalizedAccent;
	try {
		setGlobalTheme(loadTheme(name, undefined, normalizedAccent));
		if (enableWatcher) {
			startThemeWatcher();
		}
	} catch (_error) {
		// Theme is invalid - fall back to dark theme silently
		currentThemeName = "dark";
		setGlobalTheme(loadTheme("dark", undefined, normalizedAccent));
		// Don't start watcher for fallback theme
	}
}

export function setTheme(name: string, enableWatcher: boolean = false, accent?: string): { success: boolean; error?: string } {
	const normalizedAccent = normalizeThemeAccent(accent);
	currentThemeName = name;
	currentThemeAccent = normalizedAccent;
	try {
		setGlobalTheme(loadTheme(name, undefined, normalizedAccent));
		if (enableWatcher) {
			startThemeWatcher();
		}
		onThemeChangeCallbacks.forEach(cb => cb());
		return { success: true };
	} catch (error) {
		// Theme is invalid - fall back to dark theme
		currentThemeName = "dark";
		setGlobalTheme(loadTheme("dark", undefined, normalizedAccent));
		// Don't start watcher for fallback theme
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function setThemeInstance(themeInstance: Theme): void {
	setGlobalTheme(themeInstance);
	currentThemeName = "<in-memory>";
	stopThemeWatcher(); // Can't watch a direct instance
	onThemeChangeCallbacks.forEach(cb => cb());
}

export function onThemeChange(callback: () => void): () => void {
	onThemeChangeCallbacks.add(callback);
	return () => { onThemeChangeCallbacks.delete(callback); };
}

function startThemeWatcher(): void {
	// Stop existing watcher if any
	if (themeWatcher) {
		themeWatcher.close();
		themeWatcher = undefined;
	}

	// Only watch if it's a custom theme (not built-in)
	if (!currentThemeName || currentThemeName === "dark" || currentThemeName === "light") {
		return;
	}

	const customThemesDir = getCustomThemesDir();
	const themeFile = path.join(customThemesDir, `${currentThemeName}.json`);

	// Only watch if the file exists
	if (!fs.existsSync(themeFile)) {
		return;
	}

	try {
		themeWatcher = fs.watch(themeFile, (eventType) => {
			if (eventType === "change") {
				// Debounce rapid changes
				setTimeout(() => {
					try {
						// Reload the theme
						setGlobalTheme(loadTheme(currentThemeName!, undefined, currentThemeAccent));
						// Notify callbacks (to invalidate UI)
						onThemeChangeCallbacks.forEach(cb => cb());
					} catch (_error) {
						// Ignore errors (file might be in invalid state while being edited)
					}
				}, 100);
			} else if (eventType === "rename") {
				// File was deleted or renamed - fall back to default theme
				setTimeout(() => {
					if (!fs.existsSync(themeFile)) {
						currentThemeName = "dark";
						setGlobalTheme(loadTheme("dark", undefined, currentThemeAccent));
						if (themeWatcher) {
							themeWatcher.close();
							themeWatcher = undefined;
						}
						onThemeChangeCallbacks.forEach(cb => cb());
					}
				}, 100);
			}
		});
	} catch (_error) {
		// Ignore errors starting watcher
	}
}

export function stopThemeWatcher(): void {
	if (themeWatcher) {
		themeWatcher.close();
		themeWatcher = undefined;
	}
}

// ============================================================================
// HTML Export Helpers
// ============================================================================

/**
 * Convert a 256-color index to hex string.
 * Indices 0-15: basic colors (approximate)
 * Indices 16-231: 6x6x6 color cube
 * Indices 232-255: grayscale ramp
 */
function ansi256ToHex(index: number): string {
	// Basic colors (0-15) - approximate common terminal values
	const basicColors = [
		"#000000",
		"#800000",
		"#008000",
		"#808000",
		"#000080",
		"#800080",
		"#008080",
		"#c0c0c0",
		"#808080",
		"#ff0000",
		"#00ff00",
		"#ffff00",
		"#0000ff",
		"#ff00ff",
		"#00ffff",
		"#ffffff",
	];
	if (index < 16) {
		return basicColors[index];
	}

	// Color cube (16-231): 6x6x6 = 216 colors
	if (index < 232) {
		const cubeIndex = index - 16;
		const r = Math.floor(cubeIndex / 36);
		const g = Math.floor((cubeIndex % 36) / 6);
		const b = cubeIndex % 6;
		const toHex = (n: number) => (n === 0 ? 0 : 55 + n * 40).toString(16).padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}

	// Grayscale (232-255): 24 shades
	const gray = 8 + (index - 232) * 10;
	const grayHex = gray.toString(16).padStart(2, "0");
	return `#${grayHex}${grayHex}${grayHex}`;
}

/**
 * Get resolved theme colors as CSS-compatible hex strings.
 * Used by HTML export to generate CSS custom properties.
 */
export function getResolvedThemeColors(themeName?: string): Record<string, string> {
	const name = themeName ?? currentThemeName ?? getDefaultTheme();
	const isLight = name === "light";
	const themeJson = applyThemeAccent(loadThemeJson(name), currentThemeAccent);
	const resolved = resolveThemeColors(themeJson.colors, themeJson.vars);

	// Default text color for empty values (terminal uses default fg color)
	const defaultText = isLight ? "#000000" : "#e5e5e7";

	const cssColors: Record<string, string> = {};
	for (const [key, value] of Object.entries(resolved)) {
		if (typeof value === "number") {
			cssColors[key] = ansi256ToHex(value);
		} else if (value === "") {
			// Empty means default terminal color - use sensible fallback for HTML
			cssColors[key] = defaultText;
		} else {
			cssColors[key] = value;
		}
	}
	return cssColors;
}

/**
 * Get explicit export colors from theme JSON, if specified.
 * Returns undefined for each color that isn't explicitly set.
 */
export function getThemeExportColors(themeName?: string): {
	pageBg?: string;
	cardBg?: string;
	infoBg?: string;
} {
	const name = themeName ?? currentThemeName ?? getDefaultTheme();
	try {
		const themeJson = applyThemeAccent(loadThemeJson(name), currentThemeAccent);
		const exportSection = themeJson.export;
		if (!exportSection) return {};

		const vars = themeJson.vars ?? {};
		const resolve = (value: string | number | undefined): string | undefined => {
			if (value === undefined) return undefined;
			if (typeof value === "number") return ansi256ToHex(value);
			if (value.startsWith("$")) {
				const resolved = vars[value];
				if (resolved === undefined) return undefined;
				if (typeof resolved === "number") return ansi256ToHex(resolved);
				return resolved;
			}
			return value;
		};

		return {
			pageBg: resolve(exportSection.pageBg),
			cardBg: resolve(exportSection.cardBg),
			infoBg: resolve(exportSection.infoBg),
		};
	} catch {
		return {};
	}
}

// ============================================================================
// TUI Helpers
// ============================================================================

let cachedHighlightColorsFor: Theme | undefined;
let cachedHighlightColors: HighlightColors | undefined;

function buildHighlightColors(t: Theme): HighlightColors {
	return {
		comment: t.getFgAnsi("syntaxComment"),
		keyword: t.getFgAnsi("syntaxKeyword"),
		function: t.getFgAnsi("syntaxFunction"),
		variable: t.getFgAnsi("syntaxVariable"),
		string: t.getFgAnsi("syntaxString"),
		number: t.getFgAnsi("syntaxNumber"),
		type: t.getFgAnsi("syntaxType"),
		operator: t.getFgAnsi("syntaxOperator"),
		punctuation: t.getFgAnsi("syntaxPunctuation"),
	};
}

function getHighlightColors(t: Theme): HighlightColors {
	if (cachedHighlightColorsFor !== t || !cachedHighlightColors) {
		cachedHighlightColorsFor = t;
		cachedHighlightColors = buildHighlightColors(t);
	}
	return cachedHighlightColors;
}

/**
 * Highlight code with syntax coloring based on file extension or language.
 * Returns array of highlighted lines.
 */
export function highlightCode(code: string, lang?: string): string[] {
	if (!NATIVE_TUI_HIGHLIGHT_ENABLED) {
		return code.split("\n");
	}

	const validLang = lang && supportsLanguage(lang) ? lang : null;
	try {
		return nativeHighlightCode(code, validLang, getHighlightColors(theme)).split("\n");
	} catch {
		return code.split("\n");
	}
}

/**
 * Get language identifier from file path extension.
 */
export function getLanguageFromPath(filePath: string): string | undefined {
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext) return undefined;

	const extToLang: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		py: "python",
		rb: "ruby",
		rs: "rust",
		go: "go",
		java: "java",
		kt: "kotlin",
		swift: "swift",
		c: "c",
		h: "c",
		cpp: "cpp",
		cc: "cpp",
		cxx: "cpp",
		hpp: "cpp",
		cs: "csharp",
		php: "php",
		sh: "bash",
		bash: "bash",
		zsh: "bash",
		fish: "fish",
		ps1: "powershell",
		sql: "sql",
		html: "html",
		htm: "html",
		css: "css",
		scss: "scss",
		sass: "sass",
		less: "less",
		json: "json",
		yaml: "yaml",
		yml: "yaml",
		toml: "toml",
		xml: "xml",
		md: "markdown",
		markdown: "markdown",
		dockerfile: "dockerfile",
		makefile: "makefile",
		cmake: "cmake",
		lua: "lua",
		perl: "perl",
		r: "r",
		scala: "scala",
		clj: "clojure",
		ex: "elixir",
		exs: "elixir",
		erl: "erlang",
		hs: "haskell",
		ml: "ocaml",
		vim: "vim",
		graphql: "graphql",
		proto: "protobuf",
		tf: "hcl",
		hcl: "hcl",
	};

	return extToLang[ext];
}

// File path detection regex — matches strings that look like file paths:
// - Contains a `/` or `\` separator, OR
// - Ends with a known file extension
const FILE_PATH_PATTERN = /^(?:\.{0,2}\/|~\/|[a-zA-Z]:\\)[\w\-./\\]+$|^[\w\-./]+\.(?:ts|tsx|js|jsx|json|md|yaml|yml|toml|css|scss|html|py|rs|go|rb|java|c|cpp|h|hpp|sh|bash|zsh|sql|graphql|proto|xml|svg|txt|env|lock|cfg|ini|conf|log|gitignore|dockerignore|editorconfig|prettierrc|eslintrc)$/;

function linkifyCode(rawText: string, styledText: string): string {
	// Skip empty strings
	if (!rawText) return styledText;

	// Check if it looks like a file path
	if (!FILE_PATH_PATTERN.test(rawText)) return styledText;

	// Verify file actually exists to avoid false positives
	const cwd = process.cwd();
	const absPath = path.isAbsolute(rawText) ? rawText : path.resolve(cwd, rawText);
	if (!fs.existsSync(absPath)) return styledText;

	// Wrap in editor link
	const scheme = detectEditorScheme();
	return editorLink(rawText, styledText, { cwd, scheme });
}

export function getMarkdownTheme(): MarkdownTheme {
	return {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => theme.italic(text),
		underline: (text: string) => theme.underline(text),
		strikethrough: (text: string) => chalk.strikethrough(text),
		linkifyCode,
		highlightCode: (code: string, lang?: string): string[] => {
			if (!NATIVE_TUI_HIGHLIGHT_ENABLED) {
				return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
			}

			const validLang = lang && supportsLanguage(lang) ? lang : null;
			try {
				return nativeHighlightCode(code, validLang, getHighlightColors(theme)).split("\n");
			} catch {
				return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
			}
		},
	};
}

export function getSelectListTheme(): SelectListTheme {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
	};
}

export function getEditorTheme(): EditorTheme {
	return {
		borderColor: (text: string) => theme.fg("borderMuted", text),
		selectList: getSelectListTheme(),
	};
}

export function getSettingsListTheme(): import("@gsd/pi-tui").SettingsListTheme {
	return {
		label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
		value: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text: string) => theme.fg("dim", text),
		cursor: theme.fg("accent", "→ "),
		hint: (text: string) => theme.fg("dim", text),
	};
}
