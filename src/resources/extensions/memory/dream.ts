import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionContext } from '@gsd/pi-coding-agent';
import { getMemoryDir } from './memory-paths.js';
import { readBudgetMemoryModel, resolveCliPath } from './auto-extract.js';

export interface AutoDreamSettings {
    enabled: boolean;
    minHours: number;
    minSessions: number;
}

export interface DreamStartResult {
    started: boolean;
    status: 'started' | 'skipped' | 'busy';
    message: string;
}

const DEFAULT_AUTO_DREAM_SETTINGS: AutoDreamSettings = {
    enabled: false,
    minHours: 24,
    minSessions: 5,
};

const LOCK_FILE = '.consolidate-lock';
const AUDIT_FILE = '.last-dream.txt';
const LOG_FILE = '.last-dream.log';
const HOLDER_STALE_MS = 60 * 60 * 1000;
const SESSION_SCAN_INTERVAL_MS = 10 * 60 * 1000;
const READ_ONLY_BASH_RE = /^\s*(cat|head|tail|less|more|wc|file|stat|du|df|which|type|echo|printf|ls|find|grep|rg|awk|sed\b(?!.*-i)|sort|uniq|diff|comm|tr|cut)\b/;

let lastAutoDreamScanAt = 0;

function getProjectSettingsPath(cwd: string): string {
    return join(cwd, CONFIG_DIR_NAME, 'settings.json');
}

