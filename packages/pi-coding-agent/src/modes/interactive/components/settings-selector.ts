import type { ThinkingLevel } from "@gsd/pi-agent-core";
import type { Transport } from "@gsd/pi-ai";
import {
	type Component,
	Container,
	getCapabilities,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@gsd/pi-tui";
import { getSelectListTheme, getSettingsListTheme, getThemeAccentInfo, getThemeAccentLabel, theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

export const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	adaptive: "Automatically adapt per turn (client or provider resolved)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Maximum reasoning (~32k tokens)",
};

export interface SettingsConfig {
	autoCompact: boolean;
	autoCompactThresholdPercent: number;
	defaultModel: string;
	classifierModel: string;
	adaptiveClassifierModel: string;
	budgetSubagentModel: string;
	planModeReasoningModel: string;
	planModeReviewModel: string;
	planModeCodingModel: string;
	autoSuggestPlanMode: boolean;
	autoSwitchPlanModel: boolean;
	showImages: boolean;
	autoResizeImages: boolean;
	blockImages: boolean;
	enableSkillCommands: boolean;
	toolProfile: "balanced" | "full";
	codexRotate: boolean;
	cacheTimer: boolean;
	pinLastPrompt: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	transport: Transport;
	thinkingLevel: ThinkingLevel;
	anthropicAdaptiveByDefault: boolean;
	clientAdaptiveByDefault: boolean;
	availableThinkingLevels: ThinkingLevel[];
	currentTheme: string;
	availableThemes: string[];
	currentThemeAccent: string;
	availableThemeAccents: string[];
	hideThinkingBlock: boolean;
	collapseChangelog: boolean;
	doubleEscapeAction: "fork" | "tree" | "none";
	treeFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
	showHardwareCursor: boolean;
	editorPaddingX: number;
	autocompleteMaxVisible: number;
	respectGitignoreInPicker: boolean;
	quietStartup: boolean;
	clearOnShrink: boolean;
	timestampFormat: "date-time-iso" | "date-time-us";
	toolOutputMode: "minimal" | "normal";
	rtk: boolean;
	editorScheme: "auto" | "vscode" | "cursor" | "zed" | "jetbrains" | "sublime" | "file";
	autoDream: boolean;
	autoMemory: boolean;
	telegramLiveRelayAutoConnect: boolean;
	sandboxEnabled?: boolean;
	sandboxNetworkMode?: "allow" | "ask" | "deny";
	defaultModelSubmenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
	classifierModelSubmenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
	adaptiveClassifierModelSubmenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
	budgetSubagentModelSubmenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
	planModeReasoningModelSubmenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
	planModeReviewModelSubmenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
	planModeCodingModelSubmenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
}

export interface SettingsCallbacks {
	onAutoCompactChange: (enabled: boolean) => void;
	onAutoCompactThresholdPercentChange: (percent: number) => void;
	onDefaultModelChange: (modelRef: string) => void;
	onClassifierModelChange: (modelRef: string) => void;
	onAdaptiveClassifierModelChange: (modelRef: string) => void;
	onBudgetSubagentModelChange: (modelRef: string) => void;
	onPlanModeReasoningModelChange: (modelRef: string) => void;
	onPlanModeReviewModelChange: (modelRef: string) => void;
	onPlanModeCodingModelChange: (modelRef: string) => void;
	onAutoSuggestPlanModeChange: (enabled: boolean) => void;
	onAutoSwitchPlanModelChange: (enabled: boolean) => void;
	onAutoDreamChange: (enabled: boolean) => void;
	onAutoMemoryChange: (enabled: boolean) => void;
	onTelegramLiveRelayAutoConnectChange: (enabled: boolean) => void;
	onSandboxEnabledChange?: (enabled: boolean) => void;
	onSandboxNetworkModeChange?: (mode: "allow" | "ask" | "deny") => void;
	onShowImagesChange: (enabled: boolean) => void;
	onAutoResizeImagesChange: (enabled: boolean) => void;
	onBlockImagesChange: (blocked: boolean) => void;
	onEnableSkillCommandsChange: (enabled: boolean) => void;
	onToolProfileChange: (profile: "balanced" | "full") => void;
	onCodexRotateChange: (enabled: boolean) => void;
	onCacheTimerChange: (enabled: boolean) => void;
	onPinLastPromptChange: (enabled: boolean) => void;
	onSteeringModeChange: (mode: "all" | "one-at-a-time") => void;
	onFollowUpModeChange: (mode: "all" | "one-at-a-time") => void;
	onTransportChange: (transport: Transport) => void;
	onThinkingLevelChange: (level: ThinkingLevel) => void;
	onAnthropicAdaptiveByDefaultChange: (enabled: boolean) => void;
	onClientAdaptiveByDefaultChange: (enabled: boolean) => void;
	onThemeChange: (theme: string) => void;
	onThemePreview?: (theme: string) => void;
	onThemeAccentChange: (accent: string) => void;
	onHideThinkingBlockChange: (hidden: boolean) => void;
	onCollapseChangelogChange: (collapsed: boolean) => void;
	onDoubleEscapeActionChange: (action: "fork" | "tree" | "none") => void;
	onTreeFilterModeChange: (mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all") => void;
	onShowHardwareCursorChange: (enabled: boolean) => void;
	onEditorPaddingXChange: (padding: number) => void;
	onAutocompleteMaxVisibleChange: (maxVisible: number) => void;
	onRespectGitignoreInPickerChange: (enabled: boolean) => void;
	onQuietStartupChange: (enabled: boolean) => void;
	onClearOnShrinkChange: (enabled: boolean) => void;
	onTimestampFormatChange: (format: "date-time-iso" | "date-time-us") => void;
	onToolOutputModeChange: (mode: "minimal" | "normal") => void;
	onRtkChange: (enabled: boolean) => void;
	onEditorSchemeChange: (scheme: "auto" | "vscode" | "cursor" | "zed" | "jetbrains" | "sublime" | "file") => void;
	onCancel: () => void;
}

/**
 * A submenu component for selecting from a list of options.
 */
export class SelectSubmenu extends Container {
	private selectList: SelectList;

	constructor(
		title: string,
		description: string,
		options: SelectItem[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		onSelectionChange?: (value: string) => void,
	) {
		super();

		// Title
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));

		// Description
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}

		// Spacer
		this.addChild(new Spacer(1));

		// Select list
		this.selectList = new SelectList(options, Math.min(options.length, 10), getSelectListTheme());

		// Pre-select current value
		const currentIndex = options.findIndex((o) => o.value === currentValue);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value);
		};

		this.selectList.onCancel = onCancel;

		if (onSelectionChange) {
			this.selectList.onSelectionChange = (item) => {
				onSelectionChange(item.value);
			};
		}

		this.addChild(this.selectList);

		// Hint
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}

