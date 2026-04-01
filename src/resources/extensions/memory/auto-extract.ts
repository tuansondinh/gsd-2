/**
 * Auto-extract — fire-and-forget background memory extraction.
 *
 * Runs after a session ends: reads the conversation transcript,
 * spawns a headless agent to identify durable facts worth remembering,
 * and writes memory files to the project's memory directory.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getMemoryDir } from './memory-paths.js';
import { scanMemoryFiles, formatMemoryManifest } from './memory-scan.js';

/**
 * Build a plain-text transcript from session entries, keeping only
 * human-readable message content (no tool_use / tool_result blocks).
 *
 * Returns an empty string if the transcript has fewer than 3 messages.
 */
export function buildTranscriptSummary(entries: any[]): string {
  const lines: string[] = [];

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

    // Truncate individual messages to keep the transcript manageable
    const truncated = text.length > 2000 ? text.slice(0, 2000) + '…' : text;
    const label = role === 'user' ? 'User' : 'Assistant';
    lines.push(`${label}: ${truncated}`);
  }

  if (lines.length < 3) return '';
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
  // Primary: the entry point used to launch the current process
  const argv1 = process.argv[1];
  if (argv1 && existsSync(argv1)) return argv1;

  // Fallback: walk up from argv1 to find a bin/ sibling
  if (argv1) {
    const binDir = join(dirname(argv1), '..', 'bin');
    for (const name of ['lsd', 'gsd']) {
      const candidate = join(binDir, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
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

  // Guard: need enough user messages to be worth extracting
  const userMessageCount = entries.filter(
    (e: any) => e.type === 'message' && e.message?.role === 'user',
  ).length;
  if (userMessageCount < 3) return;

  const transcript = buildTranscriptSummary(entries);
  if (!transcript) return;

  const memoryDir = getMemoryDir(cwd);
  mkdirSync(memoryDir, { recursive: true });

  const prompt = buildExtractionPrompt(memoryDir, transcript);

  // Write prompt to a temp file so the spawned agent can read it
  const tmpPromptPath = join(tmpdir(), `lsd-memory-extract-${randomUUID()}.md`);
  writeFileSync(tmpPromptPath, prompt, 'utf-8');

  const cliPath = resolveCliPath();
  if (!cliPath) return;

  const proc = spawn(
    process.execPath,
    [
      cliPath,
      'headless',
      '--bare',
      '--context',
      tmpPromptPath,
      '--context-text',
      'Extract memories from the transcript above. Write any worth-saving memories to the memory directory, then update MEMORY.md.',
    ],
    {
      cwd,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, LSD_MEMORY_EXTRACT: '1' },
    },
  );
  proc.unref();

  // Clean up the temp file after the child has had time to read it
  setTimeout(() => {
    try {
      unlinkSync(tmpPromptPath);
    } catch {
      // Already cleaned up or inaccessible — safe to ignore
    }
  }, 120_000).unref();
}