function readJsonFile(path: string): Record<string, unknown> {
    try {
        if (!existsSync(path)) return {};
        const raw = readFileSync(path, 'utf-8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

function parseAutoDreamSettings(source: Record<string, unknown>): Partial<AutoDreamSettings> {
    const memory = source.memory;
    if (!memory || typeof memory !== 'object') return {};

    const settings = memory as {
        autoDream?: unknown;
        autoDreamMinHours?: unknown;
        autoDreamMinSessions?: unknown;
    };

    return {
        enabled:
            typeof settings.autoDream === 'boolean'
                ? settings.autoDream
                : DEFAULT_AUTO_DREAM_SETTINGS.enabled,
        minHours:
            typeof settings.autoDreamMinHours === 'number' && Number.isFinite(settings.autoDreamMinHours)
                ? Math.max(1, settings.autoDreamMinHours)
                : DEFAULT_AUTO_DREAM_SETTINGS.minHours,
        minSessions:
            typeof settings.autoDreamMinSessions === 'number' && Number.isFinite(settings.autoDreamMinSessions)
                ? Math.max(1, Math.floor(settings.autoDreamMinSessions))
                : DEFAULT_AUTO_DREAM_SETTINGS.minSessions,
    };
}

export function readAutoDreamSettings(cwd: string): AutoDreamSettings {
    const global = parseAutoDreamSettings(readJsonFile(join(getAgentDir(), 'settings.json')));
    const project = parseAutoDreamSettings(readJsonFile(getProjectSettingsPath(cwd)));

    return {
        ...DEFAULT_AUTO_DREAM_SETTINGS,
        ...global,
        ...project,
    };
}

export function setProjectAutoDreamEnabled(cwd: string, enabled: boolean): AutoDreamSettings {
    const settingsPath = getProjectSettingsPath(cwd);
    const next = readJsonFile(settingsPath);
    const memory = next.memory && typeof next.memory === 'object'
        ? { ...(next.memory as Record<string, unknown>) }
        : {};

    memory.autoDream = enabled;
    next.memory = memory;

    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(next, null, 2) + '\n', 'utf-8');

    return readAutoDreamSettings(cwd);
}

function getLockPath(memoryDir: string): string {
    return join(memoryDir, LOCK_FILE);
}

function getAuditPath(memoryDir: string): string {
    return join(memoryDir, AUDIT_FILE);
}

function getLogPath(memoryDir: string): string {
    return join(memoryDir, LOG_FILE);
}

export function readLastConsolidatedAt(memoryDir: string): number {
    try {
        return statSync(getLockPath(memoryDir)).mtimeMs;
    } catch {
        return 0;
    }
}

function isConsolidationInProgress(memoryDir: string): boolean {
    const lockPath = getLockPath(memoryDir);
    try {
        const stat = statSync(lockPath);
        if (Date.now() - stat.mtimeMs > HOLDER_STALE_MS) return false;
        const pid = Number.parseInt(readFileSync(lockPath, 'utf-8').trim(), 10);
        if (!Number.isFinite(pid) || pid <= 0) return false;
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

export function tryAcquireConsolidationLock(memoryDir: string): number | null {
    mkdirSync(memoryDir, { recursive: true });
    const lockPath = getLockPath(memoryDir);
    let priorMtime = 0;

    try {
        priorMtime = statSync(lockPath).mtimeMs;
    } catch {
        priorMtime = 0;
    }

    if (isConsolidationInProgress(memoryDir)) {
        return null;
    }

    writeFileSync(lockPath, String(process.pid), 'utf-8');
    return priorMtime;
}

function parseAuditFile(path: string): Record<string, string> {
    try {
        const raw = readFileSync(path, 'utf-8');
        const result: Record<string, string> = {};
        for (const line of raw.split(/\r?\n/)) {
            const idx = line.indexOf(':');
            if (idx === -1) continue;
            const key = line.slice(0, idx).trim();
            const value = line.slice(idx + 1).trim();
            if (key) result[key] = value;
        }
        return result;
    } catch {
        return {};
    }
}

function listSessionsTouchedSince(
    sessionDir: string,
    sinceMs: number,
    currentSessionFile?: string,
): string[] {
    try {
        const files = readdirSync(sessionDir)
            .filter((name) => name.endsWith('.jsonl'))
            .map((name) => join(sessionDir, name));

        return files.filter((file) => {
            if (currentSessionFile && resolve(file) === resolve(currentSessionFile)) return false;
            try {
                return statSync(file).mtimeMs > sinceMs;
            } catch {
                return false;
            }
        });
    } catch {
        return [];
    }
}

function isPathInsideDir(targetPath: string, dir: string): boolean {
    const resolvedDir = resolve(dir);
    const resolvedTarget = resolve(targetPath);
    return resolvedTarget === resolvedDir || resolvedTarget.startsWith(resolvedDir + '/');
}

export function listBrokenMemoryIndexEntries(memoryDir: string): string[] {
    const entrypoint = join(memoryDir, 'MEMORY.md');
    try {
        const raw = readFileSync(entrypoint, 'utf-8');
        const broken = new Set<string>();
        const linkRe = /\[[^\]]+\]\(([^)]+)\)/g;

        for (const match of raw.matchAll(linkRe)) {
            const href = match[1]?.trim();
            if (!href || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;

            const target = isAbsolute(href) ? resolve(href) : resolve(memoryDir, href);
            if (!isPathInsideDir(target, memoryDir)) {
                broken.add(href);
                continue;
            }
            if (!existsSync(target)) {
                broken.add(href);
            }
        }

        return [...broken].sort();
    } catch {
        return [];
    }
}

export function pruneBrokenMemoryIndexEntries(memoryDir: string): string[] {
    const entrypoint = join(memoryDir, 'MEMORY.md');
    try {
        const raw = readFileSync(entrypoint, 'utf-8');
        const broken = new Set(listBrokenMemoryIndexEntries(memoryDir));
        if (broken.size === 0) return [];

        const keptLines = raw
            .split(/\r?\n/)
            .filter((line) => {
                const match = line.match(/\[[^\]]+\]\(([^)]+)\)/);
                if (!match) return true;
                const href = match[1]?.trim();
                return href ? !broken.has(href) : true;
            });

        const next = keptLines.join('\n').replace(/\n*$/, '\n');
        writeFileSync(entrypoint, next, 'utf-8');
        return [...broken].sort();
    } catch {
        return [];
    }
}

export function buildConsolidationPrompt(memoryDir: string, sessionDir: string): string {
    return `# Dream: Memory Consolidation

You are performing a dream — a reflective pass over existing memory files. Improve the memory store so future sessions can orient quickly and trust what they read.

Memory directory: ${memoryDir}
Session transcripts: ${sessionDir}

The memory system prompt already defines the memory file format, allowed memory types, and what not to save. Follow that as the source of truth.

## Phase 1 — Orient
- List the memory directory and inspect MEMORY.md first
- Skim existing topic files before creating anything new
- Prefer improving existing files over creating near-duplicates
- Validate every MEMORY.md link and repair or remove broken pointers

## Phase 2 — Gather recent signal
- Review recent session transcripts only as needed
- Search transcripts narrowly for concrete terms instead of reading them exhaustively
- Look for drift, contradictions, stale wording, duplicate memories, and stale index entries

## Phase 3 — Consolidate
- Merge duplicate or overlapping memories
- Update existing memories with clearer and more durable wording
- Convert relative dates like “yesterday” into absolute dates when they matter
- Remove contradicted, stale, or superseded facts
- Keep only durable information that will help in future conversations

## Phase 4 — Prune and index
- Keep MEMORY.md as a concise index, not a content dump
- Each MEMORY.md entry should stay to one short line
- Remove pointers to stale or deleted memories
- Resolve contradictions between files instead of leaving both versions in place

## Tooling constraints
- When using write or edit, always target absolute paths inside ${memoryDir}
- Do not use relative write/edit paths like MEMORY.md or user_identity.md because they resolve against the repo cwd, not the memory directory

## Guardrails
- Only modify files inside the memory directory
- Do not edit project source files
- Use bash only for read-only inspection
- If the memory store is already in good shape, make no changes and say so

Return a short summary of what you consolidated, updated, pruned, or left unchanged.`;
}

function writeAudit(
    memoryDir: string,
    fields: Record<string, string | number | boolean | undefined>,
): void {
    const lines = Object.entries(fields)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}: ${String(value)}`);
    writeFileSync(getAuditPath(memoryDir), lines.join('\n') + '\n', 'utf-8');
}

function startDetachedDreamProcess(
    cwd: string,
    memoryDir: string,
    sessionDir: string,
    trigger: 'manual' | 'auto',
    priorMtime: number,
    sessionCount: number,
): DreamStartResult {
    const cliPath = resolveCliPath();
    const budgetModel = readBudgetMemoryModel();
    const auditPath = getAuditPath(memoryDir);
    const logPath = getLogPath(memoryDir);

    if (!cliPath) {
        writeAudit(memoryDir, {
            timestamp: new Date().toISOString(),
            status: 'skipped',
            trigger,
            reason: 'cli_path_not_found',
            cwd,
            memoryDir,
            sessionDir,
            sessionsSinceLastConsolidation: sessionCount,
        });
        return {
            started: false,
            status: 'skipped',
            message: 'Dream skipped because the CLI path could not be resolved.',
        };
    }

    const prompt = buildConsolidationPrompt(memoryDir, sessionDir);
    const tmpPromptPath = join(tmpdir(), `lsd-memory-dream-${randomUUID()}.md`);
    writeFileSync(tmpPromptPath, prompt, 'utf-8');
    writeAudit(memoryDir, {
        timestamp: new Date().toISOString(),
        status: 'spawning',
        trigger,
        cwd,
        memoryDir,
        sessionDir,
        sessionsSinceLastConsolidation: sessionCount,
        cliPath,
        model: budgetModel ?? 'default',
        logPath,
    });

    const instruction = 'Perform a dream consolidation pass over the memory directory. Only update memory files and MEMORY.md if they genuinely need consolidation.';

    const helperScript = String.raw`
const { spawn } = require('node:child_process');
const {
	appendFileSync,
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} = require('node:fs');
const { join, delimiter } = require('node:path');

const [cliPath, cwd, tmpPromptPath, auditPath, logPath, memoryDir, sessionDir, instruction, model, trigger, priorMtime, sessionCount] = process.argv.slice(1);
let finalized = false;
let pendingLogText = '';

function newestMemoryMtime(dir) {
	try {
		const names = readdirSync(dir, { recursive: true });
		let newest = 0;
		for (const name of names) {
			const parts = String(name).split(/[\\/]/).filter(Boolean);
			if (parts.some((part) => part.startsWith('.'))) continue;
			const full = join(dir, String(name));
			try {
				const stat = statSync(full);
				if (stat.isFile() && stat.mtimeMs > newest) newest = stat.mtimeMs;
			} catch {}
		}
		return newest;
	} catch {
		return 0;
	}
}

function isPathInsideDir(targetPath, dir) {
	try {
		const resolvedDir = require('node:path').resolve(dir);
		const resolvedTarget = require('node:path').resolve(targetPath);
		return resolvedTarget === resolvedDir || resolvedTarget.startsWith(resolvedDir + '/');
	} catch {
		return false;
	}
}

function listBrokenMemoryRefs(dir) {
	try {
		const entrypoint = join(dir, 'MEMORY.md');
		const raw = readFileSync(entrypoint, 'utf-8');
		const broken = new Set();
		const linkRe = /\[[^\]]+\]\(([^)]+)\)/g;
		for (const match of raw.matchAll(linkRe)) {
			const href = String(match[1] || '').trim();
			if (!href || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
			const target = require('node:path').isAbsolute(href)
				? require('node:path').resolve(href)
				: require('node:path').resolve(dir, href);
			if (!isPathInsideDir(target, dir) || !existsSync(target)) broken.add(href);
		}
		return Array.from(broken).sort();
	} catch {
		return [];
	}
}