/**
 * Main settings selector component.
 */
export class SettingsSelectorComponent extends Container {
	private settingsList: SettingsList;

	constructor(config: SettingsConfig, callbacks: SettingsCallbacks) {
		super();

		const supportsImages = getCapabilities().images;

		const items: SettingItem[] = [
			{
				id: "autocompact",
				label: "Auto-compact",
				description: "Automatically compact context when it gets too large",
				currentValue: config.autoCompact ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "autocompact-threshold",
				label: "Auto-compact threshold",
				description: "Trigger auto-compaction when context usage reaches this percentage",
				currentValue: String(config.autoCompactThresholdPercent),
				values: ["70", "75", "80", "85", "90", "95"],
			},
			{
				id: "default-model",
				label: "Default model",
				description: "Model LSD should use by default when opening a new session",
				currentValue: config.defaultModel,
				submenu: config.defaultModelSubmenu,
			},
			{
				id: "classifier-model",
				label: "Classifier model",
				description: "Model used for Auto permission mode approvals",
				currentValue: config.classifierModel,
				submenu: config.classifierModelSubmenu,
			},
			{
				id: "adaptive-classifier-model",
				label: "Adaptive classifier model",
				description: "LLM used to pick reasoning level when adaptive mode is on (default: heuristic)",
				currentValue: config.adaptiveClassifierModel,
				submenu: config.adaptiveClassifierModelSubmenu,
			},
			{
				id: "budget-subagent-model",
				label: "Budget subagent model",
				description: "Cheap model alias for subagents like scout",
				currentValue: config.budgetSubagentModel,
				submenu: config.budgetSubagentModelSubmenu,
			},
			{
				id: "plan-mode-reasoning-model",
				label: "Plan reasoning model",
				description: "Optional provider/id model to switch to after plan approval",
				currentValue: config.planModeReasoningModel,
				submenu: config.planModeReasoningModelSubmenu,
			},
			{
				id: "plan-mode-review-model",
				label: "Plan review model",
				description: "Optional provider/id model for the other-agent plan review step",
				currentValue: config.planModeReviewModel,
				submenu: config.planModeReviewModelSubmenu,
			},
			{
				id: "plan-mode-coding-model",
				label: "Plan coding model",
				description: "Optional provider/id model for subagent plan execution",
				currentValue: config.planModeCodingModel,
				submenu: config.planModeCodingModelSubmenu,
			},
			{
				id: "auto-suggest-plan-mode",
				label: "Auto-suggest plan mode",
				description: "Ask the LLM to suggest plan mode for large/complex tasks",
				currentValue: config.autoSuggestPlanMode ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "auto-switch-plan-model",
				label: "OpusPlan mode",
				description: "On plan entry: auto-switch to Plan reasoning model (must be set). On approval: offer new session with Plan coding model + worker agent",
				currentValue: config.autoSwitchPlanModel ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "steering-mode",
				label: "Steering mode",
				description:
					"Enter while streaming queues steering messages. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
				currentValue: config.steeringMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "follow-up-mode",
				label: "Follow-up mode",
				description:
					`${process.platform === "darwin" ? "⌥Enter" : "Alt+Enter"} queues follow-up messages until agent stops. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.`,
				currentValue: config.followUpMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "transport",
				label: "Transport",
				description: "Preferred transport for providers that support multiple transports",
				currentValue: config.transport,
				values: ["sse", "websocket", "auto"],
			},
			{
				id: "hide-thinking",
				label: "Hide thinking",
				description: "Hide thinking blocks in assistant responses",
				currentValue: config.hideThinkingBlock ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "tool-output-mode",
				label: "Tool output mode",
				description: "Minimal hides collapsed previews until Ctrl+O. Normal shows collapsed previews.",
				currentValue: config.toolOutputMode,
				values: ["minimal", "normal"],
			},
			{
				id: "sandbox-enabled",
				label: "Sandbox",
				description: "Enable OS-level sandboxing for bash execution on supported platforms",
				currentValue: (config.sandboxEnabled ?? true) ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "sandbox-network",
				label: "Sandbox network",
				description: "Allow, ask, or deny network access for sandboxed bash commands",
				currentValue: config.sandboxNetworkMode ?? "ask",
				values: ["ask", "allow", "deny"],
			},
			{
				id: "collapse-changelog",
				label: "Collapse changelog",
				description: "Show condensed changelog after updates",
				currentValue: config.collapseChangelog ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "quiet-startup",
				label: "Quiet startup",
				description: "Disable verbose printing at startup",
				currentValue: config.quietStartup ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "double-escape-action",
				label: "Double-escape action",
				description: "Action when pressing Escape twice with empty editor",
				currentValue: config.doubleEscapeAction,
				values: ["tree", "fork", "none"],
			},
			{
				id: "tree-filter-mode",
				label: "Tree filter mode",
				description: "Default filter when opening /tree",
				currentValue: config.treeFilterMode,
				values: ["default", "no-tools", "user-only", "labeled-only", "all"],
			},
			{
				id: "thinking",
				label: "Thinking level",
				description: "Reasoning depth for thinking-capable models",
				currentValue: config.thinkingLevel,
				submenu: (currentValue, done) =>
					new SelectSubmenu(
						"Thinking Level",
						"Select reasoning depth for thinking-capable models",
						config.availableThinkingLevels.map((level) => ({
							value: level,
							label: level,
							description: THINKING_DESCRIPTIONS[level],
						})),
						currentValue,
						(value) => {
							callbacks.onThinkingLevelChange(value as ThinkingLevel);
							done(value);
						},
						() => done(),
					),
			},
			{
				id: "anthropic-adaptive-default",
				label: "Anthropic adaptive",
				description: "Default to adaptive thinking for supported Anthropic models",
				currentValue: config.anthropicAdaptiveByDefault ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "client-adaptive-default",
				label: "Adaptive by default",
				description: "Default to adaptive thinking for all reasoning-capable models",
				currentValue: config.clientAdaptiveByDefault ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "theme",
				label: "Theme",
				description: "Color theme for the interface",
				currentValue: config.currentTheme,
				submenu: (currentValue, done) =>
					new SelectSubmenu(
						"Theme",
						"Select color theme",
						config.availableThemes.map((t) => ({
							value: t,
							label: t,
						})),
						currentValue,
						(value) => {
							callbacks.onThemeChange(value);
							done(value);
						},
						() => {
							// Restore original theme on cancel
							callbacks.onThemePreview?.(currentValue);
							done();
						},
						(value) => {
							// Preview theme on selection change
							callbacks.onThemePreview?.(value);
						},
					),
			},
			{
				id: "theme-accent",
				label: "Main accent",
				description: "Primary accent color used by the interface",
				currentValue: config.currentThemeAccent,
				submenu: (currentValue, done) =>
					new SelectSubmenu(
						"Main Accent",
						"Select the primary accent color",
						config.availableThemeAccents.map((accent) => ({
							value: accent,
							label: getThemeAccentLabel(accent as Parameters<typeof getThemeAccentInfo>[0]),
							description: getThemeAccentInfo(accent as Parameters<typeof getThemeAccentInfo>[0]).description,
						})),
						currentValue,
						(value) => {
							callbacks.onThemeAccentChange(value);
							done(value);
						},
						() => done(),
					),
			},
		];

		// Only show image toggle if terminal supports it
		if (supportsImages) {
			// Insert after autocompact threshold
			items.splice(2, 0, {
				id: "show-images",
				label: "Show images",
				description: "Render images inline in terminal",
				currentValue: config.showImages ? "true" : "false",
				values: ["true", "false"],
			});
		}

		// Image auto-resize toggle (always available, affects both attached and read images)
		items.splice(supportsImages ? 3 : 2, 0, {
			id: "auto-resize-images",
			label: "Auto-resize images",
			description: "Resize large images to 2000x2000 max for better model compatibility",
			currentValue: config.autoResizeImages ? "true" : "false",
			values: ["true", "false"],
		});

		// Block images toggle (always available, insert after auto-resize-images)
		const autoResizeIndex = items.findIndex((item) => item.id === "auto-resize-images");
		items.splice(autoResizeIndex + 1, 0, {
			id: "block-images",
			label: "Block images",
			description: "Prevent images from being sent to LLM providers",
			currentValue: config.blockImages ? "true" : "false",
			values: ["true", "false"],
		});

		// Skill commands toggle (insert after block-images)
		const blockImagesIndex = items.findIndex((item) => item.id === "block-images");
		items.splice(blockImagesIndex + 1, 0, {
			id: "skill-commands",
			label: "Skill commands",
			description: "Register skills as /skill:name commands",
			currentValue: config.enableSkillCommands ? "true" : "false",
			values: ["true", "false"],
		});

		// Tool profile selector (insert after skill-commands)
		const skillCommandsIndex = items.findIndex((item) => item.id === "skill-commands");
		items.splice(skillCommandsIndex + 1, 0, {
			id: "tool-profile",
			label: "Tool profile",
			description: "Choose the default active tool set: balanced for day-to-day coding, full to enable all available tools",
			currentValue: config.toolProfile,
			values: ["balanced", "full"],
		});

		// Codex rotate toggle (insert after tool-profile)
		const toolProfileIndex = items.findIndex((item) => item.id === "tool-profile");
		items.splice(toolProfileIndex + 1, 0, {
			id: "codex-rotate",
			label: "Codex rotate",
			description: "Enable automatic Codex account rotation extension",
			currentValue: config.codexRotate ? "true" : "false",
			values: ["true", "false"],
		});

		// Cache timer toggle (insert after codex-rotate)
		const codexRotateIndex = items.findIndex((item) => item.id === "codex-rotate");
		items.splice(codexRotateIndex + 1, 0, {
			id: "cache-timer",
			label: "Cache timer",
			description: "Show elapsed time since last response in the footer (tracks 5-min cache window)",
			currentValue: config.cacheTimer ? "true" : "false",
			values: ["true", "false"],
		});

		// Pin last prompt toggle (insert after cache-timer)
		const cacheTimerIdx = items.findIndex((item) => item.id === "cache-timer");
		items.splice(cacheTimerIdx + 1, 0, {
			id: "pin-last-prompt",
			label: "Pin last prompt",
			description: "Show your last sent message above the editor so you remember the topic",
			currentValue: config.pinLastPrompt ? "true" : "false",
			values: ["true", "false"],
		});

		// Auto-dream toggle (insert after pin-last-prompt)
		const pinLastPromptIdx = items.findIndex((item) => item.id === "pin-last-prompt");
		items.splice(pinLastPromptIdx + 1, 0, {
			id: "auto-dream",
			label: "Auto dream",
			description: "Automatically consolidate and refine memory after sessions",
			currentValue: config.autoDream ? "true" : "false",
			values: ["true", "false"],
		});

		// Auto-memory toggle (insert after auto-dream)
		const autoDreamIdx = items.findIndex((item) => item.id === "auto-dream");
		items.splice(autoDreamIdx + 1, 0, {
			id: "auto-memory",
			label: "Auto memory",
			description: "Automatically extract and save memories from session transcripts",
			currentValue: config.autoMemory ? "true" : "false",
			values: ["true", "false"],
		});

		// Telegram relay auto-connect toggle (insert after auto-memory)
		const autoMemoryIdx = items.findIndex((item) => item.id === "auto-memory");
		items.splice(autoMemoryIdx + 1, 0, {
			id: "telegram-live-relay-autoconnect",
			label: "Telegram autoconnect",
			description: "Auto-run /lsd telegram connect on startup",
			currentValue: config.telegramLiveRelayAutoConnect ? "true" : "false",
			values: ["true", "false"],
		});

		// RTK toggle (insert after cache-timer)
		const cacheTimerIndex = items.findIndex((item) => item.id === "cache-timer");
		items.splice(cacheTimerIndex + 1, 0, {
			id: "rtk",
			label: "RTK",
			description: "Enable RTK shell-command compression (requires restart)",
			currentValue: config.rtk ? "true" : "false",
			values: ["true", "false"],
		});

		// Hardware cursor toggle (insert after rtk)
		const rtkIndex = items.findIndex((item) => item.id === "rtk");
		items.splice(rtkIndex + 1, 0, {
			id: "show-hardware-cursor",
			label: "Show hardware cursor",
			description: "Show the terminal cursor while still positioning it for IME support",
			currentValue: config.showHardwareCursor ? "true" : "false",
			values: ["true", "false"],
		});

		// Editor padding toggle (insert after show-hardware-cursor)
		const hardwareCursorIndex = items.findIndex((item) => item.id === "show-hardware-cursor");
		items.splice(hardwareCursorIndex + 1, 0, {
			id: "editor-padding",
			label: "Editor padding",
			description: "Horizontal padding for input editor (0-3)",
			currentValue: String(config.editorPaddingX),
			values: ["0", "1", "2", "3"],
		});

		// Autocomplete max visible toggle (insert after editor-padding)
		const editorPaddingIndex = items.findIndex((item) => item.id === "editor-padding");
		items.splice(editorPaddingIndex + 1, 0, {
			id: "autocomplete-max-visible",
			label: "Autocomplete max items",
			description: "Max visible items in autocomplete dropdown (3-20)",
			currentValue: String(config.autocompleteMaxVisible),
			values: ["3", "5", "7", "10", "15", "20"],
		});

		// Clear on shrink toggle (insert after autocomplete-max-visible)
		const autocompleteIndex = items.findIndex((item) => item.id === "autocomplete-max-visible");
		items.splice(autocompleteIndex + 1, 0, {
			id: "clear-on-shrink",
			label: "Clear on shrink",
			description: "Clear empty rows when content shrinks (may cause flicker)",
			currentValue: config.clearOnShrink ? "true" : "false",
			values: ["true", "false"],
		});

		// Respect .gitignore in file picker toggle (insert after clear-on-shrink)
		const clearOnShrinkIndex = items.findIndex((item) => item.id === "clear-on-shrink");
		items.splice(clearOnShrinkIndex + 1, 0, {
			id: "respect-gitignore-in-picker",
			label: "Respect .gitignore in file picker",
			description: "When false, @ file picker shows gitignored files too",
			currentValue: config.respectGitignoreInPicker ? "true" : "false",
			values: ["true", "false"],
		});

		// Timestamp format (insert after respect-gitignore-in-picker)
		const gitignoreIndex = items.findIndex((item) => item.id === "respect-gitignore-in-picker");
		items.splice(gitignoreIndex + 1, 0, {
			id: "timestamp-format",
			label: "Timestamp format",
			description: "Time format for message timestamps",
			currentValue: config.timestampFormat,
			values: ["date-time-iso", "date-time-us"],
		});

		// Editor link scheme (insert after timestamp-format)
		const timestampIndex = items.findIndex((item) => item.id === "timestamp-format");
		items.splice(timestampIndex + 1, 0, {
			id: "editor-scheme",
			label: "Editor link scheme",
			description: "URI scheme for Cmd+click file path links (auto detects from $VISUAL/$EDITOR)",
			currentValue: config.editorScheme,
			values: ["auto", "vscode", "cursor", "zed", "jetbrains", "sublime", "file"],
		});

		// Add borders
		this.addChild(new DynamicBorder());

		this.settingsList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "autocompact":
						callbacks.onAutoCompactChange(newValue === "true");
						break;
					case "autocompact-threshold":
						callbacks.onAutoCompactThresholdPercentChange(parseInt(newValue, 10));
						break;
					case "default-model":
						callbacks.onDefaultModelChange(newValue);
						break;
					case "classifier-model":
						callbacks.onClassifierModelChange(newValue);
						break;
					case "adaptive-classifier-model":
						callbacks.onAdaptiveClassifierModelChange(newValue);
						break;
					case "budget-subagent-model":
						callbacks.onBudgetSubagentModelChange(newValue);
						break;
					case "plan-mode-reasoning-model":
						callbacks.onPlanModeReasoningModelChange(newValue);
						break;
					case "plan-mode-review-model":
						callbacks.onPlanModeReviewModelChange(newValue);
						break;
					case "plan-mode-coding-model":
						callbacks.onPlanModeCodingModelChange(newValue);
						break;
					case "auto-suggest-plan-mode":
						callbacks.onAutoSuggestPlanModeChange(newValue === "true");
						break;
					case "auto-switch-plan-model":
						callbacks.onAutoSwitchPlanModelChange(newValue === "true");
						break;
					case "show-images":
						callbacks.onShowImagesChange(newValue === "true");
						break;
					case "auto-resize-images":
						callbacks.onAutoResizeImagesChange(newValue === "true");
						break;
					case "block-images":
						callbacks.onBlockImagesChange(newValue === "true");
						break;
					case "skill-commands":
						callbacks.onEnableSkillCommandsChange(newValue === "true");
						break;
					case "tool-profile":
						callbacks.onToolProfileChange(newValue as "balanced" | "full");
						break;
					case "codex-rotate":
						callbacks.onCodexRotateChange(newValue === "true");
						break;
					case "cache-timer":
						callbacks.onCacheTimerChange(newValue === "true");
						break;
					case "pin-last-prompt":
						callbacks.onPinLastPromptChange(newValue === "true");
						break;
					case "auto-dream":
						callbacks.onAutoDreamChange(newValue === "true");
						break;
					case "auto-memory":
						callbacks.onAutoMemoryChange(newValue === "true");
						break;
					case "telegram-live-relay-autoconnect":
						callbacks.onTelegramLiveRelayAutoConnectChange(newValue === "true");
						break;
					case "rtk":
						callbacks.onRtkChange(newValue === "true");
						break;
					case "steering-mode":
						callbacks.onSteeringModeChange(newValue as "all" | "one-at-a-time");
						break;
					case "follow-up-mode":
						callbacks.onFollowUpModeChange(newValue as "all" | "one-at-a-time");
						break;
					case "transport":
						callbacks.onTransportChange(newValue as Transport);
						break;
					case "anthropic-adaptive-default":
						callbacks.onAnthropicAdaptiveByDefaultChange(newValue === "true");
						break;
					case "client-adaptive-default":
						callbacks.onClientAdaptiveByDefaultChange(newValue === "true");
						break;
					case "hide-thinking":
						callbacks.onHideThinkingBlockChange(newValue === "true");
						break;
					case "tool-output-mode":
						callbacks.onToolOutputModeChange(newValue as "minimal" | "normal");
						break;
					case "sandbox-enabled":
						callbacks.onSandboxEnabledChange?.(newValue === "true");
						break;
					case "sandbox-network":
						callbacks.onSandboxNetworkModeChange?.(newValue as "allow" | "ask" | "deny");
						break;
					case "collapse-changelog":
						callbacks.onCollapseChangelogChange(newValue === "true");
						break;
					case "quiet-startup":
						callbacks.onQuietStartupChange(newValue === "true");
						break;
					case "double-escape-action":
						callbacks.onDoubleEscapeActionChange(newValue as "fork" | "tree");
						break;
					case "tree-filter-mode":
						callbacks.onTreeFilterModeChange(
							newValue as "default" | "no-tools" | "user-only" | "labeled-only" | "all",
						);
						break;
					case "show-hardware-cursor":
						callbacks.onShowHardwareCursorChange(newValue === "true");
						break;
					case "editor-padding":
						callbacks.onEditorPaddingXChange(parseInt(newValue, 10));
						break;
					case "autocomplete-max-visible":
						callbacks.onAutocompleteMaxVisibleChange(parseInt(newValue, 10));
						break;
					case "clear-on-shrink":
						callbacks.onClearOnShrinkChange(newValue === "true");
						break;
					case "respect-gitignore-in-picker":
						callbacks.onRespectGitignoreInPickerChange(newValue === "true");
						break;
					case "timestamp-format":
						callbacks.onTimestampFormatChange(newValue as "date-time-iso" | "date-time-us");
						break;
					case "editor-scheme":
						callbacks.onEditorSchemeChange(
							newValue as "auto" | "vscode" | "cursor" | "zed" | "jetbrains" | "sublime" | "file",
						);
						break;
				}
			},
			callbacks.onCancel,
			{ enableSearch: true },
		);

		this.addChild(this.settingsList);
		this.addChild(new DynamicBorder());
	}

	getSettingsList(): SettingsList {
		return this.settingsList;
	}
}
