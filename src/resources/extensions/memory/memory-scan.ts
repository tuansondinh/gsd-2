/**
 * Memory scanner — reads .md topic files from a memory directory,
 * parses YAML frontmatter, and returns structured headers.
 *
 * All operations are synchronous (runs during prompt building in extension hooks).
 * Errors are handled gracefully — never throws, returns empty results on failure.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface MemoryHeader {
  /** Relative path within the memory directory */
  filename: string;
  /** Absolute path on disk */
  filePath: string;
  /** Last-modified timestamp (ms since epoch) */
  mtimeMs: number;
  /** Description from frontmatter, or null */
  description: string | null;
  /** Topic type from frontmatter */
  type: 'user' | 'feedback' | 'project' | 'reference' | undefined;
}

/** Maximum number of memory files to return */
const MAX_MEMORY_FILES = 200;

/** Only read the first 2KB of each file for frontmatter extraction */
const FRONTMATTER_MAX_BYTES = 2048;

const VALID_TYPES = new Set(['user', 'feedback', 'project', 'reference']);

/**
 * Parse YAML frontmatter from the beginning of a markdown string.
 * Expects `---\n` delimiters. Returns an empty object on malformed input.
 */
export function parseFrontmatter(content: string): {
  name?: string;
  description?: string;
  type?: string;
} {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return {};

  const endIdx = content.indexOf('\n---', 4);
  if (endIdx === -1) return {};

  const block = content.slice(4, endIdx);
  const result: Record<string, string> = {};
  const lineRe = /^(\w+):\s*(.+)$/;

  for (const line of block.split('\n')) {
    const m = line.trim().match(lineRe);
    if (m) result[m[1]] = m[2];
  }

  return result;
}

/**
 * Scan a memory directory for `.md` topic files, parse their frontmatter,
 * and return structured headers sorted by modification time (newest first).
 */
export function scanMemoryFiles(memoryDir: string): MemoryHeader[] {
  let entries: string[];
  try {
    entries = readdirSync(memoryDir, { recursive: true }) as string[];
  } catch {
    return [];
  }

  const headers: MemoryHeader[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.md') || basename(entry) === 'MEMORY.md') continue;

    const filePath = join(memoryDir, entry);
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;

      const raw = readFileSync(filePath);
      const snippet = raw.slice(0, FRONTMATTER_MAX_BYTES).toString('utf-8');

      const fm = parseFrontmatter(snippet);
      const rawType = fm.type?.toLowerCase();

      headers.push({
        filename: entry,
        filePath,
        mtimeMs: stat.mtimeMs,
        description: fm.description ?? null,
        type: VALID_TYPES.has(rawType as string)
          ? (rawType as MemoryHeader['type'])
          : undefined,
      });
    } catch {
      // Skip unreadable files
    }
  }

  headers.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return headers.slice(0, MAX_MEMORY_FILES);
}

/**
 * Format an array of memory headers into a human-readable manifest string.
 * One line per memory: `- [type] filename (ISO-date): description`
 */
export function formatMemoryManifest(memories: MemoryHeader[]): string {
  return memories
    .map((m) => {
      const tag = m.type ? `[${m.type}] ` : '';
      const date = new Date(m.mtimeMs).toISOString().slice(0, 10);
      const desc = m.description ? `: ${m.description}` : '';
      return `- ${tag}${m.filename} (${date})${desc}`;
    })
    .join('\n');
}
