/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@gsd/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, Model, OAuthProviderId } from "@gsd/pi-ai";
import type {
	AutocompleteItem,
	EditorComponent,
	EditorTheme,
	KeyId,
	MarkdownTheme,
	OverlayHandle,
	OverlayOptions,
	SlashCommand,
} from "@gsd/pi-tui";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	fuzzyFilter,
	Loader,
	Markdown,
	matchesKey,
	ProcessTerminal,
	Spacer,
	type Terminal as TuiTerminal,
	Text,
	TruncatedText,
	TUI,
	visibleWidth,
} from "@gsd/pi-tui";
import { spawn, spawnSync } from "child_process";
import {
	APP_NAME,
	getAuthPath,
	getDebugLogPath,
	getUpdateInstruction,
	VERSION,
} from "../../config.js";
import { type AgentSession, type AgentSessionEvent, parseSkillBlock } from "../../core/agent-session.js";
import type { CompactionResult } from "../../core/compaction/index.js";
import type {
	ExtensionContext,
	ExtensionRunner,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
} from "../../core/extensions/index.js";
import { FooterDataProvider, type ReadonlyFooterDataProvider } from "../../core/footer-data-provider.js";
import { type AppAction, KeybindingsManager } from "../../core/keybindings.js";
import { ClassifierService } from "../../core/classifier-service.js";
import { createCompactionSummaryMessage } from "../../core/messages.js";
import { resolveModelScope } from "../../core/model-resolver.js";
import type { ResourceDiagnostic } from "../../core/resource-loader.js";
import { type SessionContext, SessionManager } from "../../core/session-manager.js";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.js";
import {
	getPermissionMode,
	setPermissionMode,
	setFileChangeApprovalHandler,
	setClassifierHandler,
	setNetworkApprovalHandler,
	type PermissionMode,
} from "../../core/tool-approval.js";
import type { TruncationResult } from "../../core/tools/truncate.js";
import { writeToPtySession } from "../../core/tools/index.js";
import { isPtyAvailable } from "../../core/pty-executor.js";
import { getChangelogPath, getNewEntries, parseChangelog } from "../../utils/changelog.js";
import { extensionForImageMimeType, readClipboardImage } from "../../utils/clipboard-image.js";
import { resetStdinForTui } from "../../utils/reset-stdin.js";
import { ensureTool } from "../../utils/tools-manager.js";
import { AssistantMessageComponent } from "./components/assistant-message.js";
import { BashExecutionComponent } from "./components/bash-execution.js";
import { EmbeddedTerminalComponent } from "./components/embedded-terminal.js";
import { BorderedLoader } from "./components/bordered-loader.js";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.js";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.js";
import { CustomEditor } from "./components/custom-editor.js";
import { CustomMessageComponent } from "./components/custom-message.js";
import { DaxnutsComponent } from "./components/daxnuts.js";
import { DynamicBorder } from "./components/dynamic-border.js";
import { ExtensionEditorComponent } from "./components/extension-editor.js";
import { ExtensionInputComponent } from "./components/extension-input.js";
import { ExtensionSelectorComponent } from "./components/extension-selector.js";
import { FooterComponent } from "./components/footer.js";
import { appKey, appKeyHint, editorKey, formatKeyForDisplay, keyHint, rawKeyHint } from "./components/keybinding-hints.js";
import { LoginDialogComponent } from "./components/login-dialog.js";
import { ModelSelectorComponent } from "./components/model-selector.js";
import { OAuthSelectorComponent } from "./components/oauth-selector.js";
import { ProviderManagerComponent } from "./components/provider-manager.js";
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.js";
import { SessionSelectorComponent } from "./components/session-selector.js";
import { SettingsSelectorComponent } from "./components/settings-selector.js";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.js";
import { ToolExecutionComponent } from "./components/tool-execution.js";
import { TreeSelectorComponent } from "./components/tree-selector.js";
import { UserMessageComponent } from "./components/user-message.js";
import { UserMessageSelectorComponent } from "./components/user-message-selector.js";
import { type SlashCommandContext, dispatchSlashCommand, getAppKeyDisplay, showHotkeys } from "./slash-command-handlers.js";
import { handleAgentEvent } from "./controllers/chat-controller.js";
import { createExtensionUIContext as buildExtensionUIContext } from "./controllers/extension-ui-controller.js";
import { setupEditorSubmitHandler as setupEditorSubmitHandlerController } from "./controllers/input-controller.js";
import {
	findExactModelMatch as findExactModelMatchController,
	getModelCandidates as getModelCandidatesController,
	handleModelCommand as handleModelCommandController,
	updateAvailableProviderCount as updateAvailableProviderCountController,
} from "./controllers/model-controller.js";
import {
	getAvailableThemeAccents,
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getEditorTheme,
	getMarkdownTheme,
	getThemeByName,
	initTheme,
	onThemeChange,
	setRegisteredThemes,
	setTheme,
	setThemeInstance,
	Theme,
	type ThemeColor,
	theme,
} from "./theme/theme.js";
/** Returns true when RTK shell-command compression is active in this process.
 *  GSD_RTK_DISABLED=1/true/yes means disabled; absent or any other value means enabled. */
function isRtkEnabled(): boolean {
	const v = (process.env["GSD_RTK_DISABLED"] ?? "").trim().toLowerCase();
	return v !== "1" && v !== "true" && v !== "yes";
}

/** Interface for components that can be expanded/collapsed */
interface Expandable {
	setExpanded(expanded: boolean): void;
}

type InteractiveBashComponent = BashExecutionComponent | EmbeddedTerminalComponent;

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

type CompactionQueuedMessage = {
	text: string;
	mode: "steer" | "followUp";
};

/**
 * Options for InteractiveMode initialization.
 */
export interface InteractiveModeOptions {
	/** Providers that were migrated to auth.json (shows warning) */
	migratedProviders?: string[];
	/** Warning message if session model couldn't be restored */
	modelFallbackMessage?: string;
	/** Initial message to send on startup (can include @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** Additional messages to send after the initial message */
	initialMessages?: string[];
	/** Force verbose startup (overrides quietStartup setting) */
	verbose?: boolean;
	/** Override the terminal implementation used by the TUI. */
	terminal?: TuiTerminal;
	/** When false, reuse the session's existing extension bindings instead of rebinding them for TUI mode. */
	bindExtensions?: boolean;
	/** Submit editor prompts directly to AgentSession instead of using the interactive prompt loop. */
	submitPromptsDirectly?: boolean;
	/** Control what happens when the user requests shutdown from the TUI. */
	shutdownBehavior?: "exit_process" | "stop_ui" | "ignore";
	/** Optional host-provided setup wizard entrypoint (e.g. app onboarding). */
	runSetupWizard?: () => Promise<void>;
}

function getToolNamesForProfile(
	profile: "balanced" | "full",
	editMode: "standard" | "hashline",
	availableToolNames: string[],
): string[] {
	const balancedToolNames = editMode === "hashline"
		? ["hashline_read", "bash", "hashline_edit", "write", "lsp", "bg_shell", "tool_search", "tool_enable", "Skill", "subagent", "await_subagent", "ask_user_questions"]
		: ["read", "bash", "edit", "write", "lsp", "bg_shell", "tool_search", "tool_enable", "Skill", "subagent", "await_subagent", "ask_user_questions"];
	return profile === "full" ? availableToolNames : balancedToolNames;
}

export class InteractiveMode {
	private session: AgentSession;
	private ui: TUI;
	private chatContainer: Container;
	private pendingMessagesContainer: Container;
	private statusContainer: Container;
	private defaultEditor: CustomEditor;
	private editor: EditorComponent;
	private autocompleteProvider: CombinedAutocompleteProvider | undefined;
	private editorContainer: Container;
	private footer: FooterComponent;
	private footerDataProvider: FooterDataProvider;
	private keybindings: KeybindingsManager;
	private version: string;
	private isInitialized = false;
	private onInputCallback?: (text: string) => void;
	private loadingAnimation: Loader | undefined = undefined;
	private loadingTipText: Text | undefined = undefined;
	private loadingTipsInterval: ReturnType<typeof setInterval> | undefined = undefined;
	private loadingTipIndex = 0;
	private pendingWorkingMessage: string | undefined = undefined;
	private readonly defaultWorkingMessage = "Cooking…";
	private readonly workingMessages = [
		"Cooking…",
		"Vibing…",
		"Brainworming…",
		"Scheming…",
		"Spelunking…",
		"Manifesting…",
		"Yak shaving…",
		"Grokking…",
		"Pondering…",
		"Going deep…",
		"Caffeinating…",
		"On a mission…",
		"Consulting the void…",
		"Doing the thing…",
		"Almost maybe…",
	];
	private readonly loadingTips = [
		"Tip: Run /help to see built-in commands plus loaded skill commands.",
		"Tip: Use /hotkeys to learn the TUI faster.",
		"Tip: Run /model to switch models without leaving the session.",
		"Tip: Use /scoped-models to choose which models Ctrl+P cycles through.",
		"Tip: Run /thinking to change reasoning depth on the fly.",
		"Tip: Use /settings to change LSD behavior from the TUI.",
		"Tip: Run /provider to manage provider configuration.",
		"Tip: Use /login and /logout for OAuth-backed providers.",
		"Tip: Run /permission to cycle approval modes like auto and plan.",
		"Tip: Use /sandbox to inspect or toggle sandbox settings.",
		"Tip: Run /terminal <cmd> to execute a shell command directly from chat.",
		"Tip: Use /reload after editing extensions, skills, prompts, or themes.",
		"Tip: Run /compact when a long session needs a fresh context window.",
		"Tip: Use /session to view session stats and metadata.",
		"Tip: Run /name to set a readable session title.",
		"Tip: Use /new to start a clean session without leaving LSD.",
		"Tip: Run /resume to pick an older session from the TUI.",
		"Tip: Use /fork on an earlier message to branch the conversation there.",
		"Tip: Run /tree to navigate conversation branches.",
		"Tip: Use /copy to copy the last assistant response.",
		"Tip: Run /export to save a session as HTML.",
		"Tip: Use /share to publish a session as a secret gist-backed link.",
		"Tip: Run /changelog to see what changed in LSD recently.",
		"Tip: Use /edit-mode to switch between standard and hashline editor modes.",
		"Tip: Start LSD with --print for one-shot non-interactive prompts.",
		"Tip: Start LSD with --continue to keep working from the previous session.",
		"Tip: Start LSD with --resume to open the session picker immediately.",
		"Tip: Pass @files on the command line to include them in the first prompt.",
		"Tip: Use --model provider/name to select a model from the CLI.",
		"Tip: Use --model sonnet:high to set model and thinking level together.",
		"Tip: Use --models a,b,c to limit which models Ctrl+P cycles through.",
		"Tip: Use --tools read,bash,edit,write to choose the built-in tool set.",
		"Tip: Use --no-tools for a chat-only session with no built-in tools.",
		"Tip: Use --no-session for an ephemeral run that is not saved.",
		"Tip: Use --extension path/to/ext to load an extension ad hoc.",
		"Tip: Use --skill path/to/skill to load a skill ad hoc.",
		"Tip: Use --no-extensions or --no-skills to debug resource loading issues.",
		"Tip: LSD can discover extensions, skills, prompt templates, and themes automatically.",
		"Tip: Loaded skills can appear as slash commands like /skill:name.",
		"Tip: Extensions can register their own CLI flags in LSD.",
		"Tip: Use Tab in the editor to autocomplete paths and slash commands.",
		"Tip: Paste an image from the clipboard to attach it to your message.",
		"Tip: Drag files into the terminal to attach them to the current prompt.",
		"Tip: Use !! to run bash without adding the command output to context.",
		"Tip: Mention exact file paths to help LSD target the right code quickly.",
		"Tip: Say 'plan first' if you want design before edits.",
		"Tip: Say 'remember this' to store a lasting workflow preference.",
		"Tip: Say 'forget that' to remove a saved memory.",
		"Tip: LSD supports custom themes; use /reload after changing theme files.",
		"Tip: If startup feels quiet, launch with --verbose to force startup guidance.",
		"Tip: Use --offline to skip startup network operations.",
		"Tip: Run with --list-models to inspect available models from your config.",
		"Tip: Use --discover with --list-models to include discovered provider models.",
		"Tip: Use --discover-models to query provider APIs for live model lists.",
		"Tip: Use install/remove/update/list subcommands to manage installed extensions.",
		"Tip: Run 'lsd config' to open the package-resource configuration TUI.",
	];

	private lastSigintTime = 0;
	private lastEscapeTime = 0;
	private changelogMarkdown: string | undefined = undefined;

	// Status line tracking (for mutating immediately-sequential status updates)
	private lastStatusSpacer: Spacer | undefined = undefined;
	private lastStatusText: Text | undefined = undefined;

	// Streaming message tracking
	private streamingComponent: AssistantMessageComponent | undefined = undefined;
	private streamingMessage: AssistantMessage | undefined = undefined;

	// Tool execution tracking: toolCallId -> component
	private pendingTools = new Map<string, ToolExecutionComponent>();
	private agentPtyComponents = new Map<string, EmbeddedTerminalComponent>();

	// Tool output expansion state
	private toolOutputExpanded = false;

	// Thinking block visibility state
	private hideThinkingBlock = false;

	// Pin last prompt feature
	private pinLastPromptEnabled = false;
	private lastSentPromptText: string | undefined = undefined;

	// Skill commands: command name -> skill file path
	private skillCommands = new Map<string, string>();

	// Agent subscription unsubscribe function
	private unsubscribe?: () => void;

	// Track if editor is in bash mode (text starts with !)
	private isBashMode = false;

	// Track current bash execution component
	private bashComponent: InteractiveBashComponent | undefined = undefined;

	// Track pending bash components (shown in pending area, moved to chat on submit)
	private pendingBashComponents: InteractiveBashComponent[] = [];
	private focusedEmbeddedTerminal?: EmbeddedTerminalComponent;
	private lastEmbeddedTerminalSize?: { cols: number; rows: number };

	// Auto-compaction state
	private autoCompactionLoader: Loader | undefined = undefined;
	private autoCompactionEscapeHandler?: () => void;

	// Auto-retry state
	private retryLoader: Loader | undefined = undefined;
	private retryEscapeHandler?: () => void;

	// Messages queued while compaction is running
	private compactionQueuedMessages: CompactionQueuedMessage[] = [];

	// Shutdown state
	private shutdownRequested = false;

	// Extension UI state
	private extensionSelector: ExtensionSelectorComponent | undefined = undefined;
	private extensionInput: ExtensionInputComponent | undefined = undefined;
	private extensionEditor: ExtensionEditorComponent | undefined = undefined;
	private extensionTerminalInputUnsubscribers = new Set<() => void>();

	// Extension widgets (components rendered above/below the editor)
	private extensionWidgetsAbove = new Map<string, Component & { dispose?(): void }>();
	private extensionWidgetsBelow = new Map<string, Component & { dispose?(): void }>();
	private widgetContainerAbove!: Container;
	private widgetContainerBelow!: Container;

	// Custom footer from extension (undefined = use built-in footer)
	private customFooter: (Component & { dispose?(): void }) | undefined = undefined;

	// Header container that holds the built-in or custom header
	private headerContainer: Container;

	// Built-in header (logo + keybinding hints + changelog)
	private builtInHeader: Component | undefined = undefined;

	// Custom header from extension (undefined = use built-in header)
	private customHeader: (Component & { dispose?(): void }) | undefined = undefined;

	// Convenience accessors
	private get agent() {
		return this.session.agent;
	}
	private get sessionManager() {
		return this.session.sessionManager;
	}
	private get settingsManager() {
		return this.session.settingsManager;
	}

