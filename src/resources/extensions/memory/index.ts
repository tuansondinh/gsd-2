/**
 * Memory Extension — persistent, file-based memory for LSD agents.
 *
 * Bootstraps a per-project memory directory, injects the memory system prompt
 * into every agent turn, and registers /memories, /remember, /forget commands.
 *
 * Memory files live under ~/.lsd/memory/<sanitized-project-path>/ and are
 * indexed by a MEMORY.md entrypoint that is always loaded into context.
 */

import {
	isToolCallEventType,
	type ExtensionAPI,
} from '@gsd/pi-coding-agent';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { getMemoryDir, getMemoryEntrypoint, ensureMemoryDir } from './memory-paths.js';
import {
	MEMORY_FRONTMATTER_EXAMPLE,
	TYPES_SECTION,
	WHAT_NOT_TO_SAVE_SECTION,
	WHEN_TO_ACCESS_SECTION,
	TRUSTING_RECALL_SECTION,
} from './memory-types.js';
import { scanMemoryFiles } from './memory-scan.js';
import { memoryAge } from './memory-age.js';
import { extractMemories } from './auto-extract.js';
import {
	formatDreamStatus,
	isMaintenanceModeToolAllowed,
	maybeStartAutoDream,
	readAutoDreamSettings,
	setProjectAutoDreamEnabled,
	startDream,
} from './dream.js';

// ── Constants ────────────────────────────────────────────────────────

/** Maximum number of lines loaded from MEMORY.md into context. */
const MAX_ENTRYPOINT_LINES = 200;

/** Maximum byte size loaded from MEMORY.md into context. */
const MAX_ENTRYPOINT_BYTES = 25_000;

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Truncate the raw MEMORY.md content to stay within context-window limits.
 *
 * Applies two caps in order:
 *   1. Line count (MAX_ENTRYPOINT_LINES)
 *   2. Byte size  (MAX_ENTRYPOINT_BYTES)
 *
 * If either cap triggers, a warning footer is appended so the agent knows
 * the index was trimmed.
 */
function truncateEntrypointContent(raw: string): {
	content: string;
	wasTruncated: boolean;
} {
	let wasTruncated = false;
	let content = raw.trim();
	const lines = content.split('\n');

	// Cap 1: line count
	if (lines.length > MAX_ENTRYPOINT_LINES) {
		content = lines.slice(0, MAX_ENTRYPOINT_LINES).join('\n');
		wasTruncated = true;
	}

	// Cap 2: byte size
	if (Buffer.byteLength(content, 'utf-8') > MAX_ENTRYPOINT_BYTES) {
		// Walk backwards to find the last newline within budget
		let cutoff = content.length;
		while (Buffer.byteLength(content.slice(0, cutoff), 'utf-8') > MAX_ENTRYPOINT_BYTES) {
			const idx = content.lastIndexOf('\n', cutoff - 1);
			cutoff = idx > 0 ? idx : 0;
		}
		content = content.slice(0, cutoff);
		wasTruncated = true;
	}

	if (wasTruncated) {
		content +=
			'\n\n> WARNING: MEMORY.md is too large. Only part was loaded. Keep index entries concise.';
	}

	return { content, wasTruncated };
}

/**
 * Build the full memory system prompt that is injected via before_agent_start.
 *
 * @param memoryDir  Absolute path to the project's memory directory.
 * @param entrypointContent  The (possibly truncated) contents of MEMORY.md.
 */
