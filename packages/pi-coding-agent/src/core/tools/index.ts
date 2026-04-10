export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	bashTool,
	createBashTool,
	rewriteBackgroundCommand,
} from "./bash.js";
export {
	type BashInterceptorRule,
	checkBashInterception,
	type CompiledInterceptor,
	compileInterceptor,
	DEFAULT_BASH_INTERCEPTOR_RULES,
	type InterceptionResult,
} from "./bash-interceptor.js";
export {
	createEditTool,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
	editTool,
} from "./edit.js";
export {
	createFindTool,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
	findTool,
} from "./find.js";
export {
	createGrepTool,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
	grepTool,
} from "./grep.js";
export {
	createLsTool,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
	lsTool,
} from "./ls.js";
export {
	createReadTool,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
	readTool,
} from "./read.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";
export {
	createWriteTool,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
	writeTool,
} from "./write.js";
export {
	createHashlineEditTool,
	type HashlineEditInput,
	type HashlineEditItem,
	type HashlineEditOperations,
	type HashlineEditToolDetails,
	type HashlineEditToolOptions,
	hashlineEditTool,
} from "./hashline-edit.js";
export {
	createHashlineReadTool,
	type HashlineReadOperations,
	type HashlineReadToolDetails,
	type HashlineReadToolInput,
	type HashlineReadToolOptions,
	hashlineReadTool,
} from "./hashline-read.js";
export {
	createPtyTools,
	type PtyKillInput,
	type PtyReadInput,
	type PtyResizeInput,
	type PtySendInput,
	type PtyStartInput,
	type PtyToolDetails,
	type PtyWaitInput,
	ptyToolNames,
} from "./pty.js";
export {
	type Anchor,
	applyHashlineEdits,
	computeLineHash,
	formatHashLines,
	formatLineTag,
	type HashlineEdit,
	HashlineMismatchError,
	parseHashlineText,
	type HashMismatch,
	parseTag,
	stripNewLinePrefixes,
	validateLineRef,
} from "./hashline.js";
export {
	createLspTool,
	type LspToolDetails,
	lspSchema,
	lspTool,
} from "../lsp/index.js";
export type { LspServerStatus } from "../lsp/client.js";

import type { AgentTool } from "@gsd/pi-agent-core";
import { type BashToolOptions, bashTool, createBashTool } from "./bash.js";
import { createEditTool, editTool } from "./edit.js";
import { createFindTool, findTool } from "./find.js";
import { createGrepTool, grepTool } from "./grep.js";
import { createHashlineEditTool, hashlineEditTool } from "./hashline-edit.js";
import { createHashlineReadTool, hashlineReadTool } from "./hashline-read.js";
import { createLsTool, lsTool } from "./ls.js";
import { createPtyTools } from "./pty.js";
import { createReadTool, type ReadToolOptions, readTool } from "./read.js";
import { createWriteTool, writeTool } from "./write.js";
import { createLspTool, lspTool } from "../lsp/index.js";

/** Tool type (AgentTool from pi-ai) */
export type Tool = AgentTool<any>;

// Default tools for full access mode (using process.cwd())
export const codingTools: Tool[] = [readTool, bashTool, editTool, writeTool];

// Read-only tools for exploration without modification (using process.cwd())
export const readOnlyTools: Tool[] = [readTool, grepTool, findTool, lsTool];

const ptyBuiltinTools = createPtyTools(process.cwd());

/** Write raw input to an active agent PTY session. Used by the UI for user-controlled focus. */
export const writeToPtySession: (sessionId: string, input: string) => void = ptyBuiltinTools.writeToSession;

// All available tools (using process.cwd())
export const allTools = {
	read: readTool,
	bash: bashTool,
	edit: editTool,
	write: writeTool,
	grep: grepTool,
	find: findTool,
	ls: lsTool,
	lsp: lspTool,
	hashline_edit: hashlineEditTool,
	hashline_read: hashlineReadTool,
	pty_start: ptyBuiltinTools.pty_start,
	pty_send: ptyBuiltinTools.pty_send,
	pty_read: ptyBuiltinTools.pty_read,
	pty_wait: ptyBuiltinTools.pty_wait,
	pty_resize: ptyBuiltinTools.pty_resize,
	pty_kill: ptyBuiltinTools.pty_kill,
};

// Hashline-mode coding tools — read with hash anchors, edit with hash references
export const hashlineCodingTools: Tool[] = [hashlineReadTool, bashTool, hashlineEditTool, writeTool];

export type ToolName = keyof typeof allTools;

export interface ToolsOptions {
	/** Options for the read tool */
	read?: ReadToolOptions;
	/** Options for the bash tool */
	bash?: BashToolOptions;
}

function addPtyTools<T extends Record<string, Tool>>(target: T, cwd: string): T & Record<string, Tool> {
	const ptyTools = createPtyTools(cwd);
	return {
		...target,
		pty_start: ptyTools.pty_start,
		pty_send: ptyTools.pty_send,
		pty_read: ptyTools.pty_read,
		pty_wait: ptyTools.pty_wait,
		pty_resize: ptyTools.pty_resize,
		pty_kill: ptyTools.pty_kill,
	};
}

/**
 * Create coding tools configured for a specific working directory.
 */
export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd),
		createWriteTool(cwd),
	];
}

/**
 * Create read-only tools configured for a specific working directory.
 */
export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [createReadTool(cwd, options?.read), createGrepTool(cwd), createFindTool(cwd), createLsTool(cwd)];
}

/**
 * Create all tools configured for a specific working directory.
 */
export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return addPtyTools({
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
		lsp: createLspTool(cwd),
		hashline_edit: createHashlineEditTool(cwd),
		hashline_read: createHashlineReadTool(cwd, options?.read),
	}, cwd) as Record<ToolName, Tool>;
}

/**
 * Create hashline-mode coding tools configured for a specific working directory.
 * Uses hashline read (LINE#ID prefixed output) and hashline edit (hash-anchor based edits).
 */
export function createHashlineCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createHashlineReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createHashlineEditTool(cwd),
		createWriteTool(cwd),
	];
}