	constructor(
		session: AgentSession,
		private options: InteractiveModeOptions = {},
	) {
		this.session = session;
		this.version = VERSION;
		this.ui = new TUI(options.terminal ?? new ProcessTerminal(), this.settingsManager.getShowHardwareCursor());
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		this.headerContainer = new Container();
		this.chatContainer = new Container();
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.widgetContainerAbove = new Container();
		this.widgetContainerBelow = new Container();
		this.keybindings = KeybindingsManager.create();
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: editorPaddingX,
			autocompleteMaxVisible,
		});
		this.defaultEditor.topHintProvider = () => this.getPlanModeEditorBadge();
		this.editor = this.defaultEditor;
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor as Component);
		this.footerDataProvider = new FooterDataProvider();
		this.footer = new FooterComponent(session, this.footerDataProvider);
		this.footer.setAutoCompactEnabled(session.autoCompactionEnabled);
		this.footer.setPermissionMode(getPermissionMode());
		this.footerDataProvider.setSandboxStatus("disabled");

		// Load hide thinking block setting
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();

		// Load pin last prompt setting
		this.pinLastPromptEnabled = this.settingsManager.getPinLastPrompt();

		// Register themes from resource loader and initialize
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		initTheme(this.settingsManager.getTheme(), true, this.settingsManager.getThemeAccent());
	}

	private setupAutocomplete(): void {
		// Define commands for autocomplete
		const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.map((command) => ({
			name: command.name,
			description: command.description,
		}));

		const modelCommand = slashCommands.find((command) => command.name === "model");
		if (modelCommand) {
			modelCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				// Get available models (scoped or from registry)
				const models =
					this.session.scopedModels.length > 0
						? this.session.scopedModels.map((s) => s.model)
						: this.session.modelRegistry.getAvailable();

				if (models.length === 0) return null;

				// Create items with provider/id format
				const items = models.map((m) => ({
					id: m.id,
					provider: m.provider,
					label: `${m.provider}/${m.id}`,
				}));

				// Fuzzy filter by model ID + provider (allows "opus anthropic" to match)
				const filtered = fuzzyFilter(items, prefix, (item) => `${item.id} ${item.provider}`);

				if (filtered.length === 0) return null;

				return filtered.map((item) => ({
					value: item.label,
					label: item.id,
					description: item.provider,
				}));
			};
		}

		// Add argument completions for /thinking
		const thinkingCommand = slashCommands.find((command) => command.name === "thinking");
		if (thinkingCommand) {
			thinkingCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				const levels = [
					{ value: "off", label: "off", description: "Disable extended thinking" },
					{ value: "low", label: "low", description: "Low thinking budget" },
					{ value: "medium", label: "medium", description: "Medium thinking budget" },
					{ value: "high", label: "high", description: "High thinking budget" },
					{ value: "xhigh", label: "xhigh", description: "Maximum thinking budget" },
				];
				const filtered = levels.filter((l) => l.value.startsWith(prefix.trim().toLowerCase()));
				return filtered.length > 0 ? filtered : null;
			};
		}

		// Convert prompt templates to SlashCommand format for autocomplete
		const templateCommands: SlashCommand[] = this.session.promptTemplates.map((cmd) => ({
			name: cmd.name,
			description: cmd.description,
		}));

		// Convert extension commands to SlashCommand format
		const builtinCommandNames = new Set(slashCommands.map((c) => c.name));
		const extensionCommands: SlashCommand[] = (
			this.session.extensionRunner?.getRegisteredCommands(builtinCommandNames) ?? []
		).map((cmd) => ({
			name: cmd.name,
			description: cmd.description ?? "(extension command)",
			getArgumentCompletions: cmd.getArgumentCompletions,
		}));

		// Build skill commands from session.skills (if enabled)
		this.skillCommands.clear();
		const skillCommandList: SlashCommand[] = [];
		if (this.settingsManager.getEnableSkillCommands()) {
			for (const skill of this.session.resourceLoader.getSkills().skills) {
				const commandName = `skill:${skill.name}`;
				this.skillCommands.set(commandName, skill.filePath);
				skillCommandList.push({ name: commandName, description: skill.description });
			}
		}

		// Setup autocomplete
		this.autocompleteProvider = new CombinedAutocompleteProvider(
			[...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList],
			process.cwd(),
			{
				respectGitignore: this.settingsManager.getRespectGitignoreInPicker(),
				excludeDirs: this.settingsManager.getSearchExcludeDirs(),
			},
		);
		this.defaultEditor.setAutocompleteProvider(this.autocompleteProvider);
		if (this.editor !== this.defaultEditor) {
			this.editor.setAutocompleteProvider?.(this.autocompleteProvider);
		}
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		// Load changelog (only show new entries, skip for resumed sessions)
		this.changelogMarkdown = this.getChangelogForDisplay();

		// Ensure rg is available (downloads if missing, adds to PATH via getBinDir)
		// rg is needed for grep tool and bash commands
		await ensureTool("rg");

		// Add header container as first child
		this.ui.addChild(this.headerContainer);

		// Add header with keybindings from config (unless silenced)
		if (this.options.verbose || !this.settingsManager.getQuietStartup()) {
			const logo = theme.bold(theme.fg("accent", APP_NAME)) + theme.fg("dim", ` v${this.version}`);

			// Build startup instructions using keybinding hint helpers
			const kb = this.keybindings;
			const hint = (action: AppAction, desc: string) => appKeyHint(kb, action, desc);

			const instructions = [
				hint("interrupt", "to interrupt"),
				hint("clear", "to clear"),
				rawKeyHint(`${appKey(kb, "clear")} twice`, "to exit"),
				hint("exit", "to exit (empty)"),
				hint("suspend", "to suspend"),
				keyHint("deleteToLineEnd", "to delete to end"),
				hint("cycleThinkingLevel", "to cycle thinking level"),
				rawKeyHint(`${appKey(kb, "cycleModelForward")}/${appKey(kb, "cycleModelBackward")}`, "to cycle models"),
				hint("selectModel", "to select model"),
				hint("expandTools", "to expand tools"),
				hint("toggleThinking", "to expand thinking"),
				hint("externalEditor", "for external editor"),
				rawKeyHint("/", "for commands"),
				rawKeyHint("!", "to run bash"),
				rawKeyHint("!!", "to run bash (no context)"),
				hint("followUp", "to queue follow-up"),
				hint("dequeue", "to edit all queued messages"),
				hint("pasteImage", "to paste image"),
				rawKeyHint("drop files", "to attach"),
			].join("\n");
			this.builtInHeader = new Text(`${logo}\n${instructions}`, 1, 0);

			// Setup UI layout
			this.headerContainer.addChild(new Spacer(1));
			this.headerContainer.addChild(this.builtInHeader);
			this.headerContainer.addChild(new Spacer(1));

			// Add changelog if provided
			if (this.changelogMarkdown) {
				this.headerContainer.addChild(new DynamicBorder((text) => theme.fg("borderAccent", text)));
				if (this.settingsManager.getCollapseChangelog()) {
					const versionMatch = this.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
					const latestVersion = versionMatch ? versionMatch[1] : this.version;
					const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
					this.headerContainer.addChild(new Text(condensedText, 1, 0));
				} else {
					this.headerContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
					this.headerContainer.addChild(new Spacer(1));
					this.headerContainer.addChild(
						new Markdown(this.changelogMarkdown.trim(), 1, 0, this.getMarkdownThemeWithSettings()),
					);
					this.headerContainer.addChild(new Spacer(1));
				}
				this.headerContainer.addChild(new DynamicBorder((text) => theme.fg("borderAccent", text)));
			}
		} else {
			// Minimal header when silenced
			this.builtInHeader = new Text("", 0, 0);
			this.headerContainer.addChild(this.builtInHeader);
			if (this.changelogMarkdown) {
				// Still show changelog notification even in silent mode
				this.headerContainer.addChild(new Spacer(1));
				const versionMatch = this.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
				const latestVersion = versionMatch ? versionMatch[1] : this.version;
				const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
				this.headerContainer.addChild(new Text(condensedText, 1, 0));
			}
		}

		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.statusContainer);
		this.renderWidgets(); // Initialize with default spacer
		this.ui.addChild(this.widgetContainerAbove);
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.widgetContainerBelow);
		this.ui.addChild(this.footer);
		this.ui.setFocus(this.editor);

		this.setupKeyHandlers();
		this.setupEditorSubmitHandler();

		// Initialize extensions first so resources are shown before messages
		await this.initExtensions();

		// Render initial messages AFTER showing loaded resources
		this.renderInitialMessages();

		// Start the UI
		this.ui.start();
		this.isInitialized = true;

		this._registerApprovalHandlers();

		// Set terminal title
		this.updateTerminalTitle();

		// Subscribe to agent events
		this.subscribeToAgent();

		// Set up theme file watcher
		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		// Set up git branch watcher (uses provider instead of footer)
		this.footerDataProvider.onBranchChange(() => {
			this.ui.requestRender();
		});

		// Initialize available provider count for footer display
		await this.updateAvailableProviderCount();
		await this.refreshSandboxFooterStatus();
	}

	/**
	 * Update terminal title with session name and cwd.
	 */
	private updateTerminalTitle(): void {
		const cwdBasename = path.basename(process.cwd());
		const sessionName = this.sessionManager.getSessionName();
		if (sessionName) {
			this.ui.terminal.setTitle(`π - ${sessionName} - ${cwdBasename}`);
		} else {
			this.ui.terminal.setTitle(`π - ${cwdBasename}`);
		}
	}

	/**
	 * Run the interactive mode. This is the main entry point.
	 * Initializes the UI, shows warnings, processes initial messages, and starts the interactive loop.
	 */
	async run(): Promise<void> {
		await this.init();

		// Start version check asynchronously
		this.checkForNewVersion().then((newVersion) => {
			if (newVersion) {
				this.showNewVersionNotification(newVersion);
			}
		});

		// Check tmux keyboard setup asynchronously
		this.checkTmuxKeyboardSetup().then((warning) => {
			if (warning) {
				this.showWarning(warning);
			}
		});

		// Show startup warnings
		const { migratedProviders, modelFallbackMessage, initialMessage, initialImages, initialMessages } = this.options;
		await this.maybeShowSandboxStartupWarning();

		if (migratedProviders && migratedProviders.length > 0) {
			this.showWarning(`Migrated credentials to auth.json: ${migratedProviders.join(", ")}`);
		}

		const modelsJsonError = this.session.modelRegistry.getError();
		if (modelsJsonError) {
			this.showError(`models.json error: ${modelsJsonError}`);
		}

		if (modelFallbackMessage) {
			this.showWarning(modelFallbackMessage);
		}

		// Process initial messages
		if (initialMessage) {
			try {
				await this.session.prompt(initialMessage, { images: initialImages });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}

		if (initialMessages) {
			for (const message of initialMessages) {
				try {
					await this.session.prompt(message);
				} catch (error: unknown) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					this.showError(errorMessage);
				}
			}
		}

		// Main interactive loop
		while (true) {
			const userInput = await this.getUserInput();
			this.recordLastSentPrompt(userInput);
			try {
				await this.session.prompt(userInput);
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}
	}

	/**
	 * Check npm registry for a newer version.
	 */
	private async checkForNewVersion(): Promise<string | undefined> {
		if (process.env.PI_SKIP_VERSION_CHECK || process.env.PI_OFFLINE) return undefined;

		try {
			const response = await fetch("https://registry.npmjs.org/@gsd/pi-coding-agent/latest", {
				signal: AbortSignal.timeout(10000),
			});
			if (!response.ok) return undefined;

			const data = (await response.json()) as { version?: string };
			const latestVersion = data.version;

			if (latestVersion && latestVersion !== this.version) {
				return latestVersion;
			}

			return undefined;
		} catch {
			return undefined;
		}
	}

	private async checkTmuxKeyboardSetup(): Promise<string | undefined> {
		if (!process.env.TMUX) return undefined;

		const runTmuxShow = (option: string): Promise<string | undefined> => {
			return new Promise((resolve) => {
				const proc = spawn("tmux", ["show", "-gv", option], {
					stdio: ["ignore", "pipe", "ignore"],
				});
				let stdout = "";
				const timer = setTimeout(() => {
					proc.kill();
					resolve(undefined);
				}, 2000);

				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.on("error", () => {
					clearTimeout(timer);
					resolve(undefined);
				});
				proc.on("close", (code) => {
					clearTimeout(timer);
					resolve(code === 0 ? stdout.trim() : undefined);
				});
			});
		};

		const [extendedKeys, extendedKeysFormat] = await Promise.all([
			runTmuxShow("extended-keys"),
			runTmuxShow("extended-keys-format"),
		]);

		if (extendedKeys !== "on" && extendedKeys !== "always") {
			return "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.";
		}

		if (extendedKeysFormat === "xterm") {
			return "tmux extended-keys-format is xterm. Pi works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.";
		}

		return undefined;
	}

	/**
	 * Get changelog entries to display on startup.
	 * Only shows new entries since last seen version, skips for resumed sessions.
	 */
	private getChangelogForDisplay(): string | undefined {
		// Skip changelog for resumed/continued sessions (already have messages)
		if (this.session.state.messages.length > 0) {
			return undefined;
		}

		const lastVersion = this.settingsManager.getLastChangelogVersion();
		const changelogPath = getChangelogPath();
		const entries = parseChangelog(changelogPath);

		if (!lastVersion) {
			// Fresh install - just record the version, don't show changelog
			this.settingsManager.setLastChangelogVersion(VERSION);
			return undefined;
		} else {
			const newEntries = getNewEntries(entries, lastVersion);
			if (newEntries.length > 0) {
				this.settingsManager.setLastChangelogVersion(VERSION);
				return newEntries.map((e) => e.content).join("\n\n");
			}
		}

		return undefined;
	}

	private getMarkdownThemeWithSettings(): MarkdownTheme {
		return {
			...getMarkdownTheme(),
			codeBlockIndent: this.settingsManager.getCodeBlockIndent(),
		};
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	private formatDisplayPath(p: string): string {
		const home = os.homedir();
		let result = p;

		// Replace home directory with ~
		if (result.startsWith(home)) {
			result = `~${result.slice(home.length)}`;
		}

		return result;
	}

	/**
	 * Get a short path relative to the package root for display.
	 */
	private getShortPath(fullPath: string, source: string): string {
		// For npm packages, show path relative to node_modules/pkg/
		const npmMatch = fullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
		if (npmMatch && source.startsWith("npm:")) {
			return npmMatch[2];
		}

		// For git packages, show path relative to repo root
		const gitMatch = fullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
		if (gitMatch && source.startsWith("git:")) {
			return gitMatch[1];
		}

		// For local/auto, just use formatDisplayPath
		return this.formatDisplayPath(fullPath);
	}

	private getDisplaySourceInfo(
		source: string,
		scope: string,
	): { label: string; scopeLabel?: string; color: "accent" | "muted" } {
		if (source === "local") {
			if (scope === "user") {
				return { label: "user", color: "muted" };
			}
			if (scope === "project") {
				return { label: "project", color: "muted" };
			}
			if (scope === "temporary") {
				return { label: "path", scopeLabel: "temp", color: "muted" };
			}
			return { label: "path", color: "muted" };
		}

		if (source === "cli") {
			return { label: "path", scopeLabel: scope === "temporary" ? "temp" : undefined, color: "muted" };
		}

		const scopeLabel =
			scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : undefined;
		return { label: source, scopeLabel, color: "accent" };
	}

	private getScopeGroup(source: string, scope: string): "user" | "project" | "path" {
		if (source === "cli" || scope === "temporary") return "path";
		if (scope === "user") return "user";
		if (scope === "project") return "project";
		return "path";
	}

	private isPackageSource(source: string): boolean {
		return source.startsWith("npm:") || source.startsWith("git:");
	}

	private buildScopeGroups(
		paths: string[],
		metadata: Map<string, { source: string; scope: string; origin: string }>,
	): Array<{ scope: "user" | "project" | "path"; paths: string[]; packages: Map<string, string[]> }> {
		const groups: Record<
			"user" | "project" | "path",
			{ scope: "user" | "project" | "path"; paths: string[]; packages: Map<string, string[]> }
		> = {
			user: { scope: "user", paths: [], packages: new Map() },
			project: { scope: "project", paths: [], packages: new Map() },
			path: { scope: "path", paths: [], packages: new Map() },
		};

		for (const p of paths) {
			const meta = this.findMetadata(p, metadata);
			const source = meta?.source ?? "local";
			const scope = meta?.scope ?? "project";
			const groupKey = this.getScopeGroup(source, scope);
			const group = groups[groupKey];

			if (this.isPackageSource(source)) {
				const list = group.packages.get(source) ?? [];
				list.push(p);
				group.packages.set(source, list);
			} else {
				group.paths.push(p);
			}
		}

		return [groups.project, groups.user, groups.path].filter(
			(group) => group.paths.length > 0 || group.packages.size > 0,
		);
	}

	private formatScopeGroups(
		groups: Array<{ scope: "user" | "project" | "path"; paths: string[]; packages: Map<string, string[]> }>,
		options: {
			formatPath: (p: string) => string;
			formatPackagePath: (p: string, source: string) => string;
		},
	): string {
		const lines: string[] = [];

		for (const group of groups) {
			lines.push(`  ${theme.fg("accent", group.scope)}`);

			const sortedPaths = [...group.paths].sort((a, b) => a.localeCompare(b));
			for (const p of sortedPaths) {
				lines.push(theme.fg("dim", `    ${options.formatPath(p)}`));
			}

			const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
			for (const [source, paths] of sortedPackages) {
				lines.push(`    ${theme.fg("mdLink", source)}`);
				const sortedPackagePaths = [...paths].sort((a, b) => a.localeCompare(b));
				for (const p of sortedPackagePaths) {
					lines.push(theme.fg("dim", `      ${options.formatPackagePath(p, source)}`));
				}
			}
		}

		return lines.join("\n");
	}

	/**
	 * Find metadata for a path, checking parent directories if exact match fails.
	 * Package manager stores metadata for directories, but we display file paths.
	 */
	private findMetadata(
		p: string,
		metadata: Map<string, { source: string; scope: string; origin: string }>,
	): { source: string; scope: string; origin: string } | undefined {
		// Try exact match first
		const exact = metadata.get(p);
		if (exact) return exact;

		// Try parent directories (package manager stores directory paths)
		let current = p;
		let parent = path.dirname(current);
		while (parent !== current) {
			const meta = metadata.get(parent);
			if (meta) return meta;
			current = parent;
			parent = path.dirname(current);
		}

		return undefined;
	}

	/**
	 * Format a path with its source/scope info from metadata.
	 */
	private formatPathWithSource(
		p: string,
		metadata: Map<string, { source: string; scope: string; origin: string }>,
	): string {
		const meta = this.findMetadata(p, metadata);
		if (meta) {
			const shortPath = this.getShortPath(p, meta.source);
			const { label, scopeLabel } = this.getDisplaySourceInfo(meta.source, meta.scope);
			const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
			return `${labelText} ${shortPath}`;
		}
		return this.formatDisplayPath(p);
	}

	/**
	 * Format resource diagnostics with nice collision display using metadata.
	 */
	private formatDiagnostics(
		diagnostics: readonly ResourceDiagnostic[],
		metadata: Map<string, { source: string; scope: string; origin: string }>,
	): string {
		const lines: string[] = [];

		// Group collision diagnostics by name
		const collisions = new Map<string, ResourceDiagnostic[]>();
		const otherDiagnostics: ResourceDiagnostic[] = [];

		for (const d of diagnostics) {
			if (d.type === "collision" && d.collision) {
				const list = collisions.get(d.collision.name) ?? [];
				list.push(d);
				collisions.set(d.collision.name, list);
			} else {
				otherDiagnostics.push(d);
			}
		}

		// Format collision diagnostics grouped by name
		for (const [name, collisionList] of collisions) {
			const first = collisionList[0]?.collision;
			if (!first) continue;
			lines.push(theme.fg("warning", `  "${name}" collision:`));
			// Show winner
			lines.push(
				theme.fg("dim", `    ${theme.fg("success", "✓")} ${this.formatPathWithSource(first.winnerPath, metadata)}`),
			);
			// Show all losers
			for (const d of collisionList) {
				if (d.collision) {
					lines.push(
						theme.fg(
							"dim",
							`    ${theme.fg("warning", "✗")} ${this.formatPathWithSource(d.collision.loserPath, metadata)} (skipped)`,
						),
					);
				}
			}
		}

		// Format other diagnostics (skill name collisions, parse errors, etc.)
		for (const d of otherDiagnostics) {
			if (d.path) {
				// Use metadata-aware formatting for paths
				const sourceInfo = this.formatPathWithSource(d.path, metadata);
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${sourceInfo}`));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `    ${d.message}`));
			} else {
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`));
			}
		}

		return lines.join("\n");
	}

	private showLoadedResources(options?: {
		extensionPaths?: string[];
		force?: boolean;
		showDiagnosticsWhenQuiet?: boolean;
	}): void {
		const showListing = options?.force || this.options.verbose || !this.settingsManager.getQuietStartup();
		const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
		if (!showListing && !showDiagnostics) {
			return;
		}

		const metadata = this.session.resourceLoader.getPathMetadata();
		const sectionHeader = (name: string, color: ThemeColor = "mdHeading") => theme.fg(color, `[${name}]`);

		const skillsResult = this.session.resourceLoader.getSkills();
		const promptsResult = this.session.resourceLoader.getPrompts();
		const themesResult = this.session.resourceLoader.getThemes();

		if (showListing) {
			const contextFiles = this.session.resourceLoader.getAgentsFiles().agentsFiles;
			if (contextFiles.length > 0) {
				this.chatContainer.addChild(new Spacer(1));
				const contextList = contextFiles
					.map((f) => theme.fg("dim", `  ${this.formatDisplayPath(f.path)}`))
					.join("\n");
				this.chatContainer.addChild(new Text(`${sectionHeader("Context")}\n${contextList}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			const skills = skillsResult.skills;
			if (skills.length > 0) {
				const skillPaths = skills.map((s) => s.filePath);
				const groups = this.buildScopeGroups(skillPaths, metadata);
				const skillList = this.formatScopeGroups(groups, {
					formatPath: (p) => this.formatDisplayPath(p),
					formatPackagePath: (p, source) => this.getShortPath(p, source),
				});
				this.chatContainer.addChild(new Text(`${sectionHeader("Skills")}\n${skillList}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			const templates = this.session.promptTemplates;
			if (templates.length > 0) {
				const templatePaths = templates.map((t) => t.filePath);
				const groups = this.buildScopeGroups(templatePaths, metadata);
				const templateByPath = new Map(templates.map((t) => [t.filePath, t]));
				const templateList = this.formatScopeGroups(groups, {
					formatPath: (p) => {
						const template = templateByPath.get(p);
						return template ? `/${template.name}` : this.formatDisplayPath(p);
					},
					formatPackagePath: (p) => {
						const template = templateByPath.get(p);
						return template ? `/${template.name}` : this.formatDisplayPath(p);
					},
				});
				this.chatContainer.addChild(new Text(`${sectionHeader("Prompts")}\n${templateList}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			const extensionPaths = options?.extensionPaths ?? [];
			if (extensionPaths.length > 0) {
				const groups = this.buildScopeGroups(extensionPaths, metadata);
				const extList = this.formatScopeGroups(groups, {
					formatPath: (p) => this.formatDisplayPath(p),
					formatPackagePath: (p, source) => this.getShortPath(p, source),
				});
				this.chatContainer.addChild(new Text(`${sectionHeader("Extensions", "mdHeading")}\n${extList}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			// Show loaded themes (excluding built-in)
			const loadedThemes = themesResult.themes;
			const customThemes = loadedThemes.filter((t) => t.sourcePath);
			if (customThemes.length > 0) {
				const themePaths = customThemes.map((t) => t.sourcePath!);
				const groups = this.buildScopeGroups(themePaths, metadata);
				const themeList = this.formatScopeGroups(groups, {
					formatPath: (p) => this.formatDisplayPath(p),
					formatPackagePath: (p, source) => this.getShortPath(p, source),
				});
				this.chatContainer.addChild(new Text(`${sectionHeader("Themes")}\n${themeList}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}
		}

		if (showDiagnostics) {
			const skillDiagnostics = skillsResult.diagnostics;
			if (skillDiagnostics.length > 0) {
				const collisionDiags = skillDiagnostics.filter(d => d.type === "collision");
				const issueDiags = skillDiagnostics.filter(d => d.type !== "collision");

				if (collisionDiags.length > 0) {
					const collisionLines = this.formatDiagnostics(collisionDiags, metadata);
					this.chatContainer.addChild(new Text(`${theme.fg("warning", "[Skill conflicts]")}\n${collisionLines}`, 0, 0));
					this.chatContainer.addChild(new Spacer(1));
				}

				if (issueDiags.length > 0) {
					const issueLines = this.formatDiagnostics(issueDiags, metadata);
					this.chatContainer.addChild(new Text(`${theme.fg("warning", "[Skill issues]")}\n${issueLines}`, 0, 0));
					this.chatContainer.addChild(new Spacer(1));
				}
			}

			const promptDiagnostics = promptsResult.diagnostics;
			if (promptDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(promptDiagnostics, metadata);
				this.chatContainer.addChild(
					new Text(`${theme.fg("warning", "[Prompt conflicts]")}\n${warningLines}`, 0, 0),
				);
				this.chatContainer.addChild(new Spacer(1));
			}

			const extensionDiagnostics: ResourceDiagnostic[] = [];
			const extensionErrors = this.session.resourceLoader.getExtensions().errors;
			if (extensionErrors.length > 0) {
				for (const error of extensionErrors) {
					extensionDiagnostics.push({ type: "error", message: error.error, path: error.path });
				}
			}

			const commandDiagnostics = this.session.extensionRunner?.getCommandDiagnostics() ?? [];
			extensionDiagnostics.push(...commandDiagnostics);

			const shortcutDiagnostics = this.session.extensionRunner?.getShortcutDiagnostics() ?? [];
			extensionDiagnostics.push(...shortcutDiagnostics);

			if (extensionDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(extensionDiagnostics, metadata);
				this.chatContainer.addChild(
					new Text(`${theme.fg("warning", "[Extension issues]")}\n${warningLines}`, 0, 0),
				);
				this.chatContainer.addChild(new Spacer(1));
			}

			const themeDiagnostics = themesResult.diagnostics;
			if (themeDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(themeDiagnostics, metadata);
				this.chatContainer.addChild(new Text(`${theme.fg("warning", "[Theme conflicts]")}\n${warningLines}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}
		}
	}

	/**
	 * Initialize the extension system with TUI-based UI context.
	 */
	private async initExtensions(): Promise<void> {
		if (this.options.bindExtensions !== false) {
			const uiContext = this.createExtensionUIContext();
			await this.session.bindExtensions({
				uiContext,
				commandContextActions: {
					waitForIdle: () => this.session.agent.waitForIdle(),
					newSession: async (options) => {
						if (this.loadingAnimation) {
							this.loadingAnimation.stop();
							this.loadingAnimation = undefined;
						}
						this.statusContainer.clear();

						// Delegate to AgentSession (handles setup + agent state sync)
						const success = await this.session.newSession(options);
						if (!success) {
							return { cancelled: true };
						}

						// Clear UI state
						this.chatContainer.clear();
						this.pendingMessagesContainer.clear();
						this.compactionQueuedMessages = [];
						this.streamingComponent = undefined;
						this.streamingMessage = undefined;
						this.pendingTools.clear();

						// Render any messages added via setup, or show empty session
						this.renderInitialMessages();
						this.ui.requestRender();

						return { cancelled: false };
					},
					fork: async (entryId) => {
						const result = await this.session.fork(entryId);
						if (result.cancelled) {
							return { cancelled: true };
						}

						this.chatContainer.clear();
						this.renderInitialMessages();
						this.editor.setText(result.selectedText);
						this.showStatus("Forked to new session");

						return { cancelled: false };
					},
					navigateTree: async (targetId, options) => {
						const result = await this.session.navigateTree(targetId, {
							summarize: options?.summarize,
							customInstructions: options?.customInstructions,
							replaceInstructions: options?.replaceInstructions,
							label: options?.label,
						});
						if (result.cancelled) {
							return { cancelled: true };
						}

						this.chatContainer.clear();
						this.renderInitialMessages();
						if (result.editorText && !this.editor.getText().trim()) {
							this.editor.setText(result.editorText);
						}
						this.showStatus("Navigated to selected point");

						return { cancelled: false };
					},
					switchSession: async (sessionPath) => {
						await this.handleResumeSession(sessionPath);
						return { cancelled: false };
					},
					reload: async () => {
						await this.handleReloadCommand();
					},
				},
				executeSlashCommand: async (text, options) => {
					// Try extension commands first
					const extensionHandled = await this.session.tryExecuteExtensionCommand(text);
					if (extensionHandled) {
						return true;
					}
					// Fall back to built-in commands
					return dispatchSlashCommand(text, this.getSlashCommandContext());
				},
				shutdownHandler: () => {
					this.shutdownRequested = true;
					if (!this.session.isStreaming) {
						void this.shutdown();
					}
				},
				onError: (error) => {
					this.showExtensionError(error.extensionPath, error.error, error.stack);
				},
			});
		}

		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.setupAutocomplete();

		const extensionRunner = this.session.extensionRunner;
		if (!extensionRunner) {
			this.showLoadedResources({ extensionPaths: [], force: false });
			return;
		}

		this.setupExtensionShortcuts(extensionRunner);
		this.showLoadedResources({ extensionPaths: extensionRunner.getExtensionPaths(), force: false });
	}

	/**
	 * Get a tool definition by name (for custom rendering).
	 */
	private getRegisteredToolDefinition(toolName: string) {
		return this.session.getRenderableToolDefinition(toolName);
	}

	/**
	 * Format web search result content for display in the TUI.
	 */
	private formatWebSearchResult(content: unknown): string {
		if (!content) return "Web search completed";

		// Error result
		if (typeof content === "object" && "type" in (content as any) && (content as any).type === "web_search_tool_result_error") {
			const error = content as any;
			return `Search error: ${error.error_code || "unknown"}`;
		}

		// Array of search results
		if (Array.isArray(content)) {
			const results = content.filter((r: any) => r.type === "web_search_result");
			if (results.length === 0) return "No results found";
			return results
				.map((r: any) => {
					const title = r.title || "Untitled";
					const url = r.url || "";
					return `${title}\n  ${url}`;
				})
				.join("\n");
		}

		return "Web search completed";
	}

	/**
	 * Set up keyboard shortcuts registered by extensions.
	 */
	private setupExtensionShortcuts(extensionRunner: ExtensionRunner): void {
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size === 0) return;

		// Create a context for shortcut handlers
		const createContext = (): ExtensionContext => ({
			ui: this.createExtensionUIContext(),
			hasUI: true,
			cwd: process.cwd(),
			sessionManager: this.sessionManager,
			modelRegistry: this.session.modelRegistry,
			model: this.session.model,
			isIdle: () => !this.session.isStreaming,
			abort: () => this.session.abort(),
			hasPendingMessages: () => this.session.pendingMessageCount > 0,
			shutdown: () => {
				this.shutdownRequested = true;
			},
			getContextUsage: () => this.session.getContextUsage(),
			compact: (options) => {
				void (async () => {
					try {
						const result = await this.executeCompaction(options?.customInstructions, false);
						if (result) {
							options?.onComplete?.(result);
						}
					} catch (error) {
						const err = error instanceof Error ? error : new Error(String(error));
						options?.onError?.(err);
					}
				})();
			},
			getSystemPrompt: () => this.session.systemPrompt,
		});

		// Set up the extension shortcut handler on the default editor
		this.defaultEditor.onExtensionShortcut = (data: string) => {
			for (const [shortcutStr, shortcut] of shortcuts) {
				// Cast to KeyId - extension shortcuts use the same format
				if (matchesKey(data, shortcutStr as KeyId)) {
					// Run handler async, don't block input
					Promise.resolve(shortcut.handler(createContext())).catch((err) => {
						this.showError(`Shortcut handler error: ${err instanceof Error ? err.message : String(err)}`);
					});
					return true;
				}
			}
			return false;
		};
	}

	/**
	 * Set extension status text in the footer.
	 */
	private setExtensionStatus(key: string, text: string | undefined): void {
		this.footerDataProvider.setExtensionStatus(key, text);
		this.ui.requestRender();
	}

	/**
	 * Set an extension widget (string array or custom component).
	 */
	private setExtensionWidget(
		key: string,
		content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void {
		const placement = options?.placement ?? "aboveEditor";
		const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
			const existing = map.get(key);
			if (existing?.dispose) existing.dispose();
			map.delete(key);
		};

		removeExisting(this.extensionWidgetsAbove);
		removeExisting(this.extensionWidgetsBelow);

		if (content === undefined) {
			this.renderWidgets();
			return;
		}

		let component: Component & { dispose?(): void };

		if (Array.isArray(content)) {
			// Wrap string array in a Container with Text components
			const container = new Container();
			for (const line of content.slice(0, InteractiveMode.MAX_WIDGET_LINES)) {
				container.addChild(new Text(line, 1, 0));
			}
			if (content.length > InteractiveMode.MAX_WIDGET_LINES) {
				container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
			component = container;
		} else {
			// Factory function - create component
			component = content(this.ui, theme);
		}

		const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
		targetMap.set(key, component);
		this.renderWidgets();
	}

	private clearExtensionWidgets(): void {
		for (const widget of this.extensionWidgetsAbove.values()) {
			widget.dispose?.();
		}
		for (const widget of this.extensionWidgetsBelow.values()) {
			widget.dispose?.();
		}
		this.extensionWidgetsAbove.clear();
		this.extensionWidgetsBelow.clear();
		this.renderWidgets();
	}

	private resetExtensionUI(): void {
		if (this.extensionSelector) {
			this.hideExtensionSelector();
		}
		if (this.extensionInput) {
			this.hideExtensionInput();
		}
		if (this.extensionEditor) {
			this.hideExtensionEditor();
		}
		this.ui.hideOverlay();
		this.clearExtensionTerminalInputListeners();
		this.setExtensionFooter(undefined);
		this.setExtensionHeader(undefined);
		this.clearExtensionWidgets();
		this.footerDataProvider.clearExtensionStatuses();
		this.footer.invalidate();
		this.setCustomEditorComponent(undefined);
		this.defaultEditor.onExtensionShortcut = undefined;
		this.updateTerminalTitle();
		if (this.loadingAnimation) {
			this.loadingAnimation.setCycleMessages(this.workingMessages);
		}
	}

	// Maximum total widget lines to prevent viewport overflow
	private static readonly MAX_WIDGET_LINES = 10;

	/**
	 * Render all extension widgets to the widget container.
	 */
	/**
	 * Record the last user-sent prompt text and refresh the widget.
	 * Called from the main loop and input-controller paths.
	 */
	recordLastSentPrompt(text: string): void {
		// Ignore slash commands and bash commands - they're not "topic" prompts
		const trimmed = text.trim();
		if (trimmed.startsWith("/") || trimmed.startsWith("!")) return;
		this.lastSentPromptText = trimmed;
		this.updatePinLastPromptWidget();
	}

	/**
	 * Update (or remove) the "pin last prompt" widget above the editor.
	 * Uses the built-in extension widget slot with key "__pin-last-prompt__".
	 */
	private updatePinLastPromptWidget(): void {
		const key = "__pin-last-prompt__";
		if (!this.pinLastPromptEnabled || !this.lastSentPromptText) {
			// Remove widget
			const existing = this.extensionWidgetsAbove.get(key);
			if (existing?.dispose) existing.dispose();
			this.extensionWidgetsAbove.delete(key);
		} else {
			// Truncate to one line (max 200 chars) to keep it compact
			const raw = this.lastSentPromptText.replace(/[\r\n]+/g, " ").trim();
			const label = raw.length > 200 ? raw.slice(0, 197) + "…" : raw;
			const container = new Container();
			container.addChild(new Text(
				theme.fg("dim", `  last prompt: ${label}`),
				0,
				0,
			));
			this.extensionWidgetsAbove.set(key, container);
		}
		this.renderWidgets();
	}

	private renderWidgets(): void {
		if (!this.widgetContainerAbove || !this.widgetContainerBelow) return;
		this.renderWidgetContainer(this.widgetContainerAbove, this.extensionWidgetsAbove, true, true);
		this.renderWidgetContainer(this.widgetContainerBelow, this.extensionWidgetsBelow, false, false);
		this.ui.requestRender();
	}

	private startLoadingTips(): void {
		this.stopLoadingTips();
		const tip = this.loadingTips[this.loadingTipIndex % this.loadingTips.length];
		if (!tip) return;
		this.loadingTipText = new Text(theme.fg("dim", `  ${tip}`), 1, 0);
		this.statusContainer.addChild(this.loadingTipText);
		this.loadingTipIndex = (this.loadingTipIndex + 1) % this.loadingTips.length;
		this.loadingTipsInterval = setInterval(() => {
			if (!this.loadingTipText) return;
			const nextTip = this.loadingTips[this.loadingTipIndex % this.loadingTips.length];
			if (!nextTip) return;
			this.loadingTipText.setText(theme.fg("dim", `  ${nextTip}`));
			this.loadingTipIndex = (this.loadingTipIndex + 1) % this.loadingTips.length;
			this.ui.requestRender();
		}, 10_000);
	}

	private stopLoadingTips(): void {
		if (this.loadingTipsInterval) {
			clearInterval(this.loadingTipsInterval);
			this.loadingTipsInterval = undefined;
		}
		if (this.loadingTipText) {
			this.statusContainer.removeChild(this.loadingTipText);
			this.loadingTipText = undefined;
		}
	}

	private renderWidgetContainer(
		container: Container,
		widgets: Map<string, Component & { dispose?(): void }>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void {
		container.clear();

		if (widgets.size === 0) {
			if (spacerWhenEmpty) {
				container.addChild(new Spacer(1));
			}
			return;
		}

		if (leadingSpacer) {
			container.addChild(new Spacer(1));
		}
		for (const component of widgets.values()) {
			container.addChild(component);
		}
	}

	/**
	 * Set a custom footer component, or restore the built-in footer.
	 */
	private setExtensionFooter(
		factory:
			| ((tui: TUI, thm: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void {
		// Dispose existing custom footer
		if (this.customFooter?.dispose) {
			this.customFooter.dispose();
		}

		// Remove current footer from UI
		if (this.customFooter) {
			this.ui.removeChild(this.customFooter);
		} else {
			this.ui.removeChild(this.footer);
		}

		if (factory) {
			// Create and add custom footer, passing the data provider
			this.customFooter = factory(this.ui, theme, this.footerDataProvider);
			this.ui.addChild(this.customFooter);
		} else {
			// Restore built-in footer
			this.customFooter = undefined;
			this.ui.addChild(this.footer);
		}

		this.ui.requestRender();
	}

	/**
	 * Set a custom header component, or restore the built-in header.
	 */
	private setExtensionHeader(factory: ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined): void {
		// Header may not be initialized yet if called during early initialization
		if (!this.builtInHeader) {
			return;
		}

		// Dispose existing custom header
		if (this.customHeader?.dispose) {
			this.customHeader.dispose();
		}

		// Find the index of the current header in the header container
		const currentHeader = this.customHeader || this.builtInHeader;
		const index = this.headerContainer.children.indexOf(currentHeader);

		if (factory) {
			// Create and add custom header
			this.customHeader = factory(this.ui, theme);
			if (index !== -1) {
				this.headerContainer.children[index] = this.customHeader;
			} else {
				// If not found (e.g. builtInHeader was never added), add at the top
				this.headerContainer.children.unshift(this.customHeader);
			}
		} else {
			// Restore built-in header
			this.customHeader = undefined;
			if (index !== -1) {
				this.headerContainer.children[index] = this.builtInHeader;
			}
		}

		this.ui.requestRender();
	}

	private addExtensionTerminalInputListener(
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void {
		const unsubscribe = this.ui.addInputListener(handler);
		this.extensionTerminalInputUnsubscribers.add(unsubscribe);
		return () => {
			unsubscribe();
			this.extensionTerminalInputUnsubscribers.delete(unsubscribe);
		};
	}

	private clearExtensionTerminalInputListeners(): void {
		for (const unsubscribe of this.extensionTerminalInputUnsubscribers) {
			unsubscribe();
		}
		this.extensionTerminalInputUnsubscribers.clear();
	}

	/**
	 * Create the ExtensionUIContext for extensions.
	 */
	private createExtensionUIContext(): ExtensionUIContext {
		return buildExtensionUIContext(this);
	}

	getExtensionUIContext(): ExtensionUIContext {
		return this.createExtensionUIContext();
	}

	private emitExtensionUIRequest(event: {
		id: string;
		method: "select" | "confirm" | "input" | "editor";
		title: string;
		options?: string[];
		message?: string;
		placeholder?: string;
		prefill?: string;
		timeout?: number;
		allowMultiple?: boolean;
		respond: (response: { value: string } | { values: string[] } | { confirmed: boolean } | { cancelled: true }) => boolean;
	}): void {
		void this.session.extensionRunner?.emit({ type: "extension_ui_request", ...event });
	}

	private emitExtensionUIResponse(event: {
		id: string;
		method: "select" | "confirm" | "input" | "editor";
		response: { value: string } | { values: string[] } | { confirmed: boolean } | { cancelled: true };
		source: "local" | "extension" | "timeout" | "abort";
	}): void {
		void this.session.extensionRunner?.emit({ type: "extension_ui_response", ...event });
	}

	/**
	 * Show a selector for extensions.
	 */
	private showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
	): Promise<string | string[] | undefined> {
		// If a previous selector is still active, dispose it before creating a
		// new one.  This avoids leaking the previous promise and DOM state when
		// showExtensionSelector is called rapidly.
		if (this.extensionSelector) {
			this.hideExtensionSelector();
		}

		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const requestId = crypto.randomUUID();
			let settled = false;
			const settle = (
				value: string | string[] | undefined,
				response: { value: string } | { values: string[] } | { cancelled: true },
				source: "local" | "extension" | "timeout" | "abort",
			) => {
				if (settled) return false;
				settled = true;
				opts?.signal?.removeEventListener("abort", onAbort);
				this.hideExtensionSelector();
				this.emitExtensionUIResponse({ id: requestId, method: "select", response, source });
				resolve(value);
				return true;
			};

			const onAbort = () => {
				settle(undefined, { cancelled: true }, "abort");
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionSelector = new ExtensionSelectorComponent(
				title,
				options,
				(selection) => {
					if (Array.isArray(selection)) {
						settle(selection, { values: selection }, "local");
						return;
					}
					settle(selection, { value: selection }, "local");
				},
				() => {
					settle(undefined, { cancelled: true }, "local");
				},
				{ tui: this.ui, timeout: opts?.timeout, allowMultiple: opts?.allowMultiple },
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionSelector);
			this.ui.setFocus(this.extensionSelector);
			this.ui.requestRender();

			this.emitExtensionUIRequest({
				id: requestId,
				method: "select",
				title,
				options,
				timeout: opts?.timeout,
				allowMultiple: opts?.allowMultiple,
				respond: (response) => {
					if ("cancelled" in response && response.cancelled) {
						return settle(undefined, { cancelled: true }, "extension");
					}
					if ("values" in response) {
						return settle(response.values, { values: response.values }, "extension");
					}
					if ("value" in response) {
						return settle(response.value, { value: response.value }, "extension");
					}
					return false;
				},
			});
		});
	}

	/**
	 * Hide the extension selector.
	 */
	private hideExtensionSelector(): void {
		this.extensionSelector?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionSelector = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a confirmation dialog for extensions.
	 */
	private async showExtensionConfirm(
		title: string,
		message: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts);
		return result === "Yes";
	}

	/** Reset the loading animation back to cycling working messages. */
	private resetLoadingMessage(): void {
		if (this.loadingAnimation) {
			this.loadingAnimation.setCycleMessages(this.workingMessages);
		}
	}

	private _registerApprovalHandlers(): void {
		const classifierService = new ClassifierService(this.session.modelRegistry.authStorage);

		setFileChangeApprovalHandler(async (request) => {
			this.loadingAnimation?.setMessage("Waiting for approval…");

			const actionLabel = request.action.toUpperCase();
			const title = `Allow ${actionLabel}: ${request.path}\n${request.message}`;
			const approved = await this._showApprovalConfirm(title);

			this.resetLoadingMessage();
			return approved;
		});

		setClassifierHandler(async (request) => {
			this.loadingAnimation?.setMessage("Classifying tool call…");

			const argsPreview = (() => {
				try {
					const s = JSON.stringify(request.args);
					return s.length > 120 ? s.slice(0, 120) + "…" : s;
				} catch {
					return String(request.args);
				}
			})();

			const context = {
				userMessages: this.session.agent.state.messages
					.filter((message) => message.role === "user")
					.slice(-10)
					.map((message) => {
						if (typeof message.content === "string") return message.content;
						return message.content
							.filter((block): block is { type: "text"; text: string } => block.type === "text")
							.map((block) => block.text)
							.join("\n");
					})
					.filter((text) => text.trim().length > 0),
				projectInstructions: undefined,
			};

			const classifierModel = this.settingsManager.getClassifierModel();
			const classifierProvider = classifierModel?.startsWith("google/") ? "google" : "anthropic";
			const decision = await classifierService.classifyToolCall(request.toolName, request.args, context, {
				provider: classifierProvider,
				classifierModel: classifierModel ?? process.env.LUCENT_CODE_CLASSIFIER_MODEL,
				sessionId: this.session.sessionId,
			});

			if (decision.approved) {
				this.resetLoadingMessage();
				return true;
			}

			this.loadingAnimation?.setMessage("Waiting for approval…");
			const title = `Classifier ${decision.source === "rule" ? "blocked" : "did not approve"} ${request.toolName}\n${decision.reason}\n${argsPreview}`;
			const approved = await this._showApprovalConfirm(title);

			this.resetLoadingMessage();
			return approved;
		});

		setNetworkApprovalHandler(async (request) => {
			this.loadingAnimation?.setMessage("Waiting for network approval…");
			const result = await this.showExtensionSelector(
				`${request.message}\n${request.command}`,
				["Allow once", "Allow for session", "Deny"],
			);
			this.resetLoadingMessage();
			if (result === "Allow once") return "allow-once";
			if (result === "Allow for session") return "allow-session";
			return "deny";
		});
	}

	private async _showApprovalConfirm(title: string): Promise<boolean> {
		const result = await this.showExtensionSelector(title, ["Yes", "No"]);
		return result === "Yes";
	}

	/**
	 * Show a text input for extensions.
	 */
	private showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const requestId = crypto.randomUUID();
			let settled = false;
			const settle = (
				value: string | undefined,
				response: { value: string } | { cancelled: true },
				source: "local" | "extension" | "timeout" | "abort",
			) => {
				if (settled) return false;
				settled = true;
				opts?.signal?.removeEventListener("abort", onAbort);
				this.hideExtensionInput();
				this.emitExtensionUIResponse({ id: requestId, method: "input", response, source });
				resolve(value);
				return true;
			};

			const onAbort = () => {
				settle(undefined, { cancelled: true }, "abort");
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionInput = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					settle(value, { value }, "local");
				},
				() => {
					settle(undefined, { cancelled: true }, "local");
				},
				{ tui: this.ui, timeout: opts?.timeout },
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionInput);
			this.ui.setFocus(this.extensionInput);
			this.ui.requestRender();

			this.emitExtensionUIRequest({
				id: requestId,
				method: "input",
				title,
				placeholder,
				timeout: opts?.timeout,
				respond: (response) => {
					if ("cancelled" in response && response.cancelled) {
						return settle(undefined, { cancelled: true }, "extension");
					}
					if ("value" in response) {
						return settle(response.value, { value: response.value }, "extension");
					}
					return false;
				},
			});
		});
	}

	/**
	 * Hide the extension input.
	 */
	private hideExtensionInput(): void {
		this.extensionInput?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionInput = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a multi-line editor for extensions (with Ctrl+G support).
	 */
	private showExtensionEditor(title: string, prefill?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			const requestId = crypto.randomUUID();
			let settled = false;
			const settle = (value: string | undefined, response: { value: string } | { cancelled: true }, source: "local" | "extension") => {
				if (settled) return false;
				settled = true;
				this.hideExtensionEditor();
				this.emitExtensionUIResponse({ id: requestId, method: "editor", response, source });
				resolve(value);
				return true;
			};

			this.extensionEditor = new ExtensionEditorComponent(
				this.ui,
				this.keybindings,
				title,
				prefill,
				(value) => {
					settle(value, { value }, "local");
				},
				() => {
					settle(undefined, { cancelled: true }, "local");
				},
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionEditor);
			this.ui.setFocus(this.extensionEditor);
			this.ui.requestRender();

			this.emitExtensionUIRequest({
				id: requestId,
				method: "editor",
				title,
				prefill,
				respond: (response) => {
					if ("cancelled" in response && response.cancelled) {
						return settle(undefined, { cancelled: true }, "extension");
					}
					if ("value" in response) {
						return settle(response.value, { value: response.value }, "extension");
					}
					return false;
				},
			});
		});
	}

	/**
	 * Hide the extension editor.
	 */
	private hideExtensionEditor(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionEditor = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Set a custom editor component from an extension.
	 * Pass undefined to restore the default editor.
	 */
	private setCustomEditorComponent(
		factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent) | undefined,
	): void {
		// Save text from current editor before switching
		const currentText = this.editor.getText();

		this.editorContainer.clear();

		if (factory) {
			// Create the custom editor with tui, theme, and keybindings
			const newEditor = factory(this.ui, getEditorTheme(), this.keybindings);

			// Wire up callbacks from the default editor
			newEditor.onSubmit = this.defaultEditor.onSubmit;
			newEditor.onChange = this.defaultEditor.onChange;

			// Copy text from previous editor
			newEditor.setText(currentText);

			// Copy appearance settings if supported
			if (newEditor.borderColor !== undefined) {
				newEditor.borderColor = this.defaultEditor.borderColor;
			}
			if (newEditor.setPaddingX !== undefined) {
				newEditor.setPaddingX(this.defaultEditor.getPaddingX());
			}

			// Set autocomplete if supported
			if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
				newEditor.setAutocompleteProvider(this.autocompleteProvider);
			}

			// If extending CustomEditor, copy app-level handlers
			// Use duck typing since instanceof fails across jiti module boundaries
			const customEditor = newEditor as unknown as Record<string, unknown>;
			if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
				if (!customEditor.onEscape) {
					customEditor.onEscape = () => this.defaultEditor.onEscape?.();
				}
				if (!customEditor.onCtrlD) {
					customEditor.onCtrlD = () => this.defaultEditor.onCtrlD?.();
				}
				if (!customEditor.onPasteImage) {
					customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();
				}
				if (!customEditor.onExtensionShortcut) {
					customEditor.onExtensionShortcut = (data: string) => this.defaultEditor.onExtensionShortcut?.(data);
				}
				// Copy action handlers (clear, suspend, model switching, etc.)
				for (const [action, handler] of this.defaultEditor.actionHandlers) {
					(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
				}
			}

			this.editor = newEditor;
		} else {
			// Restore default editor with text from custom editor
			this.defaultEditor.setText(currentText);
			this.editor = this.defaultEditor;
		}

		this.editorContainer.addChild(this.editor as Component);
		this.ui.setFocus(this.editor as Component);
		this.ui.requestRender();
	}

	/**
	 * Show a notification for extensions.
	 */
	private showExtensionNotify(message: string, type?: "info" | "warning" | "error" | "success"): void {
		if (type === "error") {
			this.showError(message);
		} else if (type === "warning") {
			this.showWarning(message);
		} else {
			this.showStatus(message);
		}
	}

	/** Show a custom component with keyboard focus. Overlay mode renders on top of existing content. */
	private async showExtensionCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> {
		const savedText = this.editor.getText();
		const isOverlay = options?.overlay ?? false;

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.editor.setText(savedText);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		return new Promise((resolve, reject) => {
			let component: Component & { dispose?(): void };
			let closed = false;

			const close = (result: T) => {
				if (closed) return;
				closed = true;
				if (isOverlay) this.ui.hideOverlay();
				else restoreEditor();
				// Note: both branches above already call requestRender
				resolve(result);
				try {
					component?.dispose?.();
				} catch {
					/* ignore dispose errors */
				}
			};

			Promise.resolve(factory(this.ui, theme, this.keybindings, close))
				.then((c) => {
					if (closed) return;
					component = c;
					if (isOverlay) {
						// Resolve overlay options - can be static or dynamic function
						const resolveOptions = (): OverlayOptions | undefined => {
							if (options?.overlayOptions) {
								const opts =
									typeof options.overlayOptions === "function"
										? options.overlayOptions()
										: options.overlayOptions;
								return opts;
							}
							// Fallback: use component's width property if available
							const w = (component as { width?: number }).width;
							return w ? { width: w } : undefined;
						};
						const handle = this.ui.showOverlay(component, resolveOptions());
						// Expose handle to caller for visibility control
						options?.onHandle?.(handle);
					} else {
						this.editorContainer.clear();
						this.editorContainer.addChild(component);
						this.ui.setFocus(component);
						this.ui.requestRender();
					}
				})
				.catch((err) => {
					if (closed) return;
					if (!isOverlay) restoreEditor();
					reject(err);
				});
		});
	}

	/**
	 * Show an extension error in the UI.
	 */
	private showExtensionError(extensionPath: string, error: string, stack?: string): void {
		const errorMsg = `Extension "${extensionPath}" error: ${error}`;
		const errorText = new Text(theme.fg("error", errorMsg), 1, 0);
		this.chatContainer.addChild(errorText);
		if (stack) {
			// Show stack trace in dim color, indented
			const stackLines = stack
				.split("\n")
				.slice(1) // Skip first line (duplicates error message)
				.map((line) => theme.fg("dim", `  ${line.trim()}`))
				.join("\n");
			if (stackLines) {
				this.chatContainer.addChild(new Text(stackLines, 1, 0));
			}
		}
		this.ui.requestRender();
	}

	// =========================================================================
	// Key Handlers
	// =========================================================================

	private setupKeyHandlers(): void {
		// Set up handlers on defaultEditor - they use this.editor for text access
		// so they work correctly regardless of which editor is active
		this.defaultEditor.onEscape = () => {
			if (this.loadingAnimation) {
				this.restoreQueuedMessagesToEditor({ abort: true });
			} else if (this.session.isBashRunning) {
				this.session.abortBash();
			} else if (this.isBashMode) {
				this.editor.setText("");
				this.isBashMode = false;
				this.updateEditorBorderColor();
			} else if (!this.editor.getText().trim()) {
				// Double-escape with empty editor triggers /tree, /fork, or nothing based on setting
				const action = this.settingsManager.getDoubleEscapeAction();
				if (action !== "none") {
					const now = Date.now();
					if (now - this.lastEscapeTime < 500) {
						if (action === "tree") {
							this.showTreeSelector();
						} else {
							this.showUserMessageSelector();
						}
						this.lastEscapeTime = 0;
					} else {
						this.lastEscapeTime = now;
					}
				}
			}
		};

		// Register app action handlers
		this.defaultEditor.onAction("clear", () => this.handleCtrlC());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onAction("suspend", () => this.handleCtrlZ());
		this.defaultEditor.onAction("cycleThinkingLevel", () => this.cycleThinkingLevel());
		this.defaultEditor.onAction("cycleModelForward", () => this.cycleModel("forward"));
		this.defaultEditor.onAction("cycleModelBackward", () => this.cycleModel("backward"));
		this.defaultEditor.onAction("cyclePermissionMode", () => this.cyclePermissionMode());
		this.defaultEditor.onAction("showHotkeys", () => showHotkeys(this.getSlashCommandContext()));
		this.defaultEditor.onAction("terminalFocus", () => this.toggleEmbeddedTerminalFocus());

		// Global debug handler on TUI (works regardless of focus)
		this.ui.onDebug = () => this.handleDebugCommand();
		this.defaultEditor.onAction("selectModel", () => this.showModelSelector());
		this.defaultEditor.onAction("expandTools", () => this.toggleToolOutputExpansion());
		this.defaultEditor.onAction("toggleThinking", () => this.toggleThinkingBlockVisibility());
		this.defaultEditor.onAction("externalEditor", () => this.openExternalEditor());
		this.defaultEditor.onAction("followUp", () => this.handleFollowUp());
		this.defaultEditor.onAction("dequeue", () => this.handleDequeue());
		this.defaultEditor.onAction("newSession", () => this.handleClearCommand());
		this.defaultEditor.onAction("tree", () => this.showTreeSelector());
		this.defaultEditor.onAction("fork", () => this.showUserMessageSelector());
		this.defaultEditor.onAction("resume", () => this.showSessionSelector());

		this.defaultEditor.onChange = (text: string) => {
			const wasBashMode = this.isBashMode;
			this.isBashMode = text.trimStart().startsWith("!");
			if (wasBashMode !== this.isBashMode) {
				this.updateEditorBorderColor();
			}
		};

		// Handle clipboard image paste (triggered on Ctrl+V)
		this.defaultEditor.onPasteImage = () => {
			this.handleClipboardImagePaste();
		};
	}

	private async handleClipboardImagePaste(): Promise<void> {
		try {
			const image = await readClipboardImage();
			if (!image) {
				return;
			}

			// Write to temp file
			const tmpDir = os.tmpdir();
			const ext = extensionForImageMimeType(image.mimeType) ?? "png";
			const fileName = `pi-clipboard-${crypto.randomUUID()}.${ext}`;
			const filePath = path.join(tmpDir, fileName);
			fs.writeFileSync(filePath, Buffer.from(image.bytes));

			// Insert file path directly
			this.editor.insertTextAtCursor?.(filePath);
			this.ui.requestRender();
		} catch {
			// Silently ignore clipboard errors (may not have permission, etc.)
		}
	}

	private getSlashCommandContext(): SlashCommandContext {
		return {
			session: this.session,
			ui: this.ui,
			keybindings: this.keybindings,
			chatContainer: this.chatContainer,
			statusContainer: this.statusContainer,
			editorContainer: this.editorContainer,
			headerContainer: this.headerContainer,
			pendingMessagesContainer: this.pendingMessagesContainer,
			editor: this.editor,
			defaultEditor: this.defaultEditor,
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
			invalidateFooter: () => this.footer.invalidate(),
			showStatus: (msg) => this.showStatus(msg),
			showError: (msg) => this.showError(msg),
			showWarning: (msg) => this.showWarning(msg),
			showSelector: (create) => this.showSelector(create),
			updateEditorBorderColor: () => this.updateEditorBorderColor(),
			getMarkdownThemeWithSettings: () => this.getMarkdownThemeWithSettings(),
			requestRender: () => this.ui.requestRender(),
			updateTerminalTitle: () => this.updateTerminalTitle(),
			showSettingsSelector: () => this.showSettingsSelector(),
			showModelsSelector: () => this.showModelsSelector(),
			handleModelCommand: (searchTerm) => this.handleModelCommand(searchTerm),
			showUserMessageSelector: () => this.showUserMessageSelector(),
			showTreeSelector: () => this.showTreeSelector(),
			showProviderManager: () => this.showProviderManager(),
			runSetupWizard: () => this.runSetupWizard(),
			cyclePermissionMode: () => this.cyclePermissionMode(),
			handleSandboxCommand: (arg) => this.handleSandboxCommand(arg),
			showOAuthSelector: (mode) => this.showOAuthSelector(mode),
			showSessionSelector: () => this.showSessionSelector(),
			handleClearCommand: () => this.handleClearCommand(),
			handleReloadCommand: () => this.handleReloadCommand(),
			handleDebugCommand: () => this.handleDebugCommand(),
			shutdown: () => this.shutdown(),
			executeCompaction: (instructions, isAuto) => this.executeCompaction(instructions, isAuto),
			handleBashCommand: (command, options) => this.handleBashCommand(command, options?.excludeFromContext, options?.displayCommand, options?.loginShell),
		};
	}

	private setupEditorSubmitHandler(): void {
		setupEditorSubmitHandlerController(this as any);
	}

	private subscribeToAgent(): void {
		this.unsubscribe = this.session.subscribe(async (event) => {
			await this.handleEvent(event);
		});
	}

	private async handleEvent(event: AgentSessionEvent): Promise<void> {
		await handleAgentEvent(this as any, event);
	}

	private getLatestPlanModeState(): { active?: boolean; latestPlanPath?: string; approvalStatus?: string } | undefined {
		try {
			const entries = this.session.sessionManager.getEntries();
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				if (entry.type === "custom" && entry.customType === "plan-mode-state" && entry.data && typeof entry.data === "object") {
					return entry.data as { active?: boolean; latestPlanPath?: string; approvalStatus?: string };
				}
			}
		} catch {
			// Best-effort UI hint only.
		}
		return undefined;
	}

	private getPlanModeEditorBadge(): string {
		// Show badge when actively in plan mode OR when plan is approved (executing)
		// Only clear when plan is cancelled or there's no plan state at all.
		const permMode = getPermissionMode();
		const planState = this.getLatestPlanModeState();

		const inPlanMode = permMode === "plan";
		const planApproved = planState?.approvalStatus === "approved" && !planState?.active;

		if (!inPlanMode && !planApproved) return "";

		const planName = planState?.latestPlanPath
			? path.basename(planState.latestPlanPath).replace(/\.md$/i, "")
			: "draft";
		const badgeText = inPlanMode
			? ` plan ${planName} · /plan to show plan `
			: ` plan ${planName} · executing `;

		// Deterministic "random" color per plan so it feels varied without flickering.
		const palette = [18, 19, 20, 24, 25, 26, 27, 54, 55, 56, 57, 60, 88, 89, 90, 124, 125, 126, 160, 161, 162];
		const seed = planState?.latestPlanPath ?? planName;
		const digest = crypto.createHash("sha256").update(seed).digest();
		const bg256 = palette[digest[0] % palette.length] ?? 25;

		return `\x1b[1m\x1b[97m\x1b[48;5;${bg256}m${badgeText}\x1b[49m\x1b[39m\x1b[22m`;
	}

	/** Extract text content from a user message */
	private getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((c: { type: string }) => c.type === "text");
		return textBlocks.map((c) => (c as { text: string }).text).join("");
	}

	/**
	 * Show a status message in the chat.
	 *
	 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
	 * we update the previous status line instead of appending new ones to avoid log spam.
	 */
	private showStatus(message: string): void {
		const children = this.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

		if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
			this.lastStatusText.setText(theme.fg("dim", message));
			this.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const text = new Text(theme.fg("dim", message), 1, 0);
		this.chatContainer.addChild(spacer);
		this.chatContainer.addChild(text);
		this.lastStatusSpacer = spacer;
		this.lastStatusText = text;
		this.ui.requestRender();
	}

	private async refreshSandboxFooterStatus(): Promise<void> {
		const sandboxManager = this.session.sandboxManager;
		if (!sandboxManager) {
			this.footerDataProvider.setSandboxStatus("disabled");
			return;
		}
		const config = sandboxManager.getSandboxConfig();
		if (!config.enabled) {
			this.footerDataProvider.setSandboxStatus("disabled");
			return;
		}
		const availability = await sandboxManager.getAvailability();
		this.footerDataProvider.setSandboxStatus(availability.available ? "active" : "unavailable");
		this.ui.requestRender();
	}

	private async maybeShowSandboxStartupWarning(): Promise<void> {
		const sandboxManager = this.session.sandboxManager;
		if (!sandboxManager) return;
		const config = sandboxManager.getSandboxConfig();
		if (!config.enabled) return;
		const availability = await sandboxManager.getAvailability();
		if (availability.available) return;
		const parts = [`Sandbox unavailable: ${availability.reason ?? "unknown reason"}`];
		if (availability.installHint) parts.push(availability.installHint);
		this.showWarning(parts.join(" "));
	}

	private async handleSandboxCommand(arg?: string): Promise<void> {
		const sandboxManager = this.session.sandboxManager;
		if (!sandboxManager) {
			this.showWarning("Sandbox manager is not available in this session.");
			return;
		}
		const normalized = arg?.trim().toLowerCase();
		if (normalized === "on" || normalized === "enable") {
			this.settingsManager.setSandboxEnabled(true);
			await this.refreshSandboxFooterStatus();
			this.showStatus("Sandbox: enabled");
			return;
		}
		if (normalized === "off" || normalized === "disable") {
			this.settingsManager.setSandboxEnabled(false);
			await this.refreshSandboxFooterStatus();
			this.showStatus("Sandbox: disabled");
			return;
		}
		if (normalized === "network-on" || normalized === "network-allow") {
			this.settingsManager.setSandboxNetworkMode("allow");
			this.showStatus("Sandbox network: allow");
			return;
		}
		if (normalized === "network-off" || normalized === "network-deny") {
			this.settingsManager.setSandboxNetworkMode("deny");
			this.showStatus("Sandbox network: deny");
			return;
		}
		if (normalized === "network-ask") {
			this.settingsManager.setSandboxNetworkMode("ask");
			this.showStatus("Sandbox network: ask");
			return;
		}
		const availability = await sandboxManager.getAvailability();
		const config = sandboxManager.getSandboxConfig();
		const policy = sandboxManager.getSandboxPolicy();
		const lines = [
			`${theme.bold("Sandbox")}`,
			`${theme.fg("dim", "Enabled:")} ${config.enabled ? "yes" : "no"}`,
			`${theme.fg("dim", "Policy:")} ${policy}`,
			`${theme.fg("dim", "Available:")} ${availability.available ? "yes" : "no"}`,
			`${theme.fg("dim", "Active for bash:")} ${config.enabled && availability.available && policy !== "none" ? "yes" : "no"}`,
			`${theme.fg("dim", "Network mode:")} ${config.networkMode}`,
			`${theme.fg("dim", "Network default:")} ${config.networkEnabled ? "enabled" : "blocked unless approved"}`,
			availability.version ? `${theme.fg("dim", "Version:")} ${availability.version}` : "",
			availability.reason ? `${theme.fg("dim", "Reason:")} ${availability.reason}` : "",
			availability.installHint ? `${theme.fg("dim", "Install hint:")} ${availability.installHint}` : "",
			`${theme.fg("dim", "Usage:")} /sandbox on | off | network-allow | network-ask | network-deny`,
		].filter(Boolean);
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(lines.join("\n"), 1, 0));
		this.ui.requestRender();
	}

	private cyclePermissionMode(): void {
		const modes: PermissionMode[] = ["danger-full-access", "accept-on-edit", "auto", "plan"];
		const current = getPermissionMode();
		const idx = modes.indexOf(current);
		const next = modes[(idx + 1) % modes.length];
		setPermissionMode(next);
		this.settingsManager.setPermissionMode(next);
		process.env.LUCENT_CODE_PERMISSION_MODE = next;
		this.footer.setPermissionMode(next);
		this.showStatus(`Permission mode: ${next}`);
		void this.refreshSandboxFooterStatus();
		this.ui.requestRender();
	}

	private async runSetupWizard(): Promise<void> {
		if (!this.options.runSetupWizard) {
			this.showWarning("Setup wizard is not available in this host. Use the app's config command instead.");
			return;
		}

		let wizardError: unknown = undefined;
		this.ui.stop();
		try {
			await this.options.runSetupWizard();
		} catch (error) {
			wizardError = error;
		} finally {
			resetStdinForTui();

			this.ui.start();
			this.updateTerminalTitle();
			await this.updateAvailableProviderCount();
			this.footer.invalidate();
			this.ui.requestRender(true);
		}

		if (wizardError) {
			const message = wizardError instanceof Error ? wizardError.message : String(wizardError);
			this.showWarning(`Configuration wizard failed: ${message}`);
		}
	}

	private addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(
					message.command,
					this.ui,
					message.excludeFromContext,
					this.settingsManager.getToolOutputMode(),
					false, // history items: don't show RTK badge (state unknown at record time)
					message.sandboxed ?? false,
				);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
					message.sandboxed,
				);
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "custom": {
				if (message.display) {
					const renderer = this.session.extensionRunner?.getMessageRenderer(message.customType);
					const component = new CustomMessageComponent(message, renderer, this.getMarkdownThemeWithSettings());
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "user": {
				const textContent = this.getUserMessageText(message);
				if (textContent && !this.session.isHiddenSteeringMessage(textContent)) {
					const skillBlock = parseSkillBlock(textContent);
					if (skillBlock) {
						// Render skill block (collapsible)
						this.chatContainer.addChild(new Spacer(1));
						const component = new SkillInvocationMessageComponent(
							skillBlock,
							this.getMarkdownThemeWithSettings(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						// Render user message separately if present
						if (skillBlock.userMessage) {
							const userComponent = new UserMessageComponent(
								skillBlock.userMessage,
								this.getMarkdownThemeWithSettings(),
								message.timestamp,
								this.settingsManager.getTimestampFormat(),
							);
							this.chatContainer.addChild(userComponent);
						}
					} else {
						const userComponent = new UserMessageComponent(textContent, this.getMarkdownThemeWithSettings(), message.timestamp, this.settingsManager.getTimestampFormat());
						this.chatContainer.addChild(userComponent);
					}
					if (options?.populateHistory) {
						this.editor.addToHistory?.(textContent);
					}
				}
				break;
			}
			case "assistant": {
				const assistantComponent = new AssistantMessageComponent(
					message,
					this.hideThinkingBlock,
					this.getMarkdownThemeWithSettings(),
					this.settingsManager.getTimestampFormat(),
					this.session.thinkingLevel || "off",
				);
				this.chatContainer.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				// Tool results are rendered inline with tool calls, handled separately
				break;
			}
			default: {
				const _exhaustive: never = message;
			}
		}
	}

	/**
	 * Render session context to chat. Used for initial load and rebuild after compaction.
	 * @param sessionContext Session context to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 */
	private renderSessionContext(
		sessionContext: SessionContext,
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		this.pendingTools.clear();

		if (options.updateFooter) {
			this.footer.invalidate();
			this.updateEditorBorderColor();
		}

		for (const message of sessionContext.messages) {
			// Assistant messages need special handling for tool calls
			if (message.role === "assistant") {
				this.addMessageToChat(message);
				// Render tool call components
				for (const content of message.content) {
					if (content.type === "toolCall") {
						const component = new ToolExecutionComponent(
							content.name,
							content.arguments,
							{
								showImages: this.settingsManager.getShowImages(),
								renderMode: this.settingsManager.getToolOutputMode(),
								editorScheme: this.settingsManager.getEditorScheme(),
							},
							this.getRegisteredToolDefinition(content.name),
							this.ui,
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);

						if (message.stopReason === "aborted" || message.stopReason === "error") {
							let errorMessage: string;
							if (message.stopReason === "aborted") {
								const retryAttempt = this.session.retryAttempt;
								errorMessage =
									retryAttempt > 0
										? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
										: "Operation aborted";
							} else {
								errorMessage = message.errorMessage || "Error";
							}
							component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
						} else {
							this.pendingTools.set(content.id, component);
						}
					} else if (content.type === "serverToolUse") {
						// Server-side tool (e.g., native web search)
						const component = new ToolExecutionComponent(
							content.name,
							content.input ?? {},
							{
								showImages: this.settingsManager.getShowImages(),
								renderMode: this.settingsManager.getToolOutputMode(),
								editorScheme: this.settingsManager.getEditorScheme(),
							},
							undefined,
							this.ui,
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						// Find matching webSearchResult in this message's content
						const resultBlock = message.content.find(
							(c) => c.type === "webSearchResult" && c.toolUseId === content.id,
						);
						if (resultBlock && resultBlock.type === "webSearchResult") {
							const searchContent = resultBlock.content;
							const isError = searchContent && typeof searchContent === "object" && "type" in (searchContent as any) && (searchContent as any).type === "web_search_tool_result_error";
							const resultText = this.formatWebSearchResult(searchContent);
							component.updateResult({
								content: [{ type: "text", text: resultText }],
								isError: !!isError,
							});
						} else {
							// No result yet (aborted stream?) - show as pending
							this.pendingTools.set(content.id, component);
						}
					}
				}
			} else if (message.role === "toolResult") {
				// Match tool results to pending tool components
				const component = this.pendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					this.pendingTools.delete(message.toolCallId);
				}
			} else {
				// All other messages use standard rendering
				this.addMessageToChat(message, options);
			}
		}

		this.pendingTools.clear();
		this.ui.requestRender();
	}

	renderInitialMessages(): void {
		// Get aligned messages and entries from session context
		const context = this.sessionManager.buildSessionContext();
		this.renderSessionContext(context, {
			updateFooter: true,
			populateHistory: true,
		});

		// Show compaction info if session was compacted
		const allEntries = this.sessionManager.getEntries();
		const compactionCount = allEntries.filter((e) => e.type === "compaction").length;
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
			this.showStatus(`Session compacted ${times}`);
		}
	}

	async getUserInput(): Promise<string> {
		return new Promise((resolve) => {
			this.onInputCallback = (text: string) => {
				this.onInputCallback = undefined;
				resolve(text);
			};
		});
	}

	private rebuildChatFromMessages(): void {
		this.chatContainer.clear();
		const context = this.sessionManager.buildSessionContext();
		this.renderSessionContext(context);
	}

	// =========================================================================
	// Key handlers
	// =========================================================================

	private handleCtrlC(): void {
		const now = Date.now();
		if (now - this.lastSigintTime < 500) {
			void this.shutdown();
		} else {
			this.clearEditor();
			this.lastSigintTime = now;
		}
	}

	private handleCtrlD(): void {
		// Only called when editor is empty (enforced by CustomEditor)
		void this.shutdown();
	}

	/**
	 * Gracefully shutdown the agent.
	 * Emits shutdown event to extensions, then exits.
	 */
	private isShuttingDown = false;

	private async shutdown(): Promise<void> {
		const shutdownBehavior = this.options.shutdownBehavior ?? "exit_process";
		if (shutdownBehavior === "ignore") {
			this.showStatus("Quit is unavailable in the browser-attached terminal");
			return;
		}

		if (this.isShuttingDown) return;
		this.isShuttingDown = true;

		// Flush any queued settings writes before shutdown
		await this.settingsManager.flush();

		// Emit shutdown event to extensions
		const extensionRunner = this.session.extensionRunner;
		if (extensionRunner?.hasHandlers("session_shutdown")) {
			await extensionRunner.emit({
				type: "session_shutdown",
			});
		}

		// Wait for any pending renders to complete
		// requestRender() uses process.nextTick(), so we wait one tick
		await new Promise((resolve) => process.nextTick(resolve));

		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		await this.ui.terminal.drainInput(1000);

		this.stop();
		if (shutdownBehavior === "stop_ui") {
			return;
		}
		process.exit(0);
	}

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 */
	private async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	private handleCtrlZ(): void {
		// On Windows, SIGTSTP doesn't exist - Ctrl+Z is not supported
		if (process.platform === "win32") {
			return;
		}

		// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
		// kill the backgrounded process. The handler is removed on resume.
		const ignoreSigint = () => {};
		process.on("SIGINT", ignoreSigint);

		try {
			// Set up handler to restore TUI when resumed
			process.once("SIGCONT", () => {
				process.removeListener("SIGINT", ignoreSigint);
				this.ui.start();
				this.ui.requestRender(true);
			});

			// Stop the TUI (restore terminal to normal mode)
			this.ui.stop();

			// Send SIGTSTP to process group (pid=0 means all processes in group)
			process.kill(0, "SIGTSTP");
		} catch {
			// If suspend fails (e.g. SIGTSTP not supported), ensure the
			// SIGINT listener doesn't leak.
			process.removeListener("SIGINT", ignoreSigint);
		}
	}

	private async handleFollowUp(): Promise<void> {
		const text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
		if (!text) return;

		// Queue input during compaction (extension commands execute immediately)
		if (this.session.isCompacting) {
			if (this.isExtensionCommand(text)) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				await this.session.prompt(text);
			} else {
				this.queueCompactionMessage(text, "followUp");
			}
			return;
		}

		// Alt+Enter queues a follow-up message (waits until agent finishes)
		// This handles extension commands (execute immediately), prompt template expansion, and queueing
		if (this.session.isStreaming) {
			this.editor.addToHistory?.(text);
			this.editor.setText("");
			await this.session.prompt(text, { streamingBehavior: "followUp" });
			this.updatePendingMessagesDisplay();
			this.ui.requestRender();
		}
		// If not streaming, Alt+Enter acts like regular Enter (trigger onSubmit)
		else if (this.editor.onSubmit) {
			this.editor.onSubmit(text);
		}
	}

	private handleDequeue(): void {
		const restored = this.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			this.showStatus("No queued messages to restore");
		} else {
			this.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	private updateEditorBorderColor(): void {
		if (this.isBashMode) {
			this.editor.borderColor = theme.getBashModeBorderColor();
		} else {
			const level = this.session.thinkingLevel || "off";
			this.editor.borderColor = theme.getThinkingBorderColor(level);
		}
		this.ui.requestRender();
	}

	private cycleThinkingLevel(): void {
		const newLevel = this.session.cycleThinkingLevel();
		if (newLevel === undefined) {
			this.showStatus("Current model does not support thinking");
		} else {
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(`Thinking level: ${newLevel}`);
		}
	}

	private async cycleModel(direction: "forward" | "backward"): Promise<void> {
		try {
			const result = await this.session.cycleModel(direction);
			if (result === undefined) {
				const msg = this.session.scopedModels.length > 0 ? "Only one model in scope" : "Only one model available";
				this.showStatus(msg);
			} else {
				this.footer.invalidate();
				this.updateEditorBorderColor();
				const thinkingStr =
					result.model.reasoning && result.thinkingLevel !== "off" ? ` (thinking: ${result.thinkingLevel})` : "";
				this.showStatus(`Switched to ${result.model.name || result.model.id}${thinkingStr}`);
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private toggleToolOutputExpansion(): void {
		this.setToolsExpanded(!this.toolOutputExpanded);
	}

	private setToolsExpanded(expanded: boolean): void {
		this.toolOutputExpanded = expanded;
		for (const child of this.chatContainer.children) {
			if (isExpandable(child)) {
				child.setExpanded(expanded);
			}
		}
		if (this.bashComponent) {
			this.bashComponent.setExpanded(expanded);
		}
		for (const component of this.pendingBashComponents) {
			component.setExpanded(expanded);
		}
		this.updateEditorExpandHint();
		this.ui.requestRender();
	}

	/** Append/remove the "ctrl+o to expand" hint in the editor bottom border. */
	updateEditorExpandHint(): void {
		const expandKey = appKey(this.keybindings, "expandTools");
		const collapseHint = `${theme.fg("dim", expandKey)}${theme.fg("muted", " collapse")}`;
		const expandHint = `${theme.fg("dim", expandKey)}${theme.fg("muted", " : verbose")}`;
		// The base hint set during agent_start
		const enterKey = theme.fg("dim", "↵");
		const followUpKey = theme.fg("dim", appKey(this.keybindings, "followUp"));
		const steerLabel = theme.fg("muted", " steer");
		const queueLabel = theme.fg("muted", " queue");
		const baseHint = `${enterKey}${steerLabel}  ${followUpKey}${queueLabel}`;

		// Check if there are any expandable tool outputs in the chat
		const hasToolOutputs =
			this.chatContainer.children.some(isExpandable) ||
			!!this.bashComponent ||
			this.pendingBashComponents.length > 0;

		const activeHint = this.toolOutputExpanded ? collapseHint : expandHint;

		if (this.loadingAnimation) {
			// Agent is running - always show expand/collapse hint when there are tool outputs
			this.defaultEditor.bottomHint = hasToolOutputs
				? `${baseHint}  ${activeHint}`
				: baseHint;
		} else if (hasToolOutputs) {
			// Idle - show expand/collapse hint so user knows ctrl+o works
			this.defaultEditor.bottomHint = activeHint;
		}
		// If no tool outputs and idle, leave bottomHint as-is (cleared by agent_end)
	}

	private toggleThinkingBlockVisibility(): void {
		this.hideThinkingBlock = !this.hideThinkingBlock;
		this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);

		// Rebuild chat from session messages
		this.chatContainer.clear();
		this.rebuildChatFromMessages();

		// If streaming, re-add the streaming component with updated visibility and re-render
		if (this.streamingComponent && this.streamingMessage) {
			this.streamingComponent.setHideThinkingBlock(this.hideThinkingBlock);
			this.streamingComponent.updateContent(this.streamingMessage);
			this.chatContainer.addChild(this.streamingComponent);
		}

		this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	private openExternalEditor(): void {
		// Determine editor (respect $VISUAL, then $EDITOR)
		const editorCmd = process.env.VISUAL || process.env.EDITOR;
		if (!editorCmd) {
			let msg = "No editor configured. Set $VISUAL or $EDITOR environment variable.";
			if (process.env.TERM_PROGRAM === "iTerm.app") {
				msg +=
					"\n\nTip: If you meant to open the GSD dashboard (Ctrl+Alt+G), set Left Option Key to" +
					" \"Esc+\" in iTerm2 → Profiles → Keys. With the default \"Normal\" setting," +
					" Ctrl+Alt+G sends Ctrl+G instead.";
			}
			this.showWarning(msg);
			return;
		}

		const currentText = this.editor.getExpandedText?.() ?? this.editor.getText();
		const tmpFile = path.join(os.tmpdir(), `pi-editor-${Date.now()}.pi.md`);

		try {
			// Write current content to temp file
			fs.writeFileSync(tmpFile, currentText, "utf-8");

			// Stop TUI to release terminal
			this.ui.stop();

			// Split by space to support editor arguments (e.g., "code --wait")
			const [editor, ...editorArgs] = editorCmd.split(" ");

			// Spawn editor synchronously with inherited stdio for interactive editing
			const result = spawnSync(editor, [...editorArgs, tmpFile], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});

			// On successful exit (status 0), replace editor content
			if (result.status === 0) {
				const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
				this.editor.setText(newContent);
			}
			// On non-zero exit, keep original text (no action needed)
		} finally {
			// Clean up temp file
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}

			// Restart TUI
			this.ui.start();
			// Force full re-render since external editor uses alternate screen
			this.ui.requestRender(true);
		}
	}

	// =========================================================================
	// UI helpers
	// =========================================================================

	clearEditor(): void {
		this.editor.setText("");
		this.ui.requestRender();
	}

	showError(errorMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0));
		this.ui.requestRender();
	}

	showWarning(warningMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("warning", `Warning: ${warningMessage}`), 1, 0));
		this.ui.requestRender();
	}

	showNewVersionNotification(newVersion: string): void {
		const action = theme.fg("accent", getUpdateInstruction("@gsd/pi-coding-agent"));
		const updateInstruction = theme.fg("muted", `New version ${newVersion} is available. `) + action;
		const changelogUrl = theme.fg(
			"accent",
			"https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md",
		);
		const changelogLine = theme.fg("muted", "Changelog: ") + changelogUrl;

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new Text(
				`${theme.bold(theme.fg("warning", "Update Available"))}\n${updateInstruction}\n${changelogLine}`,
				1,
				0,
			),
		);
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.ui.requestRender();
	}

	/**
	 * Get all queued messages (read-only).
	 * Combines session queue and compaction queue.
	 */
	private getAllQueuedMessages(): { steering: string[]; followUp: string[] } {
		return {
			steering: [
				...this.session.getSteeringMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text),
			],
			followUp: [
				...this.session.getFollowUpMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "followUp").map((msg) => msg.text),
			],
		};
	}

	/**
	 * Clear all queued messages and return their contents.
	 * Clears both session queue and compaction queue.
	 */
	private clearAllQueues(): { steering: string[]; followUp: string[] } {
		const { steering, followUp } = this.session.clearQueue();
		const compactionSteering = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "steer")
			.map((msg) => msg.text);
		const compactionFollowUp = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "followUp")
			.map((msg) => msg.text);
		this.compactionQueuedMessages = [];
		return {
			steering: [...steering, ...compactionSteering],
			followUp: [...followUp, ...compactionFollowUp],
		};
	}

	private updatePendingMessagesDisplay(): void {
		this.pendingMessagesContainer.clear();
		const { steering: steeringMessages, followUp: followUpMessages } = this.getAllQueuedMessages();
		if (steeringMessages.length > 0 || followUpMessages.length > 0) {
			this.pendingMessagesContainer.addChild(new Spacer(1));
			for (const message of steeringMessages) {
				const text = theme.fg("dim", `Steering: ${message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			for (const message of followUpMessages) {
				const text = theme.fg("dim", `Follow-up: ${message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			const dequeueHint = getAppKeyDisplay(this.keybindings, "dequeue");
			const hintText = theme.fg("dim", `↳ ${dequeueHint} to edit all queued messages`);
			this.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
		}
	}

	private restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		const { steering, followUp } = this.clearAllQueues();
		const allQueued = [...steering, ...followUp];
		if (allQueued.length === 0) {
			this.updatePendingMessagesDisplay();
			if (options?.abort) {
				this.agent.abort();
			}
			return 0;
		}
		const queuedText = allQueued.join("\n\n");
		const currentText = options?.currentText ?? this.editor.getText();
		const combinedText = [queuedText, currentText].filter((t) => t.trim()).join("\n\n");
		this.editor.setText(combinedText);
		this.updatePendingMessagesDisplay();
		if (options?.abort) {
			this.agent.abort();
		}
		return allQueued.length;
	}

	private queueCompactionMessage(text: string, mode: "steer" | "followUp"): void {
		this.compactionQueuedMessages.push({ text, mode });
		this.editor.addToHistory?.(text);
		this.editor.setText("");
		this.updatePendingMessagesDisplay();
		this.showStatus("Queued message for after compaction");
	}

	private isExtensionCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;

		const extensionRunner = this.session.extensionRunner;
		if (!extensionRunner) return false;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		return !!extensionRunner.getCommand(commandName);
	}

	private async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		if (this.compactionQueuedMessages.length === 0) {
			return;
		}

		const queuedMessages = [...this.compactionQueuedMessages];
		this.compactionQueuedMessages = [];
		this.updatePendingMessagesDisplay();

		const restoreQueue = (error: unknown) => {
			this.session.clearQueue();
			this.compactionQueuedMessages = queuedMessages;
			this.updatePendingMessagesDisplay();
			this.showError(
				`Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		};

		try {
			if (options?.willRetry) {
				// When retry is pending, queue messages for the retry turn
				for (const message of queuedMessages) {
					if (this.isExtensionCommand(message.text)) {
						await this.session.prompt(message.text);
					} else if (message.mode === "followUp") {
						await this.session.followUp(message.text);
					} else {
						await this.session.steer(message.text);
					}
				}
				this.updatePendingMessagesDisplay();
				return;
			}

			// Find first non-extension-command message to use as prompt
			const firstPromptIndex = queuedMessages.findIndex((message) => !this.isExtensionCommand(message.text));
			if (firstPromptIndex === -1) {
				// All extension commands - execute them all
				for (const message of queuedMessages) {
					await this.session.prompt(message.text);
				}
				return;
			}

			// Execute any extension commands before the first prompt
			const preCommands = queuedMessages.slice(0, firstPromptIndex);
			const firstPrompt = queuedMessages[firstPromptIndex];
			const rest = queuedMessages.slice(firstPromptIndex + 1);

			for (const message of preCommands) {
				await this.session.prompt(message.text);
			}

			// Send first prompt (starts streaming)
			const promptPromise = this.session.prompt(firstPrompt.text).catch((error) => {
				restoreQueue(error);
			});

			// Queue remaining messages
			for (const message of rest) {
				if (this.isExtensionCommand(message.text)) {
					await this.session.prompt(message.text);
				} else if (message.mode === "followUp") {
					await this.session.followUp(message.text);
				} else {
					await this.session.steer(message.text);
				}
			}
			this.updatePendingMessagesDisplay();
			void promptPromise;
		} catch (error) {
			restoreQueue(error);
		}
	}

	/** Move pending bash components from pending area to chat */
	private flushPendingBashComponents(): void {
		for (const component of this.pendingBashComponents) {
			this.pendingMessagesContainer.removeChild(component);
			this.chatContainer.addChild(component);
		}
		this.pendingBashComponents = [];
	}

	// =========================================================================
	// Selectors
	// =========================================================================

	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	private showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		const done = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
		};
		const { component, focus } = create(done);
		this.editorContainer.clear();
		this.editorContainer.addChild(component);
		this.ui.setFocus(focus);
		this.ui.requestRender();
	}

	private showSettingsSelector(): void {
		this.showSelector((done) => {
			const savedDefaultProvider = this.settingsManager.getDefaultProvider();
			const savedDefaultModel = this.settingsManager.getDefaultModel();
			const currentModelRef = this.session.model
				? `${this.session.model.provider}/${this.session.model.id}`
				: "not set";
			const defaultModelRef = savedDefaultProvider && savedDefaultModel
				? `${savedDefaultProvider}/${savedDefaultModel}`
				: currentModelRef;

			const selector = new SettingsSelectorComponent(
				{
					autoCompact: this.session.autoCompactionEnabled,
					autoCompactThresholdPercent: this.settingsManager.getCompactionThresholdPercent(),
					defaultModel: defaultModelRef,
					classifierModel: this.settingsManager.getClassifierModel() ?? "default",
					adaptiveClassifierModel: this.settingsManager.getAdaptiveClassifierModel() ?? "default",
					budgetSubagentModel: this.settingsManager.getBudgetSubagentModel() ?? "default",
					planModeReasoningModel: this.settingsManager.getPlanModeReasoningModel() ?? "default",
					planModeReviewModel: this.settingsManager.getPlanModeReviewModel() ?? "default",
					planModeCodingModel: this.settingsManager.getPlanModeCodingModel() ?? "default",
					autoSuggestPlanMode: this.settingsManager.getAutoSuggestPlanMode(),
					autoSwitchPlanModel: this.settingsManager.getAutoSwitchPlanModel(),
					showImages: this.settingsManager.getShowImages(),
					autoResizeImages: this.settingsManager.getImageAutoResize(),
					blockImages: this.settingsManager.getBlockImages(),
					enableSkillCommands: this.settingsManager.getEnableSkillCommands(),
					toolProfile: this.settingsManager.getToolProfile(),
					codexRotate: this.settingsManager.getCodexRotate(),
					cacheTimer: this.settingsManager.getCacheTimer(),
					pinLastPrompt: this.settingsManager.getPinLastPrompt(),
					steeringMode: this.session.steeringMode,
					followUpMode: this.session.followUpMode,
					transport: this.settingsManager.getTransport(),
					thinkingLevel: this.session.thinkingLevel,
					anthropicAdaptiveByDefault: this.settingsManager.getAnthropicAdaptiveByDefault(),
					clientAdaptiveByDefault: this.settingsManager.getClientAdaptiveByDefault(),
					availableThinkingLevels: this.session.getAvailableThinkingLevels(),
					currentTheme: this.settingsManager.getTheme() || "dark",
					currentThemeAccent: this.settingsManager.getThemeAccent() || "default",
					availableThemes: getAvailableThemes(),
					availableThemeAccents: getAvailableThemeAccents(),
					hideThinkingBlock: this.hideThinkingBlock,
					collapseChangelog: this.settingsManager.getCollapseChangelog(),
					doubleEscapeAction: this.settingsManager.getDoubleEscapeAction(),
					treeFilterMode: this.settingsManager.getTreeFilterMode(),
					showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
					editorPaddingX: this.settingsManager.getEditorPaddingX(),
					autocompleteMaxVisible: this.settingsManager.getAutocompleteMaxVisible(),
					respectGitignoreInPicker: this.settingsManager.getRespectGitignoreInPicker(),
					quietStartup: this.settingsManager.getQuietStartup(),
					clearOnShrink: this.settingsManager.getClearOnShrink(),
					timestampFormat: this.settingsManager.getTimestampFormat(),
					toolOutputMode: this.settingsManager.getToolOutputMode(),
					rtk: this.settingsManager.getRtk(),
					editorScheme: this.settingsManager.getEditorScheme(),
					autoDream: this.settingsManager.getAutoDream(),
					autoMemory: this.settingsManager.getAutoMemory(),
					telegramLiveRelayAutoConnect: this.settingsManager.getTelegramLiveRelayAutoConnect(),
					sandboxEnabled: this.settingsManager.getSandboxSettings().enabled ?? true,
					sandboxNetworkMode: this.settingsManager.getSandboxSettings().networkMode
						?? (this.settingsManager.getSandboxSettings().networkEnabled === true ? "allow" : this.settingsManager.getSandboxSettings().networkEnabled === false ? "deny" : "ask"),
					defaultModelSubmenu: (_currentValue, submenuDone) =>
						new ModelSelectorComponent(
							this.ui,
							undefined,
							this.settingsManager,
							this.session.modelRegistry,
							[],
							(model) => submenuDone(`${model.provider}/${model.id}`),
							() => submenuDone(),
						),
					classifierModelSubmenu: (_currentValue, submenuDone) =>
						new ModelSelectorComponent(
							this.ui,
							undefined,
							this.settingsManager,
							this.session.modelRegistry,
							[],
							(model) => submenuDone(`${model.provider}/${model.id}`),
							() => submenuDone(),
						),
					adaptiveClassifierModelSubmenu: (_currentValue, submenuDone) =>
						new ModelSelectorComponent(
							this.ui,
							undefined,
							this.settingsManager,
							this.session.modelRegistry,
							[],
							(model) => submenuDone(`${model.provider}/${model.id}`),
							() => submenuDone(),
						),
					budgetSubagentModelSubmenu: (_currentValue, submenuDone) =>
						new ModelSelectorComponent(
							this.ui,
							undefined,
							this.settingsManager,
							this.session.modelRegistry,
							[],
							(model) => submenuDone(`${model.provider}/${model.id}`),
							() => submenuDone(),
						),
					planModeReasoningModelSubmenu: (_currentValue, submenuDone) =>
						new ModelSelectorComponent(
							this.ui,
							undefined,
							this.settingsManager,
							this.session.modelRegistry,
							[],
							(model) => submenuDone(`${model.provider}/${model.id}`),
							() => submenuDone(),
						),
					planModeReviewModelSubmenu: (_currentValue, submenuDone) =>
						new ModelSelectorComponent(
							this.ui,
							undefined,
							this.settingsManager,
							this.session.modelRegistry,
							[],
							(model) => submenuDone(`${model.provider}/${model.id}`),
							() => submenuDone(),
						),
					planModeCodingModelSubmenu: (_currentValue, submenuDone) =>
						new ModelSelectorComponent(
							this.ui,
							undefined,
							this.settingsManager,
							this.session.modelRegistry,
							[],
							(model) => submenuDone(`${model.provider}/${model.id}`),
							() => submenuDone(),
						),
				},
				{
					onAutoCompactChange: (enabled) => {
						this.session.setAutoCompactionEnabled(enabled);
						this.footer.setAutoCompactEnabled(enabled);
					},
					onAutoCompactThresholdPercentChange: (percent) => {
						this.settingsManager.setCompactionThresholdPercent(percent);
						this.showStatus(`Auto-compact threshold: ${percent}%`);
					},
					onDefaultModelChange: (modelRef) => {
						const slashIdx = modelRef.indexOf("/");
						if (slashIdx <= 0 || slashIdx === modelRef.length - 1) {
							this.showError(`Invalid startup model: ${modelRef}`);
							return;
						}
						const provider = modelRef.slice(0, slashIdx);
						const modelId = modelRef.slice(slashIdx + 1);
						this.settingsManager.setDefaultModelAndProvider(provider, modelId);
						this.showStatus(`Default model: ${modelRef}`);
					},
					onClassifierModelChange: (modelRef) => {
						this.settingsManager.setClassifierModel(modelRef);
						this.showStatus(`Classifier model: ${modelRef}`);
					},
					onAdaptiveClassifierModelChange: (modelRef) => {
						this.settingsManager.setAdaptiveClassifierModel(modelRef === "default" ? undefined : modelRef);
						// Live-update the agent so the change takes effect immediately
						const parts = modelRef && modelRef !== "default" ? modelRef.split("/") : [];
						const resolved = parts.length === 2
							? this.session.modelRegistry.find(parts[0]!, parts[1]!) ?? undefined
							: undefined;
						this.session.agent.setAdaptiveClassifierModel(resolved);
						this.showStatus(`Adaptive classifier model: ${modelRef === "default" ? "heuristic (default)" : modelRef}`);
					},
					onBudgetSubagentModelChange: (modelRef) => {
						this.settingsManager.setBudgetSubagentModel(modelRef === "default" ? undefined : modelRef);
						this.showStatus(
							`Budget subagent model: ${modelRef === "default" ? "use current/default model" : modelRef}`,
						);
					},
					onPlanModeReasoningModelChange: (modelRef) => {
						this.settingsManager.setPlanModeReasoningModel(modelRef === "default" ? undefined : modelRef);
						this.showStatus(
							`Plan reasoning model: ${modelRef === "default" ? "use current model" : modelRef}`,
						);
					},
					onPlanModeReviewModelChange: (modelRef) => {
						this.settingsManager.setPlanModeReviewModel(modelRef === "default" ? undefined : modelRef);
						this.showStatus(
							`Plan review model: ${modelRef === "default" ? "use current/default model" : modelRef}`,
						);
					},
					onPlanModeCodingModelChange: (modelRef) => {
						this.settingsManager.setPlanModeCodingModel(modelRef === "default" ? undefined : modelRef);
						this.showStatus(
							`Plan coding model: ${modelRef === "default" ? "use current/default model" : modelRef}`,
						);
					},
					onAutoSuggestPlanModeChange: (enabled) => {
						this.settingsManager.setAutoSuggestPlanMode(enabled);
						this.showStatus(`Auto-suggest plan mode: ${enabled ? "enabled" : "disabled"}`);
					},
					onAutoSwitchPlanModelChange: (enabled) => {
						this.settingsManager.setAutoSwitchPlanModel(enabled);
						this.showStatus(`OpusPlan mode: ${enabled ? "enabled" : "disabled"}`);
					},
					onShowImagesChange: (enabled) => {
						this.settingsManager.setShowImages(enabled);
						for (const child of this.chatContainer.children) {
							if (child instanceof ToolExecutionComponent) {
								child.setShowImages(enabled);
							}
						}
					},
					onAutoResizeImagesChange: (enabled) => {
						this.settingsManager.setImageAutoResize(enabled);
					},
					onBlockImagesChange: (blocked) => {
						this.settingsManager.setBlockImages(blocked);
					},
					onEnableSkillCommandsChange: (enabled) => {
						this.settingsManager.setEnableSkillCommands(enabled);
						this.setupAutocomplete();
					},
					onToolProfileChange: (profile) => {
						this.settingsManager.setToolProfile(profile);
						const allToolNames = this.session.getAllTools().map((tool) => tool.name);
						const nextActiveToolNames = getToolNamesForProfile(profile, this.session.editMode, allToolNames);
						this.session.setActiveToolsByName(nextActiveToolNames);
						this.showStatus(`Tool profile: ${profile}`);
					},
					onCodexRotateChange: (enabled) => {
						this.settingsManager.setCodexRotate(enabled);
						this.showStatus(`Codex rotate: ${enabled ? "enabled" : "disabled"} (restart required)`);
					},
					onCacheTimerChange: (enabled) => {
						this.settingsManager.setCacheTimer(enabled);
						this.showStatus(`Cache timer: ${enabled ? "enabled" : "disabled"}`);
					},
					onPinLastPromptChange: (enabled) => {
						this.settingsManager.setPinLastPrompt(enabled);
						this.pinLastPromptEnabled = enabled;
						this.updatePinLastPromptWidget();
						this.showStatus(`Pin last prompt: ${enabled ? "enabled" : "disabled"}`);
					},
					onRtkChange: (enabled) => {
						this.settingsManager.setRtk(enabled);
						this.showStatus(`RTK: ${enabled ? "enabled" : "disabled"} (restart required)`);
					},
					onAutoDreamChange: (enabled) => {
						this.settingsManager.setAutoDream(enabled);
						this.showStatus(`Auto dream: ${enabled ? "enabled" : "disabled"}`);
					},
					onAutoMemoryChange: (enabled) => {
						this.settingsManager.setAutoMemory(enabled);
						this.showStatus(`Auto memory: ${enabled ? "enabled" : "disabled"}`);
					},
					onTelegramLiveRelayAutoConnectChange: (enabled) => {
						this.settingsManager.setTelegramLiveRelayAutoConnect(enabled);
						this.showStatus(`Telegram autoconnect: ${enabled ? "enabled" : "disabled"}`);
					},
					onSteeringModeChange: (mode) => {
						this.session.setSteeringMode(mode);
					},
					onFollowUpModeChange: (mode) => {
						this.session.setFollowUpMode(mode);
					},
					onTransportChange: (transport) => {
						this.settingsManager.setTransport(transport);
						this.session.agent.setTransport(transport);
					},
					onThinkingLevelChange: (level) => {
						this.session.setThinkingLevel(level);
						this.footer.invalidate();
						this.updateEditorBorderColor();
					},
					onAnthropicAdaptiveByDefaultChange: (enabled) => {
						this.settingsManager.setAnthropicAdaptiveByDefault(enabled);
						this.showStatus(`Anthropic adaptive default: ${enabled ? "enabled" : "disabled"}`);
					},
					onClientAdaptiveByDefaultChange: (enabled) => {
						this.settingsManager.setClientAdaptiveByDefault(enabled);
						this.showStatus(`Adaptive default: ${enabled ? "enabled" : "disabled"}`);
					},
					onThemeChange: (themeName) => {
						const result = setTheme(themeName, true, this.settingsManager.getThemeAccent());
						this.settingsManager.setTheme(themeName);
						this.updateEditorBorderColor();
						this.ui.invalidate();
						if (!result.success) {
							this.showError(`Failed to load theme "${themeName}": ${result.error}\nFell back to dark theme.`);
						}
					},
					onThemeAccentChange: (accent) => {
						this.settingsManager.setThemeAccent(accent === "default" ? undefined : accent);
						const result = setTheme(
							this.settingsManager.getTheme() || "dark",
							true,
							this.settingsManager.getThemeAccent(),
						);
						this.updateEditorBorderColor();
						this.ui.invalidate();
						this.ui.requestRender();
						if (!result.success) {
							this.showError(`Failed to apply theme accent "${accent}": ${result.error}`);
						}
					},
					onThemePreview: (themeName) => {
						const result = setTheme(themeName, true, this.settingsManager.getThemeAccent());
						if (result.success) {
							this.updateEditorBorderColor();
							this.ui.invalidate();
							this.ui.requestRender();
						}
					},
					onHideThinkingBlockChange: (hidden) => {
						this.hideThinkingBlock = hidden;
						this.settingsManager.setHideThinkingBlock(hidden);
						for (const child of this.chatContainer.children) {
							if (child instanceof AssistantMessageComponent) {
								child.setHideThinkingBlock(hidden);
							}
						}
						this.chatContainer.clear();
						this.rebuildChatFromMessages();
					},
					onCollapseChangelogChange: (collapsed) => {
						this.settingsManager.setCollapseChangelog(collapsed);
					},
					onQuietStartupChange: (enabled) => {
						this.settingsManager.setQuietStartup(enabled);
					},
					onDoubleEscapeActionChange: (action) => {
						this.settingsManager.setDoubleEscapeAction(action);
					},
					onTreeFilterModeChange: (mode) => {
						this.settingsManager.setTreeFilterMode(mode);
					},
					onShowHardwareCursorChange: (enabled) => {
						this.settingsManager.setShowHardwareCursor(enabled);
						this.ui.setShowHardwareCursor(enabled);
					},
					onEditorPaddingXChange: (padding) => {
						this.settingsManager.setEditorPaddingX(padding);
						this.defaultEditor.setPaddingX(padding);
						if (this.editor !== this.defaultEditor && this.editor.setPaddingX !== undefined) {
							this.editor.setPaddingX(padding);
						}
					},
					onAutocompleteMaxVisibleChange: (maxVisible) => {
						this.settingsManager.setAutocompleteMaxVisible(maxVisible);
						this.defaultEditor.setAutocompleteMaxVisible(maxVisible);
						if (this.editor !== this.defaultEditor && this.editor.setAutocompleteMaxVisible !== undefined) {
							this.editor.setAutocompleteMaxVisible(maxVisible);
						}
					},
					onClearOnShrinkChange: (enabled) => {
						this.settingsManager.setClearOnShrink(enabled);
						this.ui.setClearOnShrink(enabled);
					},
					onRespectGitignoreInPickerChange: (enabled) => {
						this.settingsManager.setRespectGitignoreInPicker(enabled);
						this.autocompleteProvider?.setRespectGitignore(enabled);
					},
					onTimestampFormatChange: (format) => {
						this.settingsManager.setTimestampFormat(format);
					},
					onEditorSchemeChange: (scheme) => {
						this.settingsManager.setEditorScheme(scheme);
						this.showStatus(`Editor link scheme: ${scheme}`);
					},
					onToolOutputModeChange: (mode) => {
						this.settingsManager.setToolOutputMode(mode);
						for (const child of this.chatContainer.children) {
							if (child instanceof ToolExecutionComponent || child instanceof BashExecutionComponent) {
								child.setRenderMode(mode);
							}
						}
						if (this.bashComponent) this.bashComponent.setRenderMode(mode);
						for (const component of this.pendingBashComponents) component.setRenderMode(mode);
						this.ui.requestRender();
					},
					onSandboxEnabledChange: (enabled) => {
						this.settingsManager.setSandboxEnabled(enabled);
						void this.refreshSandboxFooterStatus();
						this.showStatus(`Sandbox: ${enabled ? "enabled" : "disabled"}`);
					},
					onSandboxNetworkModeChange: (mode) => {
						this.settingsManager.setSandboxNetworkMode(mode);
						this.showStatus(`Sandbox network: ${mode}`);
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector.getSettingsList() };
		});
	}

	private async handleModelCommand(searchTerm?: string): Promise<void> {
		await handleModelCommandController(this, searchTerm);
	}

	private async findExactModelMatch(searchTerm: string): Promise<Model<any> | undefined> {
		return findExactModelMatchController(this, searchTerm);
	}

	private async getModelCandidates(): Promise<Model<any>[]> {
		return getModelCandidatesController(this);
	}

	/** Update the footer's available provider count from current model candidates */
	private async updateAvailableProviderCount(): Promise<void> {
		await updateAvailableProviderCountController(this);
	}

	private showModelSelector(initialSearchInput?: string): void {
		this.showSelector((done) => {
			const selector = new ModelSelectorComponent(
				this.ui,
				this.session.model,
				this.settingsManager,
				this.session.modelRegistry,
				this.session.scopedModels,
				async (model) => {
					try {
						await this.session.setModel(model);
						this.footer.invalidate();
						this.updateEditorBorderColor();
						done();
						this.showStatus(`Model: ${model.id}`);
						this.checkDaxnutsEasterEgg(model);
					} catch (error) {
						done();
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSearchInput,
			);
			return { component: selector, focus: selector };
		});
	}

	private async showModelsSelector(): Promise<void> {
		// Get all available models
		this.session.modelRegistry.refresh();
		const allModels = this.session.modelRegistry.getAvailable();

		if (allModels.length === 0) {
			this.showStatus("No models available");
			return;
		}

		// Check if session has scoped models (from previous session-only changes or CLI --models)
		const sessionScopedModels = this.session.scopedModels;
		const hasSessionScope = sessionScopedModels.length > 0;

		// Build enabled model IDs from session state or settings
		const enabledModelIds = new Set<string>();
		let hasFilter = false;

		if (hasSessionScope) {
			// Use current session's scoped models
			for (const sm of sessionScopedModels) {
				enabledModelIds.add(`${sm.model.provider}/${sm.model.id}`);
			}
			hasFilter = true;
		} else {
			// Fall back to settings
			const patterns = this.settingsManager.getEnabledModels();
			if (patterns !== undefined && patterns.length > 0) {
				hasFilter = true;
				const scopedModels = await resolveModelScope(patterns, this.session.modelRegistry);
				for (const sm of scopedModels) {
					enabledModelIds.add(`${sm.model.provider}/${sm.model.id}`);
				}
			}
		}

		// Track current enabled state (session-only until persisted)
		const currentEnabledIds = new Set(enabledModelIds);
		let currentHasFilter = hasFilter;

		// Helper to update session's scoped models (session-only, no persist)
		const updateSessionModels = async (enabledIds: Set<string>) => {
			if (enabledIds.size > 0 && enabledIds.size < allModels.length) {
				const newScopedModels = await resolveModelScope(Array.from(enabledIds), this.session.modelRegistry);
				this.session.setScopedModels(
					newScopedModels.map((sm) => ({
						model: sm.model,
						thinkingLevel: sm.thinkingLevel,
					})),
				);
			} else {
				// All enabled or none enabled = no filter
				this.session.setScopedModels([]);
			}
			await this.updateAvailableProviderCount();
			this.ui.requestRender();
		};

		this.showSelector((done) => {
			const selector = new ScopedModelsSelectorComponent(
				{
					allModels,
					enabledModelIds: currentEnabledIds,
					hasEnabledModelsFilter: currentHasFilter,
				},
				{
					onModelToggle: async (modelId, enabled) => {
						if (enabled) {
							currentEnabledIds.add(modelId);
						} else {
							currentEnabledIds.delete(modelId);
						}
						currentHasFilter = true;
						await updateSessionModels(currentEnabledIds);
					},
					onEnableAll: async (allModelIds) => {
						currentEnabledIds.clear();
						for (const id of allModelIds) {
							currentEnabledIds.add(id);
						}
						currentHasFilter = false;
						await updateSessionModels(currentEnabledIds);
					},
					onClearAll: async () => {
						currentEnabledIds.clear();
						currentHasFilter = true;
						await updateSessionModels(currentEnabledIds);
					},
					onToggleProvider: async (_provider, modelIds, enabled) => {
						for (const id of modelIds) {
							if (enabled) {
								currentEnabledIds.add(id);
							} else {
								currentEnabledIds.delete(id);
							}
						}
						currentHasFilter = true;
						await updateSessionModels(currentEnabledIds);
					},
					onPersist: (enabledIds) => {
						// Persist to settings
						const newPatterns =
							enabledIds.length === allModels.length
								? undefined // All enabled = clear filter
								: enabledIds;
						this.settingsManager.setEnabledModels(newPatterns);
						this.showStatus("Model selection saved to settings");
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private showUserMessageSelector(): void {
		const userMessages = this.session.getUserMessagesForForking();

		if (userMessages.length === 0) {
			this.showStatus("No messages to fork from");
			return;
		}

		this.showSelector((done) => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map((m) => ({ id: m.entryId, text: m.text })),
				async (entryId) => {
					const result = await this.session.fork(entryId);
					if (result.cancelled) {
						// Extension cancelled the fork
						done();
						this.ui.requestRender();
						return;
					}

					this.chatContainer.clear();
					this.renderInitialMessages();
					this.editor.setText(result.selectedText);
					done();
					this.showStatus("Branched to new session");
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	private showTreeSelector(initialSelectedId?: string): void {
		const tree = this.sessionManager.getTree();
		const realLeafId = this.sessionManager.getLeafId();
		const initialFilterMode = this.settingsManager.getTreeFilterMode();

		if (tree.length === 0) {
			this.showStatus("No entries in session");
			return;
		}

		this.showSelector((done) => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ui.terminal.rows,
				async (entryId) => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === realLeafId) {
						done();
						this.showStatus("Already at this point");
						return;
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					let wantsSummary = false;
					let customInstructions: string | undefined;

					// Check if we should skip the prompt (user preference to always default to no summary)
					if (!this.settingsManager.getBranchSummarySkipPrompt()) {
						while (true) {
							const summaryChoice = await this.showExtensionSelector("Summarize branch?", [
								"No summary",
								"Summarize",
								"Summarize with custom prompt",
							]);

							if (summaryChoice === undefined) {
								// User pressed escape - re-show tree selector with same selection
								this.showTreeSelector(entryId);
								return;
							}

							wantsSummary = summaryChoice !== "No summary";

							if (summaryChoice === "Summarize with custom prompt") {
								customInstructions = await this.showExtensionEditor("Custom summarization instructions");
								if (customInstructions === undefined) {
									// User cancelled - loop back to summary selector
									continue;
								}
							}

							// User made a complete choice
							break;
						}
					}

					// Set up escape handler and loader if summarizing
					let summaryLoader: Loader | undefined;
					const originalOnEscape = this.defaultEditor.onEscape;

					if (wantsSummary) {
						this.defaultEditor.onEscape = () => {
							this.session.abortBranchSummary();
						};
						this.chatContainer.addChild(new Spacer(1));
						summaryLoader = new Loader(
							this.ui,
							(spinner) => theme.fg("text", spinner),
							(text) => theme.fg("muted", text),
							`Summarizing branch... (${appKey(this.keybindings, "interrupt")} to cancel)`,
						);
						this.statusContainer.addChild(summaryLoader);
						this.ui.requestRender();
					}

					try {
						const result = await this.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
						});

						if (result.aborted) {
							// Summarization aborted - re-show tree selector with same selection
							this.showStatus("Branch summarization cancelled");
							this.showTreeSelector(entryId);
							return;
						}
						if (result.cancelled) {
							this.showStatus("Navigation cancelled");
							return;
						}

						// Update UI
						this.chatContainer.clear();
						this.renderInitialMessages();
						if (result.editorText && !this.editor.getText().trim()) {
							this.editor.setText(result.editorText);
						}
						this.showStatus("Navigated to selected point");
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (summaryLoader) {
							summaryLoader.stop();
							this.statusContainer.clear();
						}
						this.defaultEditor.onEscape = originalOnEscape;
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				(entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
					this.ui.requestRender();
				},
				initialSelectedId,
				initialFilterMode,
			);
			return { component: selector, focus: selector };
		});
	}

	private showSessionSelector(): void {
		this.showSelector((done) => {
			const selector = new SessionSelectorComponent(
				(onProgress) =>
					SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress),
				SessionManager.listAll,
				async (sessionPath) => {
					done();
					await this.handleResumeSession(sessionPath);
				},
				() => {
					done();
					this.ui.requestRender();
				},
				() => {
					void this.shutdown();
				},
				() => this.ui.requestRender(),
				{
					renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
						const next = (nextName ?? "").trim();
						if (!next) return;
						const mgr = SessionManager.open(sessionFilePath);
						mgr.appendSessionInfo(next);
					},
					showRenameHint: true,
					keybindings: this.keybindings,
				},

				this.sessionManager.getSessionFile(),
			);
			return { component: selector, focus: selector };
		});
	}

	private async handleResumeSession(sessionPath: string): Promise<void> {
		// Stop loading animation
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();

		// Clear UI state
		this.pendingMessagesContainer.clear();
		this.compactionQueuedMessages = [];
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.pendingTools.clear();

		// Switch session via AgentSession (emits extension session events)
		await this.session.switchSession(sessionPath);

		// Clear and re-render the chat
		this.chatContainer.clear();
		this.renderInitialMessages();

		if (this.session.sessionManager.wasInterrupted()) {
			this.showStatus("Resumed session (previous session ended unexpectedly - last action may be incomplete)");
		} else {
			this.showStatus("Resumed session");
		}
	}

	private showProviderManager(): void {
		this.showSelector((done) => {
			const component = new ProviderManagerComponent(
				this.ui,
				this.session.modelRegistry.authStorage,
				this.session.modelRegistry,
				() => {
					done();
					this.ui.requestRender();
				},
				async (provider: string) => {
					this.showStatus(`Discovering models for ${provider}...`);
					try {
						const results = await this.session.modelRegistry.discoverModels([provider]);
						const result = results[0];
						if (result?.error) {
							this.showError(`Discovery failed: ${result.error}`);
						} else {
							this.showStatus(`Discovered ${result?.models.length ?? 0} models from ${provider}`);
						}
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					}
					done();
					this.ui.requestRender();
				},
			);
			return { component, focus: component };
		});
	}

	private async showOAuthSelector(mode: "login" | "logout"): Promise<void> {
		if (mode === "logout") {
			const providers = this.session.modelRegistry.authStorage.list();
			const loggedInProviders = providers.filter(
				(p) => this.session.modelRegistry.authStorage.get(p)?.type === "oauth",
			);
			if (loggedInProviders.length === 0) {
				this.showStatus("No OAuth providers logged in. Use /login first.");
				return;
			}
		}

		this.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				mode,
				this.session.modelRegistry.authStorage,
				(providerId: string) => {
					done();

					// OAuthSelectorComponent calls this synchronously (no await),
					// so we must catch async errors here to prevent unhandled rejections
					// when the user cancels the login dialog (#821).
					const handleAsync = async () => {
						if (mode === "login") {
							await this.showLoginDialog(providerId);
						} else {
						// Logout flow
						const providerInfo = this.session.modelRegistry.authStorage
							.getOAuthProviders()
							.find((p) => p.id === providerId);
						const providerName = providerInfo?.name || providerId;

						try {
							this.session.modelRegistry.authStorage.logout(providerId);
							this.session.modelRegistry.refresh();
							await this.updateAvailableProviderCount();

							// Auto-switch model if current model belongs to the logged-out provider
							const currentModel = this.session.model;
							if (currentModel?.provider === providerId) {
								try {
									const available = this.session.modelRegistry.getAvailable();
									const fallback = available.find((m) => m.provider !== providerId);
									if (fallback) {
										await this.session.setModel(fallback);
									}
								} catch {
									// Model switch failed - user can manually switch via /model
								}
							}

							this.showStatus(`Logged out of ${providerName}`);
						} catch (error: unknown) {
							this.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
						}
					}
					};
					handleAsync().catch(() => {
						// Swallow - showLoginDialog already handles its own errors.
						// This prevents unhandled rejections when login is cancelled.
					});
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private async showLoginDialog(providerId: string): Promise<void> {
		const providerInfo = this.session.modelRegistry.authStorage.getOAuthProviders().find((p) => p.id === providerId);
		const providerName = providerInfo?.name || providerId;

		// Providers that use callback servers (can paste redirect URL)
		const usesCallbackServer = providerInfo?.usesCallbackServer ?? false;

		// Create login dialog component
		const dialog = new LoginDialogComponent(this.ui, providerId, (_success, _message) => {
			// Completion handled below
		});

		// Show dialog in editor container
		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.ui.requestRender();

		// Restore editor helper - also disposes the dialog to reject any
		// dangling promises and prevent the UI from getting stuck.
		const restoreEditor = () => {
			dialog.dispose();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		try {
			await this.session.modelRegistry.authStorage.login(providerId as OAuthProviderId, {
				onAuth: (info: { url: string; instructions?: string }) => {
					dialog.showAuth(info.url, info.instructions);

					if (!usesCallbackServer && providerId === "github-copilot") {
						// GitHub Copilot polls after onAuth
						dialog.showWaiting("Waiting for browser authentication...");
					}
					// For Anthropic: onPrompt is called immediately after
				},

				onPrompt: async (prompt: { message: string; placeholder?: string }) => {
					return dialog.showPrompt(prompt.message, prompt.placeholder);
				},

				onProgress: (message: string) => {
					dialog.showProgress(message);
				},

				// Callback-server providers race browser callback with pasted redirect URL.
				// Keep manual-input promise ownership inside provider flow to avoid
				// orphaned rejections when the callback is not consumed.
				onManualCodeInput: usesCallbackServer
					? () => dialog.showManualInput("Paste redirect URL below, or complete login in browser:")
					: undefined,

				signal: dialog.signal,
			});

			// Success
			restoreEditor();
			this.session.modelRegistry.refresh();
			await this.updateAvailableProviderCount();

			// Auto-switch model if current model has no valid API key
			try {
				const currentModel = this.session.model;
				if (currentModel) {
					const currentKey = await this.session.modelRegistry.getApiKey(currentModel);
					if (!currentKey) {
						const available = this.session.modelRegistry.getAvailable();
						const newProviderModel = available.find((m) => m.provider === providerId);
						if (newProviderModel) {
							await this.session.setModel(newProviderModel);
						} else if (available.length > 0) {
							await this.session.setModel(available[0]);
						}
					}
				}
			} catch (error: unknown) {
				// Model switch failed - user can manually switch via /model
			}

			this.showStatus(`Logged in to ${providerName}. Credentials saved to ${getAuthPath()}`);
		} catch (error: unknown) {
			restoreEditor();
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (errorMsg !== "Login cancelled" && !errorMsg.includes("Superseded") && !errorMsg.includes("disposed")) {
				this.showError(`Failed to login to ${providerName}: ${errorMsg}`);
			}
		}
	}

	// =========================================================================
	// Command handlers
	// =========================================================================

	private async handleReloadCommand(): Promise<void> {
		if (this.session.isStreaming) {
			this.showWarning("Wait for the current response to finish before reloading.");
			return;
		}
		if (this.session.isCompacting) {
			this.showWarning("Wait for compaction to finish before reloading.");
			return;
		}

		this.resetExtensionUI();

		const loader = new BorderedLoader(this.ui, theme, "Reloading extensions, skills, prompts, themes...", {
			cancellable: false,
		});
		const previousEditor = this.editor;
		this.editorContainer.clear();
		this.editorContainer.addChild(loader);
		this.ui.setFocus(loader);
		this.ui.requestRender();

		const dismissLoader = (editor: Component) => {
			loader.dispose();
			this.editorContainer.clear();
			this.editorContainer.addChild(editor);
			this.ui.setFocus(editor);
			this.ui.requestRender();
		};

		try {
			await this.session.reload();
			setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
			this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
			const themeName = this.settingsManager.getTheme();
			const themeResult = themeName
				? setTheme(themeName, true, this.settingsManager.getThemeAccent())
				: { success: true };
			this.updateEditorBorderColor();
			if (!themeResult.success) {
				this.showError(`Failed to load theme "${themeName}": ${themeResult.error}\nFell back to dark theme.`);
			}
			const editorPaddingX = this.settingsManager.getEditorPaddingX();
			const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
			this.defaultEditor.setPaddingX(editorPaddingX);
			this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
			if (this.editor !== this.defaultEditor) {
				this.editor.setPaddingX?.(editorPaddingX);
				this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
			}
			this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
			this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
			this.setupAutocomplete();
			const runner = this.session.extensionRunner;
			if (runner) {
				this.setupExtensionShortcuts(runner);
			}
			this.rebuildChatFromMessages();
			dismissLoader(this.editor as Component);
			this.showLoadedResources({
				extensionPaths: runner?.getExtensionPaths() ?? [],
				force: false,
				showDiagnosticsWhenQuiet: true,
			});
			const modelsJsonError = this.session.modelRegistry.getError();
			if (modelsJsonError) {
				this.showError(`models.json error: ${modelsJsonError}`);
			}
			this.showStatus("Reloaded extensions, skills, prompts, themes");
		} catch (error) {
			dismissLoader(previousEditor as Component);
			this.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async handleClearCommand(): Promise<void> {
		// Stop loading animation
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();

		// New session via session (emits extension session events)
		await this.session.newSession();

		// Clear UI state
		this.headerContainer.clear();
		this.chatContainer.clear();
		this.pendingMessagesContainer.clear();
		this.compactionQueuedMessages = [];
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.pendingTools.clear();

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(`${theme.fg("accent", "✓ New session started")}`, 1, 1));
		this.ui.requestRender();
	}

	private handleDebugCommand(): void {
		const width = this.ui.terminal.columns;
		const height = this.ui.terminal.rows;
		const allLines = this.ui.render(width);

		const debugLogPath = getDebugLogPath();
		const debugData = [
			`Debug output at ${new Date().toISOString()}`,
			`Terminal: ${width}x${height}`,
			`Total lines: ${allLines.length}`,
			"",
			"=== All rendered lines with visible widths ===",
			...allLines.map((line, idx) => {
				const vw = visibleWidth(line);
				const escaped = JSON.stringify(line);
				return `[${idx}] (w=${vw}) ${escaped}`;
			}),
			"",
			"=== Agent messages (JSONL) ===",
			...this.session.messages.map((msg) => JSON.stringify(msg)),
			"",
		].join("\n");

		fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
		fs.writeFileSync(debugLogPath, debugData);

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(`${theme.fg("accent", "✓ Debug log written")}\n${theme.fg("muted", debugLogPath)}`, 1, 1),
		);
		this.ui.requestRender();
	}

	private handleDaxnuts(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DaxnutsComponent(this.ui));
		this.ui.requestRender();
	}

	private checkDaxnutsEasterEgg(model: { provider: string; id: string }): void {
		if (model.provider === "opencode" && model.id.toLowerCase().includes("kimi-k2.5")) {
			this.handleDaxnuts();
		}
	}

	private getAgentPtyComponent(sessionId: string): EmbeddedTerminalComponent | undefined {
		return this.agentPtyComponents.get(sessionId);
	}

	private ensureAgentPtyComponent(sessionId: string, command?: string): EmbeddedTerminalComponent {
		let component = this.agentPtyComponents.get(sessionId);
		if (component) return component;

		component = new EmbeddedTerminalComponent(
			command || `PTY ${sessionId}`,
			this.ui,
			this.settingsManager.getToolOutputMode(),
			appKey(this.keybindings, "terminalFocus"),
			false,
		);
		// Wire up a handle shim so the user can focus and type into the agent PTY
		component.setHandle(
			{
				pid: 0,
				write: (data: string) => writeToPtySession(sessionId, data),
				resize: () => {},
				kill: () => {},
				isActive: () => true,
			},
			() => this.releaseEmbeddedTerminalFocus(),
		);
		component.setStatusOverride(theme.fg("muted", "Agent-controlled terminal session"));
		component.setExpanded(true);
		this.chatContainer.addChild(component);
		this.agentPtyComponents.set(sessionId, component);
		return component;
	}

	private updateAgentPtyComponent(
		sessionId: string,
		options?: { command?: string; screenText?: string; completed?: boolean; cancelled?: boolean; exitCode?: number },
	): void {
		const component = this.ensureAgentPtyComponent(sessionId, options?.command);
		if (options?.screenText !== undefined) {
			component.setScreenText(options.screenText);
		}
		if (options?.completed) {
			component.setStatusOverride(undefined);
			component.setComplete(options.exitCode, options.cancelled ?? false);
		} else {
			component.setStatusOverride(theme.fg("muted", "Agent-controlled terminal session"));
		}
	}

	private clearAgentPtyComponents(): void {
		for (const [, component] of this.agentPtyComponents) {
			this.chatContainer.removeChild(component);
		}
		this.agentPtyComponents.clear();
	}

	private focusEmbeddedTerminal(component: EmbeddedTerminalComponent): void {
		this.focusedEmbeddedTerminal = component;
		this.lastEmbeddedTerminalSize = undefined;
		this.ui.setFocus(component);
		component.invalidate();
		this.ui.requestRender();
	}

	private releaseEmbeddedTerminalFocus(): void {
		const focused = this.focusedEmbeddedTerminal;
		this.focusedEmbeddedTerminal = undefined;
		this.lastEmbeddedTerminalSize = undefined;
		this.ui.setFocus(this.editor);
		focused?.invalidate();
		this.ui.requestRender();
	}

	private toggleEmbeddedTerminalFocus(): void {
		if (this.focusedEmbeddedTerminal) {
			this.releaseEmbeddedTerminalFocus();
			return;
		}
		if (this.bashComponent instanceof EmbeddedTerminalComponent) {
			this.focusEmbeddedTerminal(this.bashComponent);
			return;
		}
		// Fall back to the most recently created agent PTY component
		const agentComponents = [...this.agentPtyComponents.values()];
		const last = agentComponents[agentComponents.length - 1];
		if (last) {
			this.focusEmbeddedTerminal(last);
		}
	}

	private async handleBashCommand(command: string, excludeFromContext = false, displayCommand?: string, loginShell?: boolean): Promise<void> {
		const extensionRunner = this.session.extensionRunner;
		const label = displayCommand || command;

		// Emit user_bash event to let extensions intercept
		const eventResult = extensionRunner
			? await extensionRunner.emitUserBash({
					type: "user_bash",
					command,
					excludeFromContext,
					cwd: process.cwd(),
				})
			: undefined;

		// If extension returned a full result, use it directly
		if (eventResult?.result) {
			const result = eventResult.result;

			// Create UI component for display
			const component = new BashExecutionComponent(
				label,
				this.ui,
				excludeFromContext,
				this.settingsManager.getToolOutputMode(),
				isRtkEnabled(),
				result.sandboxed ?? false,
			);
			this.bashComponent = component;
			component.setExpanded(this.toolOutputExpanded);
			if (this.session.isStreaming) {
				this.pendingMessagesContainer.addChild(component);
				this.pendingBashComponents.push(component);
			} else {
				this.chatContainer.addChild(component);
			}

			// Show output and complete
			if (result.output) {
				component.appendOutput(result.output);
			}
			component.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				result.fullOutputPath,
				result.sandboxed,
			);

			// Record the result in session
			this.session.recordBashResult(command, result, { excludeFromContext });
			this.bashComponent = undefined;
			this.ui.requestRender();
			return;
		}

		// Normal execution path (possibly with custom operations)
		const isDeferred = this.session.isStreaming;
		const canUsePty = !eventResult?.operations && await isPtyAvailable();

		if (canUsePty) {
			const component = new EmbeddedTerminalComponent(
				label,
				this.ui,
				this.settingsManager.getToolOutputMode(),
				appKey(this.keybindings, "terminalFocus"),
				excludeFromContext,
			);
			this.bashComponent = component;
			component.setExpanded(this.toolOutputExpanded);

			if (isDeferred) {
				this.pendingMessagesContainer.addChild(component);
				this.pendingBashComponents.push(component);
			} else {
				this.chatContainer.addChild(component);
			}
			this.ui.requestRender();

			try {
				const session = await this.session.executeBashInteractive(command, {
					onChunk: (chunk) => {
						component.appendOutput(chunk);
						this.ui.requestRender();
					},
					cols: Math.max(40, this.ui.terminal.columns - 2),
					rows: Math.max(10, this.ui.terminal.rows - 8),
					loginShell,
				});
				component.setHandle(session.handle, () => this.releaseEmbeddedTerminalFocus());
				if (!isDeferred) {
					this.focusEmbeddedTerminal(component);
				}

				const result = await session.result;
				component.setComplete(result.exitCode, result.cancelled);
				this.session.recordBashResult(command, result, { excludeFromContext });
			} catch (error) {
				component.setComplete(undefined, false);
				this.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
			} finally {
				if (this.focusedEmbeddedTerminal === component) {
					this.releaseEmbeddedTerminalFocus();
				}
				this.session.clearBashAbortController();
				this.bashComponent = undefined;
				this.ui.requestRender();
			}
			return;
		}

		const fallbackComponent = new BashExecutionComponent(
			label,
			this.ui,
			excludeFromContext,
			this.settingsManager.getToolOutputMode(),
			isRtkEnabled(),
			false,
		);
		this.bashComponent = fallbackComponent;
		fallbackComponent.setExpanded(this.toolOutputExpanded);

		if (isDeferred) {
			// Show in pending area when agent is streaming
			this.pendingMessagesContainer.addChild(fallbackComponent);
			this.pendingBashComponents.push(fallbackComponent);
		} else {
			// Show in chat immediately when agent is idle
			this.chatContainer.addChild(fallbackComponent);
		}
		this.ui.requestRender();

		try {
			const result = await this.session.executeBash(
				command,
				(chunk) => {
					fallbackComponent.appendOutput(chunk);
					this.ui.requestRender();
				},
				{ excludeFromContext, operations: eventResult?.operations, loginShell },
			);

			fallbackComponent.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				result.fullOutputPath,
				result.sandboxed,
			);
		} catch (error) {
			fallbackComponent.setComplete(undefined, false);
			this.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		this.bashComponent = undefined;
		this.ui.requestRender();
	}

	private async executeCompaction(customInstructions?: string, isAuto = false): Promise<CompactionResult | undefined> {
		// Stop loading animation
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();

		// Set up escape handler during compaction
		const originalOnEscape = this.defaultEditor.onEscape;
		this.defaultEditor.onEscape = () => {
			this.session.abortCompaction();
		};

		// Show compacting status
		this.chatContainer.addChild(new Spacer(1));
		const cancelHint = `(${appKey(this.keybindings, "interrupt")} to cancel)`;
		const label = isAuto ? `Auto-compacting context... ${cancelHint}` : `Compacting context... ${cancelHint}`;
		const compactingLoader = new Loader(
			this.ui,
			(spinner) => theme.fg("text", spinner),
			(text) => theme.fg("muted", text),
			label,
		);
		this.statusContainer.addChild(compactingLoader);
		this.ui.requestRender();

		let result: CompactionResult | undefined;

		try {
			result = await this.session.compact(customInstructions);

			// Rebuild UI
			this.rebuildChatFromMessages();

			// Add compaction component at bottom so user sees it without scrolling
			const msg = createCompactionSummaryMessage(result.summary, result.tokensBefore, new Date().toISOString());
			this.addMessageToChat(msg);

			this.footer.invalidate();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError")) {
				this.showError("Compaction cancelled");
			} else {
				this.showError(`Compaction failed: ${message}`);
			}
		} finally {
			compactingLoader.stop();
			this.statusContainer.clear();
			this.defaultEditor.onEscape = originalOnEscape;
		}
		void this.flushCompactionQueue({ willRetry: false });
		return result;
	}

	requestRender(force = false): void {
		if (!this.isInitialized) return;
		if (this.focusedEmbeddedTerminal) {
			const cols = Math.max(40, this.ui.terminal.columns - 2);
			const rows = Math.max(10, this.ui.terminal.rows - 8);
			if (!this.lastEmbeddedTerminalSize || this.lastEmbeddedTerminalSize.cols !== cols || this.lastEmbeddedTerminalSize.rows !== rows) {
				this.focusedEmbeddedTerminal.resize(cols, rows);
				this.lastEmbeddedTerminalSize = { cols, rows };
			}
		}
		this.ui.requestRender(force);
	}

	stop(): void {
		this.stopLoadingTips();
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.clearExtensionTerminalInputListeners();
		this.footer.dispose();
		this.footerDataProvider.dispose();
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}
}
