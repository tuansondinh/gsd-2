/**
 * Auto-extract — fire-and-forget background memory extraction.
 *
 * Runs after a session ends: reads the conversation transcript,
 * spawns a headless agent to identify durable facts worth remembering,
 * and writes memory files to the project's memory directory.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getAgentDir } from '@gsd/pi-coding-agent';
import { getMemoryDir } from './memory-paths.js';
import { scanMemoryFiles, formatMemoryManifest } from './memory-scan.js';

/**
 * Build a plain-text transcript from session entries, keeping only
 * human-readable message content (no tool_use / tool_result blocks).
 *
 * Returns an empty string only when there is no user-authored content.
 */
export function buildTranscriptSummary(entries: any[]): string {
  const lines: string[] = [];
  let sawUserMessage = false;

  for (const entry of entries) {
    if (entry.type !== 'message') continue;

    const role = entry.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;

    const raw = entry.message.content;
    let text = '';

    if (typeof raw === 'string') {
      text = raw;
    } else if (Array.isArray(raw)) {
      // Multi-part messages — extract text blocks only, skip tool_use / tool_result
      text = raw
        .filter((part: any) => part.type === 'text' && typeof part.text === 'string')
        .map((part: any) => part.text)
        .join('\n');
    }

    if (!text.trim()) continue;

    if (role === 'user') sawUserMessage = true;

    // Truncate individual messages to keep the transcript manageable
    const truncated = text.length > 2000 ? text.slice(0, 2000) + '…' : text;
    const label = role === 'user' ? 'User' : 'Assistant';
    lines.push(`${label}: ${truncated}`);
  }

  if (!sawUserMessage || lines.length === 0) return '';
  return lines.join('\n\n');
}

/**
 * Build the system prompt that instructs the headless extraction agent
 * on what to save (and what to skip).
 */
export function buildExtractionPrompt(memoryDir: string, transcript: string): string {
  const existing = scanMemoryFiles(memoryDir);
  const manifest = existing.length > 0 ? formatMemoryManifest(existing) : 'None yet';

  return `You are a memory extraction agent for a coding assistant. Read the conversation transcript and save any durable facts worth remembering.

Memory directory: ${memoryDir}
This directory already exists — write files directly.

Rules:
- Save ONLY: user preferences/role, feedback/corrections, project context (deadlines, decisions), external references
- Do NOT save: code patterns, architecture, file paths, git history, debugging steps, ephemeral task details
- Check existing memories below — update existing files rather than creating duplicates
- Use frontmatter: ---\\nname: ...\\ndescription: ...\\ntype: user|feedback|project|reference\\n---
- After writing topic files, update MEMORY.md with one-line index entries
- Be VERY selective — only save things useful in FUTURE conversations
- If nothing is worth saving, do nothing

Existing memories:
${manifest}

Conversation transcript:
${transcript}`;
}

/**
 * Resolve the path to the LSD/GSD CLI entry point.
 * Returns null if no valid CLI binary can be found.
 */