function pruneBrokenMemoryRefs(dir) {
	try {
		const entrypoint = join(dir, 'MEMORY.md');
		const raw = readFileSync(entrypoint, 'utf-8');
		const broken = new Set(listBrokenMemoryRefs(dir));
		if (broken.size === 0) return [];
		const kept = raw
			.split(/\r?\n/)
			.filter((line) => {
				const match = line.match(/\[[^\]]+\]\(([^)]+)\)/);
				if (!match) return true;
				const href = String(match[1] || '').trim();
				return href ? !broken.has(href) : true;
			});
		writeFileSync(entrypoint, kept.join('\n').replace(/\n*$/, '\n'), 'utf-8');
		return Array.from(broken).sort();
	} catch {
		return [];
	}
}

function writeAudit(status, extra = []) {
	try {
		writeFileSync(auditPath, [
			'timestamp: ' + new Date().toISOString(),
			'status: ' + status,
			'trigger: ' + trigger,
			'cwd: ' + cwd,
			'memoryDir: ' + memoryDir,
			'sessionDir: ' + sessionDir,
			'sessionsSinceLastConsolidation: ' + sessionCount,
			'cliPath: ' + cliPath,
			'model: ' + (model || 'default'),
			'logPath: ' + logPath,
			...extra,
		].join('\n') + '\n', 'utf-8');
	} catch {}
}

