import type { Transport } from "@gsd/pi-ai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.js";
import {
	COMPACTION_KEEP_RECENT_TOKENS,
	COMPACTION_RESERVE_TOKENS,
	RETRY_BASE_DELAY_MS,
	RETRY_MAX_DELAY_MS,
} from "./constants.js";
import type { BashInterceptorRule } from "./tools/bash-interceptor.js";

export interface CompactionSettings {
	enabled?: boolean; // default: true
	thresholdPercent?: number; // default: 85
	reserveTokens?: number; // default: 16384 (used for compaction summary generation budget)
	keepRecentTokens?: number; // default: 20000
}

export interface BranchSummarySettings {
	reserveTokens?: number; // default: 16384 (tokens reserved for prompt + LLM response)
	skipPrompt?: boolean; // default: false - when true, skips "Summarize branch?" prompt and defaults to no summary
}

export interface RetrySettings {
	enabled?: boolean; // default: true
	maxRetries?: number; // default: 3
	baseDelayMs?: number; // default: 2000 (exponential backoff: 2s, 4s, 8s)
	maxDelayMs?: number; // default: 300000 (max server-requested delay before failing)
}

export interface TerminalSettings {
	showImages?: boolean; // default: true (only relevant if terminal supports images)
	clearOnShrink?: boolean; // default: false (clear empty rows when content shrinks)
}

export interface ImageSettings {
	autoResize?: boolean; // default: true (resize images to 2000x2000 max for better model compatibility)
	blockImages?: boolean; // default: false - when true, prevents all images from being sent to LLM providers
}

export interface ThinkingBudgetsSettings {
	low?: number;
	medium?: number;
	high?: number;
}

export interface BashInterceptorSettings {
	enabled?: boolean; // default: true
	rules?: BashInterceptorRule[]; // override default rules
}

export interface SandboxSettings {
	enabled?: boolean; // default: true on supported platforms
	autoAllowBashIfSandboxed?: boolean; // default: true
	writableRoots?: string[]; // additional writable roots beyond cwd and /tmp
	readOnlySubpaths?: string[]; // protected subpaths within writable roots
	networkEnabled?: boolean; // legacy boolean override; prefer networkMode
	networkMode?: "allow" | "ask" | "deny"; // default: ask
}

export interface MarkdownSettings {
	codeBlockIndent?: string; // default: "  "
}

export interface MemorySettings {
	enabled?: boolean; // default: false
	maxRolloutsPerStartup?: number; // default: 64
	maxRolloutAgeDays?: number; // default: 30
	minRolloutIdleHours?: number; // default: 12
	stage1Concurrency?: number; // default: 8
	summaryInjectionTokenLimit?: number; // default: 5000
}

export interface AsyncSettings {
	enabled?: boolean;  // default: false
	maxJobs?: number;   // default: 100
}

export interface TaskIsolationSettings {
	mode?: "none" | "worktree" | "fuse-overlay"; // default: "none"
	merge?: "patch" | "branch"; // default: "patch"
}

export interface FallbackChainEntry {
	provider: string;
	model: string;
	priority: number;
}

export interface FallbackSettings {
	enabled?: boolean; // default: false
	chains?: Record<string, FallbackChainEntry[]>; // keyed by chain name
}

export interface ModelDiscoverySettings {
	enabled?: boolean; // default: false
	providers?: string[]; // limit discovery to specific providers
	ttlMinutes?: number; // override default TTLs (in minutes)
	autoRefreshOnModelSelect?: boolean; // default: false - refresh discovery when opening model selector
}

export type TransportSetting = Transport;

/**
 * Package source for npm/git packages.
 * - String form: load all resources from the package
 * - Object form: filter which resources to load
 */
export type PackageSource =
	| string
	| {
			source: string;
			extensions?: string[];
			skills?: string[];
			prompts?: string[];
			themes?: string[];
	  };

