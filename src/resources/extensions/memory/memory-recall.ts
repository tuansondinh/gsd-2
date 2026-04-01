/**
 * Memory recall — finds relevant memories for a given user query
 * by asking a fast LLM to select from available memory headers.
 *
 * Supports both Anthropic and OpenAI APIs via direct `fetch()` calls.
 * Gracefully falls back to empty results when no API key is available
 * or when the LLM call fails for any reason.
 */

import { scanMemoryFiles, formatMemoryManifest, type MemoryHeader } from './memory-scan.js';

export interface RelevantMemory {
  /** Absolute path to the memory file */
  path: string;
  /** Last-modified timestamp (ms since epoch) */
  mtimeMs: number;
}

const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to a coding agent as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a JSON object with a single key "selected_memories" containing an array of filenames (up to 5) that will clearly be useful. Only include memories you are certain will be helpful. If none are relevant, return an empty array.

Example response: {"selected_memories": ["user_role.md", "feedback_testing.md"]}`;

/** Timeout for LLM API calls (ms) */
const API_TIMEOUT_MS = 15_000;

/**
 * Find memories relevant to a user query by asking an LLM to select
 * from the available memory headers.
 *
 * @param query - The user's query or message
 * @param memoryDir - Absolute path to the memory directory
 * @param alreadySurfaced - Set of file paths that have already been surfaced (to avoid duplicates)
 * @returns Array of relevant memories with path and modification time
 */
export async function findRelevantMemories(
  query: string,
  memoryDir: string,
  alreadySurfaced?: Set<string>,
): Promise<RelevantMemory[]> {
  const allMemories = scanMemoryFiles(memoryDir);

  // Filter out already-surfaced paths
  const memories = alreadySurfaced?.size
    ? allMemories.filter((m) => !alreadySurfaced.has(m.filePath))
    : allMemories;

  if (memories.length === 0) return [];

  const selectedFilenames = await selectRelevantMemories(query, memories);
  if (selectedFilenames.length === 0) return [];

  // Build a lookup from filename → header for O(1) mapping
  const byFilename = new Map<string, MemoryHeader>();
  for (const m of memories) byFilename.set(m.filename, m);

  const results: RelevantMemory[] = [];
  for (const filename of selectedFilenames) {
    const header = byFilename.get(filename);
    if (header) {
      results.push({ path: header.filePath, mtimeMs: header.mtimeMs });
    }
  }

  return results;
}

/**
 * Ask an LLM to select the most relevant memory filenames for a query.
 * Tries Anthropic first (if ANTHROPIC_API_KEY is set), then OpenAI.
 * Returns an empty array on any failure.
 */
async function selectRelevantMemories(
  query: string,
  memories: MemoryHeader[],
): Promise<string[]> {
  const manifest = formatMemoryManifest(memories);
  const validFilenames = new Set(memories.map((m) => m.filename));

  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return [];

  const userMessage = `User query:\n${query}\n\nAvailable memories:\n${manifest}`;

  try {
    const isAnthropic = !!process.env.ANTHROPIC_API_KEY;
    const selected = isAnthropic
      ? await callAnthropic(apiKey, userMessage)
      : await callOpenAI(apiKey, userMessage);

    // Only return filenames that actually exist in the scanned memories
    return selected.filter((f) => validFilenames.has(f));
  } catch {
    return [];
  }
}

/**
 * Call the Anthropic Messages API to select relevant memories.
 */
async function callAnthropic(apiKey: string, userMessage: string): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 256,
        system: SELECT_MEMORIES_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!res.ok) return [];

    const body = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = body.content?.find((b) => b.type === 'text')?.text ?? '';
    return parseSelectedMemories(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call the OpenAI Chat Completions API to select relevant memories.
 */
async function callOpenAI(apiKey: string, userMessage: string): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 256,
        messages: [
          { role: 'system', content: SELECT_MEMORIES_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
      }),
    });

    if (!res.ok) return [];

    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = body.choices?.[0]?.message?.content ?? '';
    return parseSelectedMemories(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse the LLM response text to extract the `selected_memories` array.
 * Handles both clean JSON and JSON wrapped in markdown code fences.
 */
function parseSelectedMemories(text: string): string[] {
  // Strip markdown code fences if present
  const cleaned = text.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '');

  const parsed = JSON.parse(cleaned) as { selected_memories?: unknown };
  if (!Array.isArray(parsed.selected_memories)) return [];

  return parsed.selected_memories.filter(
    (item: unknown): item is string => typeof item === 'string',
  );
}
