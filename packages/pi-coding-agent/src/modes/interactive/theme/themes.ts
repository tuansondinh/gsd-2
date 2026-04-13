/**
 * Built-in theme definitions.
 *
 * Each theme is a self-contained record of color values. Variable references
 * (e.g. "accent") are resolved against the `vars` map at load time by the
 * theme engine in theme.ts.
 *
 * To add a new built-in theme, add an entry to `builtinThemes` below.
 */

// Re-use the ThemeJson type from the schema defined in theme.ts.
// We import only the type to avoid circular runtime dependencies.
import type { ThemeJson } from "./theme.js";

// ---------------------------------------------------------------------------
// Dark theme
// ---------------------------------------------------------------------------

const dark: ThemeJson = {
	name: "dark",
	vars: {
		cyan: "#4a8cf7",
		blue: "#4a8cf7",
		green: "#b5bd68",
		red: "#cc6666",
		yellow: "#facc15",
		violet: "#a78bfa",
		gray: "#bec8d6",
		dimGray: "#8793a3",
		darkGray: "#505050",
		accent: "#60a5fa",
		blueMuted: "#1e3a8a",
		blueLow: "#2563eb",
		blueMedium: "#4a8cf7",
		blueHigh: "#60a5fa",
		blueXhigh: "#93c5fd",
		selectedBg: "#323640",
		userMsgBg: "#272727",
		toolPendingBg: "#1e2230",
		toolSuccessBg: "#1a2330",
		toolErrorBg: "#2a1e30",
		customMsgBg: "#2d2838",
	},
	colors: {
		accent: "accent",
		border: "blue",
		borderAccent: "cyan",
		borderMuted: "blue",
		success: "green",
		error: "red",
		warning: "yellow",
		violet: "violet",
		muted: "gray",
		dim: "dimGray",
		text: "",
		thinkingText: "gray",

		selectedBg: "selectedBg",
		userMessageBg: "userMsgBg",
		userMessageText: "",
		customMessageBg: "customMsgBg",
		customMessageText: "",
		customMessageLabel: "#9575cd",
		toolPendingBg: "toolPendingBg",
		toolSuccessBg: "toolSuccessBg",
		toolErrorBg: "toolErrorBg",
		toolTitle: "",
		toolOutput: "gray",

		mdHeading: "#f0c674",
		mdLink: "#5a8aaa",
		mdLinkUrl: "dimGray",
		mdCode: "accent",
		mdCodeBlock: "green",
		mdCodeBlockBorder: "gray",
		mdQuote: "gray",
		mdQuoteBorder: "gray",
		mdHr: "gray",
		mdListBullet: "accent",

		toolDiffAdded: "#4ade80",
		toolDiffRemoved: "#fb7185",
		toolDiffContext: "gray",

		syntaxComment: "#6A9955",
		syntaxKeyword: "#569CD6",
		syntaxFunction: "#DCDCAA",
		syntaxVariable: "#9CDCFE",
		syntaxString: "#CE9178",
		syntaxNumber: "#B5CEA8",
		syntaxType: "#4EC9B0",
		syntaxOperator: "#D4D4D4",
		syntaxPunctuation: "#D4D4D4",

		thinkingOff: "blueMuted",
		thinkingMinimal: "blueLow",
		thinkingLow: "blueMedium",
		thinkingMedium: "blueHigh",
		thinkingHigh: "blueXhigh",
		thinkingXhigh: "cyan",

		bashMode: "accent",
	},
	export: {
		pageBg: "#18181e",
		cardBg: "#1e1e24",
		infoBg: "#3c3728",
	},
};

// ---------------------------------------------------------------------------
// Light theme
// ---------------------------------------------------------------------------

const light: ThemeJson = {
	name: "light",
	vars: {
		teal: "#3b82f6",
		blue: "#547da7",
		green: "#588458",
		red: "#aa5555",
		yellow: "#eab308",
		warning: "#7a5a00",
		violet: "#8b5cf6",
		mediumGray: "#6c6c6c",
		dimGray: "#767676",
		lightGray: "#b0b0b0",
		blueMuted: "#6b8fb8",
		blueLow: "#547da7",
		blueMedium: "#3b82f6",
		blueHigh: "#2563eb",
		blueXhigh: "#1d4ed8",
		selectedBg: "#d0d0e0",
		userMsgBg: "#e8e8e8",
		toolPendingBg: "#e8eaf0",
		toolSuccessBg: "#e8f0f0",
		toolErrorBg: "#f0e8ee",
		customMsgBg: "#ede7f6",
	},
	colors: {
		accent: "teal",
		border: "blue",
		borderAccent: "teal",
		borderMuted: "lightGray",
		success: "green",
		error: "red",
		warning: "warning",
		violet: "violet",
		muted: "mediumGray",
		dim: "dimGray",
		text: "",
		thinkingText: "mediumGray",

		selectedBg: "selectedBg",
		userMessageBg: "userMsgBg",
		userMessageText: "",
		customMessageBg: "customMsgBg",
		customMessageText: "",
		customMessageLabel: "#7e57c2",
		toolPendingBg: "toolPendingBg",
		toolSuccessBg: "toolSuccessBg",
		toolErrorBg: "toolErrorBg",
		toolTitle: "",
		toolOutput: "mediumGray",

		mdHeading: "yellow",
		mdLink: "blue",
		mdLinkUrl: "dimGray",
		mdCode: "teal",
		mdCodeBlock: "green",
		mdCodeBlockBorder: "mediumGray",
		mdQuote: "mediumGray",
		mdQuoteBorder: "mediumGray",
		mdHr: "mediumGray",
		mdListBullet: "green",

		toolDiffAdded: "#15803d",
		toolDiffRemoved: "#b91c1c",
		toolDiffContext: "mediumGray",

		syntaxComment: "#008000",
		syntaxKeyword: "#0000FF",
		syntaxFunction: "#795E26",
		syntaxVariable: "#001080",
		syntaxString: "#A31515",
		syntaxNumber: "#098658",
		syntaxType: "#267F99",
		syntaxOperator: "#000000",
		syntaxPunctuation: "#000000",

		thinkingOff: "blueMuted",
		thinkingMinimal: "blueLow",
		thinkingLow: "blueMedium",
		thinkingMedium: "teal",
		thinkingHigh: "blueHigh",
		thinkingXhigh: "blueXhigh",

		bashMode: "accent",
	},
	export: {
		pageBg: "#f8f8f8",
		cardBg: "#ffffff",
		infoBg: "#fffae6",
	},
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const builtinThemes: Record<string, ThemeJson> = { dark, light };
