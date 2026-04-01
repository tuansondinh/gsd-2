/**
 * Memory type taxonomy for the LSD memory extension.
 *
 * Defines the four memory categories, a parser, frontmatter template,
 * and guidance sections that are injected into the agent system prompt.
 */

/** The four canonical memory types. */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;

/** A single memory type. */
export type MemoryType = (typeof MEMORY_TYPES)[number];

/**
 * Parse an unknown value into a {@link MemoryType}.
 * Returns `undefined` when the value is not a recognised type string.
 */
export function parseMemoryType(raw: unknown): MemoryType | undefined {
  if (typeof raw !== 'string') return undefined;
  return MEMORY_TYPES.find(t => t === raw);
}

/** Example frontmatter block shown to the agent when creating memories. */
export const MEMORY_FRONTMATTER_EXAMPLE: readonly string[] = [
  '```markdown',
  '---',
  'name: {{memory name}}',
  'description: {{one-line description — used to decide relevance in future conversations, so be specific}}',
  `type: {{${MEMORY_TYPES.join(', ')}}}`,
  '---',
  '',
  '{{memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines}}',
  '```',
];

// ---------------------------------------------------------------------------
// Guidance sections – injected into the system prompt so the agent knows
// how to categorise, recall, and trust memories.
// ---------------------------------------------------------------------------

/** Describes each memory type with when-to-save guidance and examples. */
export const TYPES_SECTION: readonly string[] = [
  '<types>',
  '',
  '**user** — Personal preferences, conventions, and workflow habits.',
  'Save when the user states a preference or corrects your behaviour.',
  'Example: "User prefers single quotes and no semicolons in TypeScript."',
  '',
  '**feedback** — Explicit corrections or praise about agent behaviour.',
  'Save when the user says "remember this", "don\'t do that again", or gives direct feedback.',
  'Example: "When refactoring, never rename public API symbols without asking first.',
  '**Why:** Renaming broke downstream consumers last time.',
  '**How to apply:** Always confirm public renames before executing."',
  '',
  '**project** — Architecture decisions, repo conventions, and domain knowledge.',
  'Save when you discover non-obvious project structure or the user explains a design choice.',
  'Example: "All API routes live under src/api/ and must export a default handler.',
  '**Why:** The deploy pipeline relies on this convention for tree-shaking.',
  '**How to apply:** When creating new endpoints, place them in src/api/ with a default export."',
  '',
  '**reference** — Useful facts, links, snippets, or documentation pointers.',
  'Save when the user shares a reference they may need again or you find a useful resource.',
  'Example: "The internal design-tokens spec lives at https://wiki.internal/tokens-v3."',
  '',
  '</types>',
];

/** Things that should NOT be saved as memories. */
export const WHAT_NOT_TO_SAVE_SECTION: readonly string[] = [
  '<what_not_to_save>',
  '',
  '- Raw code snippets or implementation details — they belong in source files, not memories.',
  '- Git history, commit messages, or PR descriptions — already tracked by version control.',
  '- One-off debugging solutions unlikely to recur (e.g. "ran npm cache clean to fix install").',
  '- Anything already captured in lsd.md or project README — avoid duplication.',
  '- Ephemeral task details: ticket numbers, branch names, WIP progress, or session-specific context.',
  '',
  '</what_not_to_save>',
];

/** When the agent should access (recall) memories. */
export const WHEN_TO_ACCESS_SECTION: readonly string[] = [
  '<when_to_access>',
  '',
  '- When a recalled memory is directly relevant to the current task or question.',
  '- When the user explicitly asks "what do you remember about X?".',
  '- When the user says "ignore memories" or "forget that" → proceed as if the memory store is empty for this session.',
  '',
  '**Drift caveat:** Memories are frozen at the time they were written.',
  'Project structure, file paths, and code patterns may have changed since.',
  'Always treat recalled memories as *hints*, not ground truth — verify against current code before acting.',
  '',
  '</when_to_access>',
];

/** How much to trust recalled memories. */
export const TRUSTING_RECALL_SECTION: readonly string[] = [
  '<trusting_recall>',
  '',
  '- Before recommending a file or function mentioned in a memory, verify it still exists (e.g. read/ls).',
  '- Grep for named entities (components, routes, config keys) before asserting they are present.',
  '- Memory summaries are frozen in time — treat file:line citations as approximate, not authoritative.',
  '- When a memory conflicts with what you observe in the codebase, trust the codebase.',
  '',
  '</trusting_recall>',
];