function buildMemoryPrompt(memoryDir: string, entrypointContent: string): string {
	const sections: string[] = [];

	// ── Header ──
	sections.push(`# Memory

You have a persistent, file-based memory system at \`${memoryDir}\`.
This directory already exists — write to it directly with the file write tool (do not run mkdir or check existence).

Build up this memory over time so future conversations have a complete picture of who the user is, how they'd like to collaborate, what to avoid or repeat, and the context behind their work.

If the user explicitly asks you to remember something, save it immediately. If they ask you to forget, find and remove it.`);

	// ── Types ──
	sections.push(TYPES_SECTION.join('\n'));

	// ── What not to save ──
	sections.push(WHAT_NOT_TO_SAVE_SECTION.join('\n'));

	// ── How to save ──
	sections.push(`## How to save memories

Saving a memory is a two-step process:

**Step 1** — write the memory to its own file (e.g., \`user_role.md\`, \`feedback_testing.md\`) using this frontmatter format:

${MEMORY_FRONTMATTER_EXAMPLE.join('\n')}

**Step 2** — add a pointer to that file in \`MEMORY.md\`. Each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. Never write memory content directly into \`MEMORY.md\`.

- \`MEMORY.md\` is always loaded into your context — lines after ${MAX_ENTRYPOINT_LINES} will be truncated
- Keep name, description, and type fields up-to-date
- Organize semantically, not chronologically
- Update or remove stale memories
- Check for existing memories before writing duplicates`);

	// ── When to access ──
	sections.push(WHEN_TO_ACCESS_SECTION.join('\n'));

	// ── Trusting recall ──
	sections.push(TRUSTING_RECALL_SECTION.join('\n'));

	// ── Entrypoint content ──
	const body =
		entrypointContent.trim() ||
		'Your MEMORY.md is currently empty. When you save new memories, they will appear here.';
	sections.push(`## MEMORY.md\n\n${body}`);

	return sections.join('\n\n');
}

// ── Extension entry point ────────────────────────────────────────────

/**
 * Memory extension for LSD.
 *
 * Lifecycle:
 *   session_start      → bootstrap memory directory & MEMORY.md
 *   before_agent_start → inject memory system prompt
 *   turn_end           → check auto-dream gates and start background consolidation
 *   session_shutdown   → fire-and-forget auto-extract of new memories
 *
 * Commands:
 *   /memories    — list all saved memories
 *   /remember    — save a memory immediately
 *   /forget      — remove a memory by topic
 *   /dream       — run memory consolidation now or show dream status
 *   /auto-dream  — enable/disable/show auto-dream status
 */