export function resolveCliPath(): string | null {
  // Prefer env vars set by loader.ts — reliable across all invocation styles
  const envPath = process.env.LSD_BIN_PATH || process.env.GSD_BIN_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  // Fallback: the entry point used to launch the current process
  const argv1 = process.argv[1];
  if (argv1 && existsSync(argv1)) return argv1;

  // Last resort: walk up from argv1 to find a bin/ sibling
  if (argv1) {
    const binDir = join(dirname(argv1), '..', 'bin');
    for (const name of ['lsd', 'gsd']) {
      const candidate = join(binDir, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

export function readBudgetMemoryModel(): string | undefined {
  try {
    const settingsPath = join(getAgentDir(), 'settings.json');
    if (!existsSync(settingsPath)) return undefined;
    const raw = readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw) as { budgetSubagentModel?: unknown };
    return typeof parsed.budgetSubagentModel === 'string'
      ? parsed.budgetSubagentModel.trim() || undefined
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Main entry point — called from the session_shutdown hook.
 *
 * Reads the conversation transcript, builds an extraction prompt,
 * and spawns a detached headless agent to process it.
 * Fire-and-forget: the parent can exit without killing the child.
 */
export function extractMemories(ctx: any, cwd: string): void {
  // Guard: prevent recursive extraction
  if (process.env.LSD_MEMORY_EXTRACT === '1') return;

  // Guard: user opt-out
  if (process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY) return;

  const entries = ctx.sessionManager.getEntries();

  // Guard: need at least one user message to extract from
  const userMessageCount = entries.filter(
    (e: any) => e.type === 'message' && e.message?.role === 'user',
  ).length;
  if (userMessageCount < 1) return;

  const transcript = buildTranscriptSummary(entries);
  if (!transcript) return;

  const memoryDir = getMemoryDir(cwd);
  mkdirSync(memoryDir, { recursive: true });

  const prompt = buildExtractionPrompt(memoryDir, transcript);
  const auditPath = join(memoryDir, '.last-auto-extract.txt');
  const logPath = join(memoryDir, '.last-auto-extract.log');

  // Write prompt to a temp file so the spawned agent can read it
  const tmpPromptPath = join(tmpdir(), `lsd-memory-extract-${randomUUID()}.md`);
  writeFileSync(tmpPromptPath, prompt, 'utf-8');

  const cliPath = resolveCliPath();
  const budgetModel = readBudgetMemoryModel();
  if (!cliPath) {
    writeFileSync(
      auditPath,
      [
        `timestamp: ${new Date().toISOString()}`,
        'status: skipped',
        'reason: cli_path_not_found',
        `cwd: ${cwd}`,
        `userMessages: ${userMessageCount}`,
        `transcriptLength: ${transcript.length}`,
        `budgetModel: ${budgetModel ?? 'default'}`,
      ].join('\n') + '\n',
      'utf-8',
    );
    return;
  }

  writeFileSync(
    auditPath,
    [
      `timestamp: ${new Date().toISOString()}`,
      'status: spawning',
      `cwd: ${cwd}`,
      `userMessages: ${userMessageCount}`,
      `transcriptLength: ${transcript.length}`,
      `cliPath: ${cliPath}`,
      `budgetModel: ${budgetModel ?? 'default'}`,
      `logPath: ${logPath}`,
    ].join('\n') + '\n',
    'utf-8',
  );

  const instruction = 'Extract memories from the transcript above. Write any worth-saving memories to the memory directory, then update MEMORY.md.';

  const helperScript = `
const { spawn } = require('node:child_process');
const { appendFileSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const [cliPath, cwd, tmpPromptPath, auditPath, logPath, memoryDir, instruction, model, userMessageCount, transcriptLength] = process.argv.slice(1);
const startedAt = new Date().toISOString();
let finalized = false;
let sawSessionEnded = false;
let sessionEndTimer = null;
let hardTimeout = null;
let pendingLogText = '';

function flushLogText(text, force = false) {
  pendingLogText += text;
  const parts = pendingLogText.split(/\r?\n/);
  pendingLogText = force ? '' : (parts.pop() ?? '');

  const kept = [];
  for (const rawLine of parts) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^\[phase\]\s+cache-timer\s*$/.test(line)) continue;
    kept.push(rawLine);
    if (/^\[agent\]\s+Session ended/.test(line)) {
      sawSessionEnded = true;
    }
  }

  if (kept.length > 0) appendFileSync(logPath, kept.join('\n') + '\n');
  if (sawSessionEnded && !sessionEndTimer) {
    sessionEndTimer = setTimeout(() => {
      finalize('finished', 0, null, 'session_end_detected');
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000).unref();
    }, 1500);
    sessionEndTimer.unref();
  }
}

function appendLog(chunk) {
  try {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
    flushLogText(text, false);
  } catch {}
}

function writeAudit(status, extra = []) {
  try {
    writeFileSync(auditPath, [
      'timestamp: ' + new Date().toISOString(),
      'status: ' + status,
      'cwd: ' + cwd,
      'userMessages: ' + userMessageCount,
      'transcriptLength: ' + transcriptLength,
      'cliPath: ' + cliPath,
      'model: ' + (model || 'default'),
      'logPath: ' + logPath,
      ...extra,
    ].join('\\n') + '\\n', 'utf-8');
  } catch {}
}

function newestMemoryMtime(dir) {
  try {
    const names = readdirSync(dir).filter((name) => !name.startsWith('.'));
    let max = 0;
    for (const name of names) {
      const full = join(dir, name);
      const mtime = statSync(full).mtimeMs;
      if (mtime > max) max = mtime;
    }
    return max;
  } catch {
    return 0;
  }
}

function finalize(status, code, signal, completionReason) {
  if (finalized) return;
  finalized = true;
  if (sessionEndTimer) clearTimeout(sessionEndTimer);
  if (hardTimeout) clearTimeout(hardTimeout);
  const afterMtime = newestMemoryMtime(memoryDir);
  const logText = existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '';
  const saved = afterMtime > beforeMtime;
  const result = saved
    ? 'saved_memory'
    : /nothing worth saving/i.test(logText)
      ? 'nothing_worth_saving'
      : 'no_memory_changes';
  writeAudit(status, [
    'exitCode: ' + String(code),
    'signal: ' + String(signal),
    'result: ' + result,
    'completionReason: ' + completionReason,
  ]);
}

const beforeMtime = newestMemoryMtime(memoryDir);
writeFileSync(logPath, '', 'utf-8');
writeAudit('running', ['startedAt: ' + startedAt]);

const childArgs = [cliPath, 'headless'];
if (model) childArgs.push('--model', model);
childArgs.push('--bare', '--context', tmpPromptPath, '--context-text', instruction);

const child = spawn(
  process.execPath,
  childArgs,
  { cwd, env: { ...process.env, LSD_MEMORY_EXTRACT: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
);

hardTimeout = setTimeout(() => {
  finalize('failed', null, 'timeout', sawSessionEnded ? 'hung_after_session_end' : 'timeout');
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000).unref();
}, 120000);
hardTimeout.unref();

child.stdout.on('data', appendLog);
child.stderr.on('data', appendLog);
child.on('error', (err) => {
  appendLog(String(err && err.stack ? err.stack : err) + '\\n');
  flushLogText('', true);
  finalize('failed', null, 'spawn_error', String(err && err.message ? err.message : err));
});
child.on('exit', (code, signal) => {
  flushLogText('', true);
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
      instruction,
      budgetModel ?? '',
      String(userMessageCount),
      String(transcript.length),
    ],
    {
      cwd,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    },
  );
  proc.unref();

  writeFileSync(
    auditPath,
    [
      `timestamp: ${new Date().toISOString()}`,
      'status: spawned',
      `pid: ${proc.pid ?? 'unknown'}`,
      `cwd: ${cwd}`,
      `userMessages: ${userMessageCount}`,
      `transcriptLength: ${transcript.length}`,
      `cliPath: ${cliPath}`,
      `model: ${budgetModel ?? 'default'}`,
      `logPath: ${logPath}`,
    ].join('\n') + '\n',
    'utf-8',
  );

  // Clean up the temp file after the child has had time to read it
  setTimeout(() => {
    try {
      unlinkSync(tmpPromptPath);
    } catch {
      // Already cleaned up or inaccessible — safe to ignore
    }
  }, 120_000).unref();
}