function rollbackLock() {
	const lockPath = join(memoryDir, '.consolidate-lock');
	try {
		const prior = Number(priorMtime);
		if (!Number.isFinite(prior) || prior <= 0) {
			if (existsSync(lockPath)) unlinkSync(lockPath);
			return;
		}
		writeFileSync(lockPath, '', 'utf-8');
		const t = prior / 1000;
		utimesSync(lockPath, t, t);
	} catch {}
}

function flushLogText(text, force = false) {
	pendingLogText += text;
	const parts = pendingLogText.split(/\r?\n/);
	pendingLogText = force ? '' : (parts.pop() ?? '');
	const kept = parts.filter((line) => line.trim());
	if (kept.length > 0) appendFileSync(logPath, kept.join('\n') + '\n');
}

function appendLog(chunk) {
	try {
		const text = Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
		flushLogText(text, false);
	} catch {}
}

function finalize(status, code, signal, completionReason) {
	if (finalized) return;
	finalized = true;
	flushLogText('', true);
	const beforeBrokenRefs = listBrokenMemoryRefs(memoryDir);
	const prunedRefs = beforeBrokenRefs.length > 0 ? pruneBrokenMemoryRefs(memoryDir) : [];
	const afterMtime = newestMemoryMtime(memoryDir);
	const brokenRefs = listBrokenMemoryRefs(memoryDir);
	const result = brokenRefs.length > 0
		? 'broken_memory_index'
		: afterMtime > beforeMtime
			? 'updated_memory'
			: 'no_memory_changes';
	if (status !== 'finished') rollbackLock();
	writeAudit(status, [
		'exitCode: ' + String(code),
		'signal: ' + String(signal),
		'result: ' + result,
		'brokenRefsPrunedCount: ' + String(prunedRefs.length),
		...(prunedRefs.length > 0 ? ['brokenRefsPruned: ' + prunedRefs.join(', ')] : []),
		'brokenRefsCount: ' + String(brokenRefs.length),
		...(brokenRefs.length > 0 ? ['brokenRefs: ' + brokenRefs.join(', ')] : []),
		'completionReason: ' + completionReason,
	]);
	try { unlinkSync(tmpPromptPath); } catch {}
}

const beforeMtime = newestMemoryMtime(memoryDir);
const lockPath = join(memoryDir, '.consolidate-lock');
try { writeFileSync(lockPath, String(process.pid), 'utf-8'); } catch {}
writeFileSync(logPath, '', 'utf-8');
writeAudit('running');