export interface Settings {
	lastChangelogVersion?: string;
	defaultProvider?: string;
	defaultModel?: string;
	budgetSubagentModel?: string;
	planModeReasoningModel?: string;
	planModeReviewModel?: string;
	planModeCodingModel?: string;
	autoSuggestPlanMode?: boolean; // default: false — append a system-prompt instruction so the LLM proposes plan mode for large tasks
	autoSwitchPlanModel?: boolean; // default: false — enable opusplan-style model switching (auto-switch to reasoning model on entry, new-session option on approval)
	permissionMode?: "danger-full-access" | "accept-on-edit" | "auto" | "plan";
	classifierModel?: string;
	adaptiveClassifierModel?: string;
	defaultThinkingLevel?: "off" | "low" | "medium" | "high" | "xhigh" | "adaptive";
	anthropicAdaptiveByDefault?: boolean; // default: false — prefer adaptive thinking when using supported Anthropic models
	clientAdaptiveByDefault?: boolean; // default: true — prefer adaptive thinking for any reasoning-capable model
	transport?: TransportSetting; // default: "sse"
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	theme?: string;
	themeAccent?: string;
	compaction?: CompactionSettings;
	branchSummary?: BranchSummarySettings;
	retry?: RetrySettings;
	hideThinkingBlock?: boolean;
	shellPath?: string; // Custom shell path (e.g., for Cygwin users on Windows)
	quietStartup?: boolean;
	shellCommandPrefix?: string; // Prefix prepended to every bash command (e.g., "shopt -s expand_aliases" for alias support)
	collapseChangelog?: boolean; // Show condensed changelog after update (use /changelog for full)
	packages?: PackageSource[]; // Array of npm/git package sources (string or object with filtering)
	extensions?: string[]; // Array of local extension file paths or directories
	skills?: string[]; // Array of local skill file paths or directories
	prompts?: string[]; // Array of local prompt template paths or directories
	themes?: string[]; // Array of local theme file paths or directories
	enableSkillCommands?: boolean; // default: true - register skills as /skill:name commands
	toolSearch?: boolean; // legacy boolean toggle from deprecated minimal profile; retained for migration only
	toolProfile?: "balanced" | "standard" | "full"; // default: "balanced"
	terminal?: TerminalSettings;
	images?: ImageSettings;
	enabledModels?: string[]; // Model patterns for cycling (same format as --models CLI flag)
	codexRotate?: boolean; // Enable the bundled codex-rotate extension (default: false)
	fastMode?: boolean; // Enable OpenAI/Codex fast tier routing (priority service tier where supported)
	cacheTimer?: boolean; // Show elapsed time since last response in the footer (default: true)
	pinLastPrompt?: boolean; // Pin last sent prompt above the editor as a reminder (default: false)
	doubleEscapeAction?: "fork" | "tree" | "none"; // Action for double-escape with empty editor (default: "tree")
	treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all"; // Default filter when opening /tree
	thinkingBudgets?: ThinkingBudgetsSettings; // Custom token budgets for thinking levels
	editorPaddingX?: number; // Horizontal padding for input editor (default: 0)
	autocompleteMaxVisible?: number; // Max visible items in autocomplete dropdown (default: 5)
	respectGitignoreInPicker?: boolean; // When false, @ file picker shows gitignored files (default: true)
	searchExcludeDirs?: string[]; // Directories to exclude from @ file search (e.g., ["node_modules", ".git", "dist"])
	showHardwareCursor?: boolean; // Show terminal cursor while still positioning it for IME
	markdown?: MarkdownSettings;
	memory?: MemorySettings;
	async?: AsyncSettings;
	bashInterceptor?: BashInterceptorSettings;
	sandbox?: SandboxSettings;
	taskIsolation?: TaskIsolationSettings;
	fallback?: FallbackSettings;
	modelDiscovery?: ModelDiscoverySettings;
	editMode?: "standard" | "hashline"; // Edit tool mode: "standard" (text match) or "hashline" (LINE#ID anchors). Default: "standard"
	timestampFormat?: "date-time-iso" | "date-time-us"; // Timestamp display format for messages. Default: "date-time-iso"
	toolOutputMode?: "minimal" | "normal"; // Collapsed tool rendering mode. "minimal" hides previews until expanded.
	lspAutoInstall?: boolean; // default: false — whether to auto-install missing language servers during onboarding
	lspInstalledServers?: string[]; // list of server names installed via the onboarding wizard
	rtk?: boolean; // default: false — enable RTK shell-command compression (requires restart)
	editorScheme?: "auto" | "vscode" | "cursor" | "zed" | "jetbrains" | "sublime" | "file"; // URI scheme for Cmd+click file links (default: "auto")
	autoDream?: boolean; // default: false — enable automatic memory consolidation (dream) after sessions
	autoMemory?: boolean; // default: false — enable automatic memory extraction from session transcripts
	notificationSound?: boolean; // default: false — play terminal bell when agent finishes responding
	telegramLiveRelayAutoConnect?: boolean; // default: false — auto-run /lsd telegram connect on startup
}

function isQualifiedProviderModelRef(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const trimmed = value.trim();
	if (!trimmed) return false;
	const parts = trimmed.split("/");
	return parts.length === 2 && parts.every((part) => part.trim().length > 0);
}

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	const result: Settings = { ...base };

	for (const key of Object.keys(overrides) as (keyof Settings)[]) {
		const overrideValue = overrides[key];
		const baseValue = base[key];

		if (overrideValue === undefined) {
			continue;
		}

		// For nested objects, merge recursively
		if (
			typeof overrideValue === "object" &&
			overrideValue !== null &&
			!Array.isArray(overrideValue) &&
			typeof baseValue === "object" &&
			baseValue !== null &&
			!Array.isArray(baseValue)
		) {
			(result as Record<string, unknown>)[key] = { ...baseValue, ...overrideValue };
		} else {
			// For primitives and arrays, override value wins
			(result as Record<string, unknown>)[key] = overrideValue;
		}
	}

	return result;
}

export type SettingsScope = "global" | "project";

export interface SettingsStorage {
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
}

export interface SettingsError {
	scope: SettingsScope;
	error: Error;
}

class FileSettingsStorage implements SettingsStorage {
	private globalSettingsPath: string;
	private projectSettingsPath: string;

	constructor(cwd: string = process.cwd(), agentDir: string = getAgentDir()) {
		this.globalSettingsPath = join(agentDir, "settings.json");
		this.projectSettingsPath = join(cwd, CONFIG_DIR_NAME, "settings.json");
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire settings lock");
	}

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const dir = dirname(path);

		let release: (() => void) | undefined;
		try {
			// Only create directory and lock if file exists or we need to write
			const fileExists = existsSync(path);
			if (fileExists) {
				release = this.acquireLockSyncWithRetry(path);
			}
			const current = fileExists ? readFileSync(path, "utf-8") : undefined;
			const next = fn(current);
			if (next !== undefined) {
				// Only create directory when we actually need to write
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true });
				}
				if (!release) {
					release = this.acquireLockSyncWithRetry(path);
				}
				writeFileSync(path, next, "utf-8");
			}
		} finally {
			if (release) {
				release();
			}
		}
	}
}

class InMemorySettingsStorage implements SettingsStorage {
	private global: string | undefined;
	private project: string | undefined;

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const current = scope === "global" ? this.global : this.project;
		const next = fn(current);
		if (next !== undefined) {
			if (scope === "global") {
				this.global = next;
			} else {
				this.project = next;
			}
		}
	}
}