export default function memoryExtension(pi: ExtensionAPI) {
	let memoryCwd: string = '';
	let memoryDir: string = '';

	// ── session_start: bootstrap memory directory ──────────────────────
	pi.on('session_start', async (_event, ctx) => {
		memoryCwd = ctx.cwd;
		memoryDir = getMemoryDir(memoryCwd);
		ensureMemoryDir(memoryCwd);

		// Create MEMORY.md if it doesn't exist
		const entrypoint = getMemoryEntrypoint(memoryCwd);
		if (!existsSync(entrypoint)) {
			writeFileSync(entrypoint, '', 'utf-8');
		}
	});

	// ── before_agent_start: inject memory prompt into system prompt ───
	pi.on('before_agent_start', async (event) => {
		if (!memoryCwd) return;

		const entrypoint = getMemoryEntrypoint(memoryCwd);
		let entrypointContent = '';
		try {
			entrypointContent = readFileSync(entrypoint, 'utf-8');
		} catch {
			// File may have been deleted between session_start and now
		}

		if (entrypointContent.trim()) {
			const { content } = truncateEntrypointContent(entrypointContent);
			entrypointContent = content;
		}

		const prompt = buildMemoryPrompt(memoryDir, entrypointContent);

		return {
			systemPrompt: event.systemPrompt + '\n\n' + prompt,
		};
	});

	// ── turn_end: check auto-dream gates ───────────────────────────────
	pi.on('turn_end', async (_event, ctx) => {
		if (!memoryCwd) return;
		const result = maybeStartAutoDream(ctx);
		if (result.started) {
			pi.sendMessage({
				customType: 'memory:auto-dream',
				content: result.message,
				display: true,
			});
		}
	});

	// ── tool_call: restrict background maintenance workers ─────────────
	pi.on('tool_call', async (event, ctx) => {
		if (!(process.env.LSD_MEMORY_EXTRACT === '1' || process.env.LSD_MEMORY_DREAM === '1')) return;

		if (isMaintenanceModeToolAllowed(event.toolName, event.input as { path?: string; command?: string }, ctx.cwd)) {
			return;
		}

		if (isToolCallEventType('write', event) || isToolCallEventType('edit', event)) {
			return {
				block: true,
				reason: `Memory maintenance workers may only write inside the memory directory. Blocked path: ${event.input.path}`,
			};
		}

		if (isToolCallEventType('bash', event)) {
			return {
				block: true,
				reason: 'Memory maintenance workers may only run read-only bash commands.',
			};
		}

		return {
			block: true,
			reason: `Tool ${event.toolName} is blocked for memory maintenance workers.`,
		};
	});

	// ── session_shutdown: trigger auto-extract ────────────────────────
	pi.on('session_shutdown', async (_event, ctx) => {
		if (!memoryCwd) return;
		// Don't extract if this IS the extraction or dream worker
		if (process.env.LSD_MEMORY_EXTRACT === '1' || process.env.LSD_MEMORY_DREAM === '1') return;
		try {
			extractMemories(ctx, memoryCwd);
		} catch {
			// Fire-and-forget — never block shutdown
		}
	});

	// ── Slash commands ────────────────────────────────────────────────

	/**
	 * /memories — list all saved memories with type, age, and description.
	 */
	pi.registerCommand('memories', {
		description: 'List all saved memories',
		handler: async (_args, ctx) => {
			if (!memoryCwd) {
				ctx.ui?.notify('No memory directory initialized', 'warning');
				return;
			}
			const memories = scanMemoryFiles(memoryDir);
			if (memories.length === 0) {
				pi.sendUserMessage(
					"No memories saved yet. I'll start building memory as we work together.",
				);
				return;
			}
			const lines = memories.map((m) => {
				const age = memoryAge(m.mtimeMs);
				const type = m.type ? `[${m.type}]` : '';
				const desc = m.description ? ` — ${m.description}` : '';
				return `- ${type} **${m.filename}** (${age})${desc}`;
			});
			pi.sendUserMessage(`Here are your saved memories:\n\n${lines.join('\n')}`);
		},
	});

	/**
	 * /remember <text> — ask the agent to save a memory immediately.
	 */
	pi.registerCommand('remember', {
		description: 'Save a memory immediately',
		handler: async (args) => {
			if (!memoryCwd) return;
			const text = args.trim();
			if (!text) return;
			pi.sendUserMessage(`Please save this to memory: ${text}`);
		},
	});

	/**
	 * /forget <topic> — ask the agent to find and remove a memory.
	 */
	pi.registerCommand('forget', {
		description: 'Forget/remove a memory',
		handler: async (args) => {
			if (!memoryCwd) return;
			const topic = args.trim();
			if (!topic) return;
			pi.sendUserMessage(`Please find and remove any memories about: ${topic}`);
		},
	});

	/**
	 * /dream — run a consolidation pass now, or show dream status.
	 */
	pi.registerCommand('dream', {
		description: 'Run memory consolidation now or show dream status',
		handler: async (args, ctx) => {
			if (!memoryCwd) return;
			const subcommand = args.trim().toLowerCase();
			if (subcommand === 'status') {
				pi.sendMessage({
					customType: 'memory:dream-status',
					content: formatDreamStatus(ctx),
					display: true,
				});
				return;
			}

			const result = startDream(ctx, { trigger: 'manual' });
			pi.sendMessage({
				customType: 'memory:dream',
				content: result.message,
				display: true,
			});
		},
	});

	/**
	 * /auto-dream — enable, disable, or inspect project auto-dream.
	 */
	pi.registerCommand('auto-dream', {
		description: 'Enable, disable, or show project auto-dream status',
		handler: async (args, ctx) => {
			if (!memoryCwd) return;
			const subcommand = args.trim().toLowerCase();

			if (subcommand === 'on') {
				const settings = setProjectAutoDreamEnabled(memoryCwd, true);
				pi.sendMessage({
					customType: 'memory:auto-dream-settings',
					content: `Auto-dream enabled for this project. Thresholds: ${settings.minHours}h / ${settings.minSessions} sessions.`,
					display: true,
				});
				return;
			}

			if (subcommand === 'off') {
				const settings = setProjectAutoDreamEnabled(memoryCwd, false);
				pi.sendMessage({
					customType: 'memory:auto-dream-settings',
					content: `Auto-dream disabled for this project. Thresholds remain ${settings.minHours}h / ${settings.minSessions} sessions.`,
					display: true,
				});
				return;
			}

			const settings = readAutoDreamSettings(memoryCwd);
			pi.sendMessage({
				customType: 'memory:auto-dream-status',
				content: [
					'Auto-Dream Settings',
					'',
					`- Enabled: ${settings.enabled ? 'yes' : 'no'}`,
					`- Thresholds: ${settings.minHours}h / ${settings.minSessions} sessions`,
					'',
					formatDreamStatus(ctx),
				].join('\n'),
				display: true,
			});
		},
	});
}