const childArgs = [cliPath, 'headless'];
const bundledPaths = Array.from(
	new Set(
		[process.env.GSD_BUNDLED_EXTENSION_PATHS, process.env.LSD_BUNDLED_EXTENSION_PATHS]
			.filter(Boolean)
			.flatMap((value) => String(value).split(delimiter).map((entry) => entry.trim()).filter(Boolean)),
	),
);
for (const extensionPath of bundledPaths) childArgs.push('--extension', extensionPath);
if (model) childArgs.push('--model', model);
childArgs.push('--bare', '--context', tmpPromptPath, '--context-text', instruction);

const child = spawn(process.execPath, childArgs, {
	cwd,
	env: { ...process.env, LSD_MEMORY_DREAM: '1' },
	stdio: ['ignore', 'pipe', 'pipe'],
});

const hardTimeout = setTimeout(() => {
	finalize('failed', null, 'timeout', 'timeout');
	try { child.kill('SIGTERM'); } catch {}
	setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000).unref();
}, 180000);
hardTimeout.unref();

child.stdout.on('data', appendLog);
child.stderr.on('data', appendLog);
child.on('error', (err) => {
	appendLog(String(err && err.stack ? err.stack : err) + '\n');
	clearTimeout(hardTimeout);
	finalize('failed', null, 'spawn_error', String(err && err.message ? err.message : err));
});
child.on('exit', (code, signal) => {
	clearTimeout(hardTimeout);
	finalize(code === 0 ? 'finished' : 'failed', code, signal, 'child_exit');
});
`;

    const proc = spawn(
        process.execPath,
        [
            '-e',
            helperScript,
            cliPath,
            cwd,
            tmpPromptPath,
            auditPath,
            logPath,
            memoryDir,
            sessionDir,
            instruction,
            budgetModel ?? '',
            trigger,
            String(priorMtime),
            String(sessionCount),
        ],
        {
            cwd,
            detached: true,
            stdio: 'ignore',
            env: process.env,
        },
    );
    proc.unref();

    writeAudit(memoryDir, {
        timestamp: new Date().toISOString(),
        status: 'spawned',
        trigger,
        pid: proc.pid ?? 'unknown',
        cwd,
        memoryDir,
        sessionDir,
        sessionsSinceLastConsolidation: sessionCount,
        cliPath,
        model: budgetModel ?? 'default',
        logPath,
    });

    setTimeout(() => {
        try {
            unlinkSync(tmpPromptPath);
        } catch {
            // Best-effort cleanup only.
        }
    }, 180_000).unref();

    return {
        started: true,
        status: 'started',
        message:
            trigger === 'auto'
                ? `Auto-dream started in the background (${sessionCount} sessions since the last consolidation).`
                : 'Dream started in the background.',
    };
}

export function startDream(
    ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>,
    options?: {
        trigger?: 'manual' | 'auto';
        force?: boolean;
        sessionCountHint?: number;
    },
): DreamStartResult {
    if (process.env.LSD_MEMORY_EXTRACT === '1' || process.env.LSD_MEMORY_DREAM === '1') {
        return {
            started: false,
            status: 'skipped',
            message: 'Dream is unavailable from inside a maintenance worker.',
        };
    }

    const trigger = options?.trigger ?? 'manual';
    const memoryDir = getMemoryDir(ctx.cwd);
    const sessionDir = ctx.sessionManager.getSessionDir();
    const currentSessionFile = ctx.sessionManager.getSessionFile();
    const sessionCount =
        options?.sessionCountHint ??
        listSessionsTouchedSince(sessionDir, readLastConsolidatedAt(memoryDir), currentSessionFile).length;

    const priorMtime = tryAcquireConsolidationLock(memoryDir);
    if (priorMtime === null) {
        return {
            started: false,
            status: 'busy',
            message: 'A dream consolidation is already running.',
        };
    }

    return startDetachedDreamProcess(ctx.cwd, memoryDir, sessionDir, trigger, priorMtime, sessionCount);
}

export function maybeStartAutoDream(
    ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>,
): DreamStartResult {
    if (process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY) {
        return {
            started: false,
            status: 'skipped',
            message: 'Auto-memory is disabled.',
        };
    }

    if (process.env.LSD_MEMORY_EXTRACT === '1' || process.env.LSD_MEMORY_DREAM === '1') {
        return {
            started: false,
            status: 'skipped',
            message: 'Maintenance workers do not schedule auto-dream.',
        };
    }

    const settings = readAutoDreamSettings(ctx.cwd);
    if (!settings.enabled) {
        return {
            started: false,
            status: 'skipped',
            message: 'Auto-dream is disabled.',
        };
    }

    const memoryDir = getMemoryDir(ctx.cwd);
    const lastAt = readLastConsolidatedAt(memoryDir);
    const hoursSince = lastAt > 0 ? (Date.now() - lastAt) / 3_600_000 : Number.POSITIVE_INFINITY;
    if (hoursSince < settings.minHours) {
        return {
            started: false,
            status: 'skipped',
            message: `Only ${hoursSince.toFixed(1)}h since the last dream; need ${settings.minHours}h.`,
        };
    }

    const sinceLastScan = Date.now() - lastAutoDreamScanAt;
    if (sinceLastScan < SESSION_SCAN_INTERVAL_MS) {
        return {
            started: false,
            status: 'skipped',
            message: 'Auto-dream scan throttled.',
        };
    }
    lastAutoDreamScanAt = Date.now();

    const sessionFiles = listSessionsTouchedSince(
        ctx.sessionManager.getSessionDir(),
        lastAt,
        ctx.sessionManager.getSessionFile(),
    );
    if (sessionFiles.length < settings.minSessions) {
        return {
            started: false,
            status: 'skipped',
            message: `Only ${sessionFiles.length} sessions since the last dream; need ${settings.minSessions}.`,
        };
    }

    return startDream(ctx, {
        trigger: 'auto',
        sessionCountHint: sessionFiles.length,
    });
}

export function formatDreamStatus(
    ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>,
): string {
    const memoryDir = getMemoryDir(ctx.cwd);
    const settings = readAutoDreamSettings(ctx.cwd);
    const audit = parseAuditFile(getAuditPath(memoryDir));
    const lastAt = readLastConsolidatedAt(memoryDir);
    const sessionsSince = listSessionsTouchedSince(
        ctx.sessionManager.getSessionDir(),
        lastAt,
        ctx.sessionManager.getSessionFile(),
    ).length;

    const lines = [
        'Dream Status',
        '',
        `- Memory directory: ${memoryDir}`,
        `- Auto-dream enabled: ${settings.enabled ? 'yes' : 'no'}`,
        `- Thresholds: ${settings.minHours}h / ${settings.minSessions} sessions`,
        `- Last consolidated at: ${lastAt > 0 ? new Date(lastAt).toISOString() : 'never'}`,
        `- Sessions since last consolidation: ${sessionsSince}`,
        `- Dream currently running: ${isConsolidationInProgress(memoryDir) ? 'yes' : 'no'}`,
    ];

    if (Object.keys(audit).length > 0) {
        lines.push('', 'Last recorded dream run:');
        for (const key of [
            'timestamp',
            'status',
            'trigger',
            'result',
            'brokenRefsCount',
            'brokenRefs',
            'completionReason',
            'pid',
            'model',
            'logPath',
        ]) {
            if (audit[key]) {
                lines.push(`- ${key}: ${audit[key]}`);
            }
        }
    } else {
        lines.push('', '- No dream audit file found yet.');
    }

    return lines.join('\n');
}

export function isMaintenanceModeToolAllowed(toolName: string, input?: { path?: string; command?: string }, cwd?: string): boolean {
    if (!(process.env.LSD_MEMORY_EXTRACT === '1' || process.env.LSD_MEMORY_DREAM === '1')) {
        return true;
    }

    if (toolName === 'read' || toolName === 'grep' || toolName === 'find' || toolName === 'ls') {
        return true;
    }

    if ((toolName === 'write' || toolName === 'edit') && input?.path && cwd) {
        const targetPath = isAbsolute(input.path) ? resolve(input.path) : resolve(cwd, input.path);
        return isPathInsideDir(targetPath, getMemoryDir(cwd));
    }

    if (toolName === 'bash' && input?.command) {
        return READ_ONLY_BASH_RE.test(input.command);
    }

    return false;
}

export const __testing = {
    listBrokenMemoryIndexEntries,
    pruneBrokenMemoryIndexEntries,
    parseAutoDreamSettings,
    listSessionsTouchedSince,
    readJsonFile,
};