export class SettingsManager {
	private storage: SettingsStorage;
	private globalSettings: Settings;
	private projectSettings: Settings;
	private settings: Settings;
	private modifiedFields = new Set<keyof Settings>(); // Track global fields modified during session
	private modifiedNestedFields = new Map<keyof Settings, Set<string>>(); // Track global nested field modifications
	private modifiedProjectFields = new Set<keyof Settings>(); // Track project fields modified during session
	private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>(); // Track project nested field modifications
	private globalSettingsLoadError: Error | null = null; // Track if global settings file had parse errors
	private projectSettingsLoadError: Error | null = null; // Track if project settings file had parse errors
	private writeQueue: Promise<void> = Promise.resolve();
	private errors: SettingsError[];

	private constructor(
		storage: SettingsStorage,
		initialGlobal: Settings,
		initialProject: Settings,
		globalLoadError: Error | null = null,
		projectLoadError: Error | null = null,
		initialErrors: SettingsError[] = [],
	) {
		this.storage = storage;
		this.globalSettings = initialGlobal;
		this.projectSettings = initialProject;
		this.globalSettingsLoadError = globalLoadError;
		this.projectSettingsLoadError = projectLoadError;
		this.errors = [...initialErrors];
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	/** Create a SettingsManager that loads from files */
	static create(cwd: string = process.cwd(), agentDir: string = getAgentDir()): SettingsManager {
		const storage = new FileSettingsStorage(cwd, agentDir);
		return SettingsManager.fromStorage(storage);
	}

	/** Create a SettingsManager from an arbitrary storage backend */
	static fromStorage(storage: SettingsStorage): SettingsManager {
		const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
		const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project");
		const initialErrors: SettingsError[] = [];
		if (globalLoad.error) {
			initialErrors.push({ scope: "global", error: globalLoad.error });
		}
		if (projectLoad.error) {
			initialErrors.push({ scope: "project", error: projectLoad.error });
		}

		return new SettingsManager(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
		);
	}

	/** Create an in-memory SettingsManager (no file I/O) */
	static inMemory(settings: Partial<Settings> = {}): SettingsManager {
		const storage = new InMemorySettingsStorage();
		return new SettingsManager(storage, settings, {});
	}

	private static loadFromStorage(storage: SettingsStorage, scope: SettingsScope): Settings {
		let content: string | undefined;
		storage.withLock(scope, (current) => {
			content = current;
			return undefined;
		});

		if (!content) {
			return {};
		}
		const settings = JSON.parse(content);
		return SettingsManager.migrateSettings(settings);
	}

	private static tryLoadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
	): { settings: Settings; error: Error | null } {
		try {
			return { settings: SettingsManager.loadFromStorage(storage, scope), error: null };
		} catch (error) {
			return { settings: {}, error: error as Error };
		}
	}

	/** Migrate old settings format to new format */
	private static migrateSettings(settings: Record<string, unknown>): Settings {
		// Migrate queueMode -> steeringMode
		if ("queueMode" in settings && !("steeringMode" in settings)) {
			settings.steeringMode = settings.queueMode;
			delete settings.queueMode;
		}

		// Migrate legacy websockets boolean -> transport enum
		if (!("transport" in settings) && typeof settings.websockets === "boolean") {
			settings.transport = settings.websockets ? "websocket" : "sse";
			delete settings.websockets;
		}

		// Migrate old skills object format to new array format
		if (
			"skills" in settings &&
			typeof settings.skills === "object" &&
			settings.skills !== null &&
			!Array.isArray(settings.skills)
		) {
			const skillsSettings = settings.skills as {
				enableSkillCommands?: boolean;
				customDirectories?: unknown;
			};
			if (skillsSettings.enableSkillCommands !== undefined && settings.enableSkillCommands === undefined) {
				settings.enableSkillCommands = skillsSettings.enableSkillCommands;
			}
			if (Array.isArray(skillsSettings.customDirectories) && skillsSettings.customDirectories.length > 0) {
				settings.skills = skillsSettings.customDirectories;
			} else {
				delete settings.skills;
			}
		}

		if (
			"planModeReasoningModel" in settings &&
			settings.planModeReasoningModel !== undefined &&
			!isQualifiedProviderModelRef(settings.planModeReasoningModel)
		) {
			delete settings.planModeReasoningModel;
		}

		if (
			"planModeReviewModel" in settings &&
			settings.planModeReviewModel !== undefined &&
			!isQualifiedProviderModelRef(settings.planModeReviewModel)
		) {
			delete settings.planModeReviewModel;
		}

		if (
			"planModeCodingModel" in settings &&
			settings.planModeCodingModel !== undefined &&
			!isQualifiedProviderModelRef(settings.planModeCodingModel)
		) {
			delete settings.planModeCodingModel;
		}

		return settings as Settings;
	}

	getGlobalSettings(): Settings {
		return structuredClone(this.globalSettings);
	}

	getProjectSettings(): Settings {
		return structuredClone(this.projectSettings);
	}

	getBashInterceptorEnabled(): boolean {
		return this.settings.bashInterceptor?.enabled ?? true;
	}

	getBashInterceptorRules(): BashInterceptorRule[] | undefined {
		return this.settings.bashInterceptor?.rules;
	}

	reload(): void {
		const globalLoad = SettingsManager.tryLoadFromStorage(this.storage, "global");
		if (!globalLoad.error) {
			this.globalSettings = globalLoad.settings;
			this.globalSettingsLoadError = null;
		} else {
			this.globalSettingsLoadError = globalLoad.error;
			this.recordError("global", globalLoad.error);
		}

		this.modifiedFields.clear();
		this.modifiedNestedFields.clear();
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project");
		if (!projectLoad.error) {
			this.projectSettings = projectLoad.settings;
			this.projectSettingsLoadError = null;
		} else {
			this.projectSettingsLoadError = projectLoad.error;
			this.recordError("project", projectLoad.error);
		}

		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	/** Apply additional overrides on top of current settings */
	applyOverrides(overrides: Partial<Settings>): void {
		this.settings = deepMergeSettings(this.settings, overrides);
	}

	/** Mark a global field as modified during this session */
	private markModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedFields.add(field);
		if (nestedKey) {
			if (!this.modifiedNestedFields.has(field)) {
				this.modifiedNestedFields.set(field, new Set());
			}
			this.modifiedNestedFields.get(field)!.add(nestedKey);
		}
	}

	/** Mark a project field as modified during this session */
	private markProjectModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedProjectFields.add(field);
		if (nestedKey) {
			if (!this.modifiedProjectNestedFields.has(field)) {
				this.modifiedProjectNestedFields.set(field, new Set());
			}
			this.modifiedProjectNestedFields.get(field)!.add(nestedKey);
		}
	}

	private recordError(scope: SettingsScope, error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push({ scope, error: normalizedError });
	}

	/**
	 * Check if project-level settings are active (loaded from a file).
	 * Used to scope model persistence to the project when possible,
	 * preventing model config bleed between concurrent instances (#650).
	 */
	private hasProjectSettings(): boolean {
		// Project settings are active if we loaded them and they weren't empty/errored
		return !this.projectSettingsLoadError && Object.keys(this.projectSettings).length > 0;
	}

	private clearModifiedScope(scope: SettingsScope): void {
		if (scope === "global") {
			this.modifiedFields.clear();
			this.modifiedNestedFields.clear();
			return;
		}

		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();
	}

	private enqueueWrite(scope: SettingsScope, task: () => void): void {
		this.writeQueue = this.writeQueue
			.then(() => {
				task();
				this.clearModifiedScope(scope);
			})
			.catch((error) => {
				this.recordError(scope, error);
			});
	}

	private cloneModifiedNestedFields(source: Map<keyof Settings, Set<string>>): Map<keyof Settings, Set<string>> {
		const snapshot = new Map<keyof Settings, Set<string>>();
		for (const [key, value] of source.entries()) {
			snapshot.set(key, new Set(value));
		}
		return snapshot;
	}

	private persistScopedSettings(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
	): void {
		this.storage.withLock(scope, (current) => {
			const currentFileSettings = current
				? SettingsManager.migrateSettings(JSON.parse(current) as Record<string, unknown>)
				: {};
			const mergedSettings: Settings = { ...currentFileSettings };
			for (const field of modifiedFields) {
				const value = snapshotSettings[field];
				if (modifiedNestedFields.has(field) && typeof value === "object" && value !== null) {
					const nestedModified = modifiedNestedFields.get(field)!;
					const baseNested = (currentFileSettings[field] as Record<string, unknown>) ?? {};
					const inMemoryNested = value as Record<string, unknown>;
					const mergedNested = { ...baseNested };
					for (const nestedKey of nestedModified) {
						mergedNested[nestedKey] = inMemoryNested[nestedKey];
					}
					(mergedSettings as Record<string, unknown>)[field] = mergedNested;
				} else {
					(mergedSettings as Record<string, unknown>)[field] = value;
				}
			}

			return JSON.stringify(mergedSettings, null, 2);
		});
	}

	private save(): void {
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);

		if (this.globalSettingsLoadError) {
			return;
		}

		const snapshotGlobalSettings = structuredClone(this.globalSettings);
		const modifiedFields = new Set(this.modifiedFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);

		this.enqueueWrite("global", () => {
			this.persistScopedSettings("global", snapshotGlobalSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private saveProjectSettings(settings: Settings): void {
		this.projectSettings = structuredClone(settings);
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);

		if (this.projectSettingsLoadError) {
			return;
		}

		const snapshotProjectSettings = structuredClone(this.projectSettings);
		const modifiedFields = new Set(this.modifiedProjectFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedProjectNestedFields);
		this.enqueueWrite("project", () => {
			this.persistScopedSettings("project", snapshotProjectSettings, modifiedFields, modifiedNestedFields);
		});
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}

	drainErrors(): SettingsError[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	// ── Generic setter helpers ──────────────────────────────────────────

	/** Set a top-level global setting field, mark modified, and save. */
	private setGlobalSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
		this.globalSettings[key] = value;
		this.markModified(key);
		this.save();
	}

	/** Set a top-level setting, scoped to project when project settings are active. */
	private setScopedSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
		if (this.hasProjectSettings()) {
			this.projectSettings[key] = value;
			this.markProjectModified(key);
			this.saveProjectSettings(this.projectSettings);
		} else {
			this.setGlobalSetting(key, value);
		}
	}

	/** Set a nested field within a global settings object (e.g. compaction.enabled). */
	private setNestedGlobalSetting<K extends keyof Settings, NK extends string & keyof NonNullable<Settings[K]>>(
		key: K,
		nestedKey: NK,
		value: NonNullable<Settings[K]>[NK],
	): void {
		if (!this.globalSettings[key]) {
			(this.globalSettings as Record<string, unknown>)[key] = {};
		}
		(this.globalSettings[key] as Record<string, unknown>)[nestedKey] = value;
		this.markModified(key, nestedKey);
		this.save();
	}

	/** Set a field on project settings (clone, set, mark modified, save). */
	private setProjectSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
		const projectSettings = structuredClone(this.projectSettings);
		projectSettings[key] = value;
		this.markProjectModified(key);
		this.saveProjectSettings(projectSettings);
	}

	// ── Public getters and setters ──────────────────────────────────────

	getLastChangelogVersion(): string | undefined {
		return this.settings.lastChangelogVersion;
	}

	setLastChangelogVersion(version: string): void {
		this.setGlobalSetting("lastChangelogVersion", version);
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	getBudgetSubagentModel(): string | undefined {
		return this.settings.budgetSubagentModel;
	}

	getPlanModeReasoningModel(): string | undefined {
		return isQualifiedProviderModelRef(this.settings.planModeReasoningModel)
			? this.settings.planModeReasoningModel.trim()
			: undefined;
	}

	getPlanModeReviewModel(): string | undefined {
		return isQualifiedProviderModelRef(this.settings.planModeReviewModel)
			? this.settings.planModeReviewModel.trim()
			: undefined;
	}

	getPlanModeCodingModel(): string | undefined {
		return isQualifiedProviderModelRef(this.settings.planModeCodingModel)
			? this.settings.planModeCodingModel.trim()
			: undefined;
	}

	getPermissionMode(): "danger-full-access" | "accept-on-edit" | "auto" | "plan" {
		return this.settings.permissionMode ?? "accept-on-edit";
	}

	getClassifierModel(): string | undefined {
		return this.settings.classifierModel;
	}

	getAdaptiveClassifierModel(): string | undefined {
		return this.settings.adaptiveClassifierModel;
	}

	setDefaultProvider(provider: string): void {
		this.setScopedSetting("defaultProvider", provider);
	}

	setDefaultModel(modelId: string): void {
		this.setScopedSetting("defaultModel", modelId);
	}

	setBudgetSubagentModel(modelRef: string | undefined): void {
		if (modelRef === undefined) {
			delete this.globalSettings.budgetSubagentModel;
			this.markModified("budgetSubagentModel");
			this.save();
			return;
		}
		this.setGlobalSetting("budgetSubagentModel", modelRef);
	}

	setPlanModeReasoningModel(modelRef: string | undefined): void {
		if (modelRef === undefined) {
			delete this.globalSettings.planModeReasoningModel;
			this.markModified("planModeReasoningModel");
			this.save();
			return;
		}
		if (!isQualifiedProviderModelRef(modelRef)) {
			throw new Error(`planModeReasoningModel must be in provider/id format. Received: ${modelRef}`);
		}
		this.setGlobalSetting("planModeReasoningModel", modelRef.trim());
	}

	setPlanModeReviewModel(modelRef: string | undefined): void {
		if (modelRef === undefined) {
			delete this.globalSettings.planModeReviewModel;
			this.markModified("planModeReviewModel");
			this.save();
			return;
		}
		if (!isQualifiedProviderModelRef(modelRef)) {
			throw new Error(`planModeReviewModel must be in provider/id format. Received: ${modelRef}`);
		}
		this.setGlobalSetting("planModeReviewModel", modelRef.trim());
	}

	setPlanModeCodingModel(modelRef: string | undefined): void {
		if (modelRef === undefined) {
			delete this.globalSettings.planModeCodingModel;
			this.markModified("planModeCodingModel");
			this.save();
			return;
		}
		if (!isQualifiedProviderModelRef(modelRef)) {
			throw new Error(`planModeCodingModel must be in provider/id format. Received: ${modelRef}`);
		}
		this.setGlobalSetting("planModeCodingModel", modelRef.trim());
	}

	getAutoSuggestPlanMode(): boolean {
		return this.settings.autoSuggestPlanMode ?? false;
	}

	setAutoSuggestPlanMode(enabled: boolean): void {
		this.setGlobalSetting("autoSuggestPlanMode", enabled);
	}

	getAutoSwitchPlanModel(): boolean {
		return this.settings.autoSwitchPlanModel ?? false;
	}

	setAutoSwitchPlanModel(enabled: boolean): void {
		this.setGlobalSetting("autoSwitchPlanModel", enabled);
	}

	setPermissionMode(mode: "danger-full-access" | "accept-on-edit" | "auto" | "plan"): void {
		this.setGlobalSetting("permissionMode", mode);
	}

	setClassifierModel(modelRef: string | undefined): void {
		if (modelRef === undefined) {
			delete this.globalSettings.classifierModel;
			this.markModified("classifierModel");
			this.save();
			return;
		}
		this.setGlobalSetting("classifierModel", modelRef);
	}

	setAdaptiveClassifierModel(modelRef: string | undefined): void {
		if (modelRef === undefined) {
			delete this.globalSettings.adaptiveClassifierModel;
			this.markModified("adaptiveClassifierModel");
			this.save();
			return;
		}
		this.setGlobalSetting("adaptiveClassifierModel", modelRef);
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		if (this.hasProjectSettings()) {
			this.projectSettings.defaultProvider = provider;
			this.projectSettings.defaultModel = modelId;
			this.markProjectModified("defaultProvider");
			this.markProjectModified("defaultModel");
			this.saveProjectSettings(this.projectSettings);
		} else {
			this.globalSettings.defaultProvider = provider;
			this.globalSettings.defaultModel = modelId;
			this.markModified("defaultProvider");
			this.markModified("defaultModel");
			this.save();
		}
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.settings.steeringMode || "one-at-a-time";
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.setGlobalSetting("steeringMode", mode);
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.settings.followUpMode || "one-at-a-time";
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.setGlobalSetting("followUpMode", mode);
	}

	getTheme(): string | undefined {
		return this.settings.theme;
	}

	setTheme(theme: string): void {
		this.setGlobalSetting("theme", theme);
	}

	getThemeAccent(): string | undefined {
		return this.settings.themeAccent;
	}

	setThemeAccent(accent: string | undefined): void {
		if (accent === undefined) {
			delete this.globalSettings.themeAccent;
			this.markModified("themeAccent");
			this.save();
			return;
		}
		this.setGlobalSetting("themeAccent", accent);
	}

	getDefaultThinkingLevel(): "off" | "low" | "medium" | "high" | "xhigh" | "adaptive" | undefined {
		return this.settings.defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: "off" | "low" | "medium" | "high" | "xhigh" | "adaptive"): void {
		this.setGlobalSetting("defaultThinkingLevel", level);
	}

	getAnthropicAdaptiveByDefault(): boolean {
		return this.settings.anthropicAdaptiveByDefault ?? false;
	}

	setAnthropicAdaptiveByDefault(enabled: boolean): void {
		this.setGlobalSetting("anthropicAdaptiveByDefault", enabled);
	}

	getClientAdaptiveByDefault(): boolean {
		return this.settings.clientAdaptiveByDefault ?? true;
	}

	setClientAdaptiveByDefault(enabled: boolean): void {
		this.setGlobalSetting("clientAdaptiveByDefault", enabled);
	}

	getTransport(): TransportSetting {
		return this.settings.transport ?? "sse";
	}

	setTransport(transport: TransportSetting): void {
		this.setGlobalSetting("transport", transport);
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? true;
	}

	setCompactionEnabled(enabled: boolean): void {
		this.setNestedGlobalSetting("compaction", "enabled", enabled);
	}

	setCompactionThresholdPercent(percent: number): void {
		this.setNestedGlobalSetting("compaction", "thresholdPercent", percent);
	}

	getCompactionThresholdPercent(): number {
		return this.settings.compaction?.thresholdPercent ?? 85;
	}

	getCompactionReserveTokens(): number {
		return this.settings.compaction?.reserveTokens ?? COMPACTION_RESERVE_TOKENS;
	}

	getCompactionKeepRecentTokens(): number {
		return this.settings.compaction?.keepRecentTokens ?? COMPACTION_KEEP_RECENT_TOKENS;
	}

	getCompactionSettings(): { enabled: boolean; reserveTokens: number; keepRecentTokens: number; thresholdPercent: number } {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(),
			keepRecentTokens: this.getCompactionKeepRecentTokens(),
			thresholdPercent: this.getCompactionThresholdPercent(),
		};
	}

	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
		return {
			reserveTokens: this.settings.branchSummary?.reserveTokens ?? COMPACTION_RESERVE_TOKENS,
			skipPrompt: this.settings.branchSummary?.skipPrompt ?? false,
		};
	}

	getBranchSummarySkipPrompt(): boolean {
		return this.settings.branchSummary?.skipPrompt ?? false;
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? true;
	}

	setRetryEnabled(enabled: boolean): void {
		this.setNestedGlobalSetting("retry", "enabled", enabled);
	}

	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number; maxDelayMs: number } {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: this.settings.retry?.maxRetries ?? 3,
			baseDelayMs: this.settings.retry?.baseDelayMs ?? RETRY_BASE_DELAY_MS,
			maxDelayMs: this.settings.retry?.maxDelayMs ?? RETRY_MAX_DELAY_MS,
		};
	}

	getHideThinkingBlock(): boolean {
		return this.settings.hideThinkingBlock ?? true;
	}

	setHideThinkingBlock(hide: boolean): void {
		this.setGlobalSetting("hideThinkingBlock", hide);
	}

	getShellPath(): string | undefined {
		return this.settings.shellPath;
	}

	setShellPath(path: string | undefined): void {
		this.setGlobalSetting("shellPath", path);
	}

	getQuietStartup(): boolean {
		return this.settings.quietStartup ?? false;
	}

	setQuietStartup(quiet: boolean): void {
		this.setGlobalSetting("quietStartup", quiet);
	}

	getShellCommandPrefix(): string | undefined {
		return this.settings.shellCommandPrefix;
	}

	setShellCommandPrefix(prefix: string | undefined): void {
		this.setGlobalSetting("shellCommandPrefix", prefix);
	}

	getCollapseChangelog(): boolean {
		return this.settings.collapseChangelog ?? false;
	}

	setCollapseChangelog(collapse: boolean): void {
		this.setGlobalSetting("collapseChangelog", collapse);
	}

	getToolOutputMode(): "minimal" | "normal" {
		return this.settings.toolOutputMode === "minimal" ? "minimal" : "normal";
	}

	setToolOutputMode(mode: "minimal" | "normal"): void {
		this.setGlobalSetting("toolOutputMode", mode);
	}

	getPackages(): PackageSource[] {
		return [...(this.settings.packages ?? [])];
	}

	setPackages(packages: PackageSource[]): void {
		this.setGlobalSetting("packages", packages);
	}

	setProjectPackages(packages: PackageSource[]): void {
		this.setProjectSetting("packages", packages);
	}

	getExtensionPaths(): string[] {
		return [...(this.settings.extensions ?? [])];
	}

	setExtensionPaths(paths: string[]): void {
		this.setGlobalSetting("extensions", paths);
	}

	setProjectExtensionPaths(paths: string[]): void {
		this.setProjectSetting("extensions", paths);
	}

	getSkillPaths(): string[] {
		return [...(this.settings.skills ?? [])];
	}

	setSkillPaths(paths: string[]): void {
		this.setGlobalSetting("skills", paths);
	}

	setProjectSkillPaths(paths: string[]): void {
		this.setProjectSetting("skills", paths);
	}

	getPromptTemplatePaths(): string[] {
		return [...(this.settings.prompts ?? [])];
	}

	setPromptTemplatePaths(paths: string[]): void {
		this.setGlobalSetting("prompts", paths);
	}

	setProjectPromptTemplatePaths(paths: string[]): void {
		this.setProjectSetting("prompts", paths);
	}

	getThemePaths(): string[] {
		return [...(this.settings.themes ?? [])];
	}

	setThemePaths(paths: string[]): void {
		this.setGlobalSetting("themes", paths);
	}

	setProjectThemePaths(paths: string[]): void {
		this.setProjectSetting("themes", paths);
	}

	getEnableSkillCommands(): boolean {
		return this.settings.enableSkillCommands ?? true;
	}

	setEnableSkillCommands(enabled: boolean): void {
		this.setGlobalSetting("enableSkillCommands", enabled);
	}

	getToolProfile(): "balanced" | "standard" | "full" {
		const profile = this.settings.toolProfile;
		if (profile === "balanced" || profile === "standard" || profile === "full") return profile;
		// Migrate legacy minimal/toolSearch settings to balanced.
		if (this.settings.toolSearch !== undefined) return "balanced";
		return "standard";
	}

	setToolProfile(profile: "balanced" | "standard" | "full"): void {
		this.setGlobalSetting("toolProfile", profile);
		// Keep legacy field in sync with deprecated minimal mode removal.
		this.setGlobalSetting("toolSearch", false);
	}

	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		return this.settings.thinkingBudgets;
	}

	getShowImages(): boolean {
		return this.settings.terminal?.showImages ?? true;
	}

	setShowImages(show: boolean): void {
		this.setNestedGlobalSetting("terminal", "showImages", show);
	}

	getClearOnShrink(): boolean {
		// Settings takes precedence, then env var, then default false
		if (this.settings.terminal?.clearOnShrink !== undefined) {
			return this.settings.terminal.clearOnShrink;
		}
		return process.env.PI_CLEAR_ON_SHRINK === "1";
	}

	setClearOnShrink(enabled: boolean): void {
		this.setNestedGlobalSetting("terminal", "clearOnShrink", enabled);
	}

	getImageAutoResize(): boolean {
		return this.settings.images?.autoResize ?? true;
	}

	setImageAutoResize(enabled: boolean): void {
		this.setNestedGlobalSetting("images", "autoResize", enabled);
	}

	getBlockImages(): boolean {
		return this.settings.images?.blockImages ?? false;
	}

	setBlockImages(blocked: boolean): void {
		this.setNestedGlobalSetting("images", "blockImages", blocked);
	}

	getEnabledModels(): string[] | undefined {
		return this.settings.enabledModels;
	}

	setEnabledModels(patterns: string[] | undefined): void {
		this.setGlobalSetting("enabledModels", patterns);
	}

	getCodexRotate(): boolean {
		return this.settings.codexRotate ?? false;
	}

	setCodexRotate(enabled: boolean): void {
		this.setGlobalSetting("codexRotate", enabled);
	}

	getFastMode(): boolean {
		return this.settings.fastMode ?? false;
	}

	setFastMode(enabled: boolean): void {
		this.setGlobalSetting("fastMode", enabled);
	}

	getCacheTimer(): boolean {
		return this.settings.cacheTimer ?? true;
	}

	setCacheTimer(enabled: boolean): void {
		this.setGlobalSetting("cacheTimer", enabled);
	}

	getPinLastPrompt(): boolean {
		return this.settings.pinLastPrompt ?? false;
	}

	setPinLastPrompt(enabled: boolean): void {
		this.setGlobalSetting("pinLastPrompt", enabled);
	}

	getDoubleEscapeAction(): "fork" | "tree" | "none" {
		return this.settings.doubleEscapeAction ?? "tree";
	}

	setDoubleEscapeAction(action: "fork" | "tree" | "none"): void {
		this.setGlobalSetting("doubleEscapeAction", action);
	}

	getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all" {
		const mode = this.settings.treeFilterMode;
		const valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
		return mode && valid.includes(mode) ? mode : "default";
	}

	setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void {
		this.setGlobalSetting("treeFilterMode", mode);
	}

	getShowHardwareCursor(): boolean {
		return this.settings.showHardwareCursor ?? process.env.PI_HARDWARE_CURSOR === "1";
	}

	setShowHardwareCursor(enabled: boolean): void {
		this.setGlobalSetting("showHardwareCursor", enabled);
	}

	getEditorPaddingX(): number {
		return this.settings.editorPaddingX ?? 0;
	}

	setEditorPaddingX(padding: number): void {
		this.setGlobalSetting("editorPaddingX", Math.max(0, Math.min(3, Math.floor(padding))));
	}

	getAutocompleteMaxVisible(): number {
		return this.settings.autocompleteMaxVisible ?? 5;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.setGlobalSetting("autocompleteMaxVisible", Math.max(3, Math.min(20, Math.floor(maxVisible))));
	}

	getRespectGitignoreInPicker(): boolean {
		return this.settings.respectGitignoreInPicker ?? true;
	}

	setRespectGitignoreInPicker(value: boolean): void {
		this.setGlobalSetting("respectGitignoreInPicker", value);
	}

	getSearchExcludeDirs(): string[] {
		return this.settings.searchExcludeDirs ?? [];
	}

	setSearchExcludeDirs(dirs: string[]): void {
		this.setGlobalSetting("searchExcludeDirs", dirs.filter(Boolean));
	}

	getCodeBlockIndent(): string {
		return this.settings.markdown?.codeBlockIndent ?? "  ";
	}

	getMemorySettings(): {
		enabled: boolean;
		maxRolloutsPerStartup: number;
		maxRolloutAgeDays: number;
		minRolloutIdleHours: number;
		stage1Concurrency: number;
		summaryInjectionTokenLimit: number;
	} {
		return {
			enabled: this.settings.memory?.enabled ?? false,
			maxRolloutsPerStartup: this.settings.memory?.maxRolloutsPerStartup ?? 64,
			maxRolloutAgeDays: this.settings.memory?.maxRolloutAgeDays ?? 30,
			minRolloutIdleHours: this.settings.memory?.minRolloutIdleHours ?? 12,
			stage1Concurrency: this.settings.memory?.stage1Concurrency ?? 8,
			summaryInjectionTokenLimit: this.settings.memory?.summaryInjectionTokenLimit ?? 5000,
		};
	}

	getAsyncEnabled(): boolean {
		return this.settings.async?.enabled ?? false;
	}

	getAsyncMaxJobs(): number {
		return this.settings.async?.maxJobs ?? 100;
	}

	getSandboxSettings(): SandboxSettings {
		return {
			enabled: this.settings.sandbox?.enabled,
			autoAllowBashIfSandboxed: this.settings.sandbox?.autoAllowBashIfSandboxed,
			writableRoots: this.settings.sandbox?.writableRoots ? [...this.settings.sandbox.writableRoots] : undefined,
			readOnlySubpaths: this.settings.sandbox?.readOnlySubpaths ? [...this.settings.sandbox.readOnlySubpaths] : undefined,
			networkEnabled: this.settings.sandbox?.networkEnabled,
			networkMode: this.settings.sandbox?.networkMode,
		};
	}

	setSandboxEnabled(enabled: boolean): void {
		this.setNestedGlobalSetting("sandbox", "enabled", enabled);
	}

	setSandboxNetworkEnabled(enabled: boolean): void {
		this.setNestedGlobalSetting("sandbox", "networkEnabled", enabled);
		this.setNestedGlobalSetting("sandbox", "networkMode", enabled ? "allow" : "deny");
	}

	setSandboxNetworkMode(mode: "allow" | "ask" | "deny"): void {
		this.setNestedGlobalSetting("sandbox", "networkMode", mode);
		this.setNestedGlobalSetting("sandbox", "networkEnabled", mode === "allow");
	}

	getTaskIsolationMode(): "none" | "worktree" | "fuse-overlay" {
		return this.settings.taskIsolation?.mode ?? "none";
	}

	getTaskIsolationMerge(): "patch" | "branch" {
		return this.settings.taskIsolation?.merge ?? "patch";
	}

	getFallbackEnabled(): boolean {
		return this.settings.fallback?.enabled ?? false;
	}

	setFallbackEnabled(enabled: boolean): void {
		this.setNestedGlobalSetting("fallback", "enabled", enabled);
	}

	getFallbackChains(): Record<string, FallbackChainEntry[]> {
		return this.settings.fallback?.chains ?? {};
	}

	getFallbackChain(name: string): FallbackChainEntry[] | undefined {
		return this.settings.fallback?.chains?.[name];
	}

	setFallbackChain(name: string, entries: FallbackChainEntry[]): void {
		if (!this.globalSettings.fallback) {
			this.globalSettings.fallback = {};
		}
		if (!this.globalSettings.fallback.chains) {
			this.globalSettings.fallback.chains = {};
		}
		// Sort by priority
		this.globalSettings.fallback.chains[name] = [...entries].sort((a, b) => a.priority - b.priority);
		this.markModified("fallback");
		this.save();
	}

	removeFallbackChain(name: string): boolean {
		if (!this.globalSettings.fallback?.chains?.[name]) {
			return false;
		}
		delete this.globalSettings.fallback.chains[name];
		if (Object.keys(this.globalSettings.fallback.chains).length === 0) {
			delete this.globalSettings.fallback.chains;
		}
		this.markModified("fallback");
		this.save();
		return true;
	}

	getFallbackSettings(): { enabled: boolean; chains: Record<string, FallbackChainEntry[]> } {
		return {
			enabled: this.getFallbackEnabled(),
			chains: this.getFallbackChains(),
		};
	}

	getModelDiscoverySettings(): ModelDiscoverySettings {
		return this.settings.modelDiscovery ?? {};
	}

	setModelDiscoveryEnabled(enabled: boolean): void {
		this.setNestedGlobalSetting("modelDiscovery", "enabled", enabled);
	}

	getEditMode(): "standard" | "hashline" {
		return this.settings.editMode ?? "standard";
	}

	setEditMode(mode: "standard" | "hashline"): void {
		this.setGlobalSetting("editMode", mode);
	}

	getTimestampFormat(): "date-time-iso" | "date-time-us" {
		return this.settings.timestampFormat ?? "date-time-iso";
	}

	setTimestampFormat(format: "date-time-iso" | "date-time-us"): void {
		this.setGlobalSetting("timestampFormat", format);
	}

	getLspAutoInstall(): boolean {
		return this.settings.lspAutoInstall ?? false;
	}

	setLspAutoInstall(v: boolean): void {
		this.setGlobalSetting("lspAutoInstall", v);
	}

	getLspInstalledServers(): string[] {
		return [...(this.settings.lspInstalledServers ?? [])];
	}

	setLspInstalledServers(v: string[]): void {
		this.setGlobalSetting("lspInstalledServers", v);
	}

	getRtk(): boolean {
		return this.settings.rtk ?? false;
	}

	setRtk(enabled: boolean): void {
		this.setGlobalSetting("rtk", enabled);
	}

	getEditorScheme(): "auto" | "vscode" | "cursor" | "zed" | "jetbrains" | "sublime" | "file" {
		return this.settings.editorScheme ?? "auto";
	}

	setEditorScheme(scheme: "auto" | "vscode" | "cursor" | "zed" | "jetbrains" | "sublime" | "file"): void {
		this.setGlobalSetting("editorScheme", scheme);
	}

	getAutoDream(): boolean {
		return this.settings.autoDream ?? false;
	}

	setAutoDream(enabled: boolean): void {
		this.setGlobalSetting("autoDream", enabled);
	}

	getAutoMemory(): boolean {
		return this.settings.autoMemory ?? false;
	}

	setAutoMemory(enabled: boolean): void {
		this.setGlobalSetting("autoMemory", enabled);
	}

	getNotificationSound(): boolean {
		return this.settings.notificationSound ?? false;
	}

	setNotificationSound(enabled: boolean): void {
		this.setGlobalSetting("notificationSound", enabled);
	}

	getTelegramLiveRelayAutoConnect(): boolean {
		return this.settings.telegramLiveRelayAutoConnect ?? false;
	}

	setTelegramLiveRelayAutoConnect(enabled: boolean): void {
		this.setGlobalSetting("telegramLiveRelayAutoConnect", enabled);
	}
}
