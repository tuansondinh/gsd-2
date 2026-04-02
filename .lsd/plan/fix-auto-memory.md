# Fix Auto Memory

## Problem

Auto memory extraction is completely broken — MEMORY.md is always empty. The system never successfully extracts or persists memories from conversations.

## Root Cause Analysis

There are **two independent memory systems** in the codebase that are out of sync:

### 1. LSD's custom `auto-extract.ts` (src/resources/extensions/memory/)
This is what LSD actually uses. It fires on `session_shutdown` and spawns a detached headless agent to extract memories. **It is broken because:**

- **Bug 1 (fatal): Headless ignores `--context` for non-`new-milestone` commands.**
  `extractMemories()` spawns: `lsd headless --bare --context <tmpfile> --context-text "Extract memories..."`. But `parseHeadlessArgs` assigns no positional command after `headless`, so `options.command` defaults to `'auto'`. The `--context` loading code (headless.ts ~L287-313) is gated behind `if (isNewMilestone)` — so the extraction transcript is **never loaded**. The spawned agent ends up running `/gsd auto` with no context.

- **Bug 2 (fatal): `.gsd/` directory check blocks non-GSD projects.**
  At headless.ts ~L319-322, non-`new-milestone` commands check for `.gsd/` directory and `process.exit(1)` if missing. LSD projects without `.gsd/` will always fail silently (stdio: 'ignore').

- **Bug 3 (minor): `resolveCliPath()` is fragile.**
  Falls back to walking `argv[1]` paths, but `process.argv[1]` may not exist in all invocation contexts (e.g., npx, linked binaries). Should use `LSD_BIN_PATH` env var set by `loader.ts`.

### 2. Upstream pi-coding-agent `pipeline.ts` (packages/pi-coding-agent/src/resources/extensions/memory/)
A more sophisticated SQLite-backed pipeline with phase 1 (per-session extraction) and phase 2 (consolidation). Uses direct LLM API calls instead of spawning a headless agent. **This is never wired into LSD** — it exists in the pi-coding-agent package but LSD's memory extension in `src/` overrides it entirely.

## Proposed Fix

**Approach: Fix the headless spawning approach** (not migrate to pipeline.ts).

The pipeline.ts approach requires SQLite (sql.js) dependency and a more complex storage layer. The headless spawning approach is architecturally simpler and already 90% there — it just has the bugs above. Fix those bugs.

### Changes

#### 1. `src/resources/extensions/memory/auto-extract.ts` — Fix `resolveCliPath()`

**Before:**
```ts
export function resolveCliPath(): string | null {
  const argv1 = process.argv[1];
  if (argv1 && existsSync(argv1)) return argv1;
  // ... fallback walks
  return null;
}
```

**After:**
```ts
export function resolveCliPath(): string | null {
  // Prefer the env var set by loader.ts — reliable across all invocations
  const envPath = process.env.LSD_BIN_PATH || process.env.GSD_BIN_PATH;
  if (envPath && existsSync(envPath)) return envPath;
  
  // Fallback to argv[1]
  const argv1 = process.argv[1];
  if (argv1 && existsSync(argv1)) return argv1;
  
  return null;
}
```

#### 2. `src/resources/extensions/memory/auto-extract.ts` — Fix spawn args

The extraction agent should NOT use `headless` mode at all. It should send the prompt directly as a user message instead of going through the headless command router.

**Before:**
```ts
const proc = spawn(
  process.execPath,
  [
    cliPath,
    'headless',
    '--bare',
    '--context',
    tmpPromptPath,
    '--context-text',
    'Extract memories from the transcript above...',
  ],
  { cwd, detached: true, stdio: 'ignore', env: { ...process.env, LSD_MEMORY_EXTRACT: '1' } },
);
```

**After — Option A (recommended): Use `--print` mode with piped prompt:**

Instead of headless mode, use `--print` mode (or a simple approach where we pipe the prompt via stdin). But actually, the cleanest fix is to make headless mode properly support `--context` for all commands, not just `new-milestone`.

**After — Option B (cleanest): Fix headless.ts to support `--context` generically:**

This is the better fix. The `--context` flag should work for ANY headless command, not just `new-milestone`.

#### 3. `src/headless.ts` — Support `--context` for all commands (not just new-milestone)

Move the context loading out of the `isNewMilestone` block so it applies to all commands.

When `--context` and/or `--context-text` are provided for non-`new-milestone` commands:
- Load the context content
- Send it as the initial prompt to the agent (instead of `/gsd <command>`)
- OR prepend it to the system prompt via `appendSystemPrompt`

The extraction agent doesn't need `/gsd auto` — it needs to receive the extraction prompt as a user message and have the agent act on it.

**Concrete change:**
```ts
// After client.start() and init(), instead of always sending `/gsd <command>`:

let promptMessage: string;
if (options.context || options.contextText) {
  const contextContent = await loadContext(options);
  // For bare mode with context, send the context as the prompt directly
  if (options.bare) {
    promptMessage = contextContent;
  } else {
    // Write context to runtime dir for extensions to read, then send command
    // ... existing new-milestone logic ...
    promptMessage = command;
  }
} else {
  promptMessage = command;
}

await client.prompt(promptMessage);
```

Wait — this is overcomplicating it. Let me look at what the extraction agent actually needs:

The extraction agent needs to:
1. Start a bare agent (no lsd.md, no project context, no extensions)
2. Receive the extraction prompt as its input
3. Have access to file write tools to write memory files
4. Exit after processing

The simplest fix is to **change `auto-extract.ts` to send the prompt differently**. Looking at the spawned CLI args again: `lsd headless --bare --context <file> --context-text "..."` — this is missing a command. The `headless` subcommand expects a positional command argument.

#### Revised Plan

**File 1: `src/headless.ts`** — Add generic `--context` support for all commands

In `runHeadlessOnce`, move context loading before the `.gsd/` directory check and support it generically:

```diff
- // For new-milestone, load context and bootstrap .gsd/ before spawning RPC child
- if (isNewMilestone) {
-   if (!options.context && !options.contextText) { ... }
-   let contextContent = await loadContext(options)
-   // ... bootstrap .gsd/ ...
-   writeFileSync(join(runtimeDir, 'headless-context.md'), contextContent, 'utf-8')
- }
- 
- const gsdDir = join(process.cwd(), '.gsd')
- if (!isNewMilestone && !existsSync(gsdDir)) { ... exit(1) }

+ // Load context if provided
+ let contextContent: string | undefined
+ if (options.context || options.contextText) {
+   try {
+     contextContent = await loadContext(options)
+   } catch (err) {
+     process.stderr.write(`[headless] Error loading context: ${err}\n`)
+     process.exit(1)
+   }
+ }
+
+ // For new-milestone, bootstrap .gsd/ and write context to runtime dir
+ if (isNewMilestone) {
+   if (!contextContent) {
+     process.stderr.write('[headless] Error: new-milestone requires --context or --context-text\n')
+     process.exit(1)
+   }
+   const gsdDir = join(process.cwd(), '.gsd')
+   if (!existsSync(gsdDir)) {
+     bootstrapGsdProject(process.cwd())
+   }
+   const runtimeDir = join(gsdDir, 'runtime')
+   mkdirSync(runtimeDir, { recursive: true })
+   writeFileSync(join(runtimeDir, 'headless-context.md'), contextContent, 'utf-8')
+ }
+
+ // Validate .gsd/ directory (skip for new-milestone and bare+context mode)
+ const gsdDir = join(process.cwd(), '.gsd')
+ if (!isNewMilestone && !options.bare && !existsSync(gsdDir)) {
+   process.stderr.write('[headless] Error: No .gsd/ directory found.\n')
+   process.exit(1)
+ }
```

Then, when sending the prompt, use context as the message if bare mode with context:

```diff
- const command = `/gsd ${options.command}...`
- await client.prompt(command)
+ let promptMessage: string
+ if (options.bare && contextContent) {
+   // Bare + context = send context directly as the user prompt
+   // (used by memory extraction, dream, etc.)
+   const contextTextSuffix = options.contextText && !options.context
+     ? '' // contextText IS the prompt
+     : options.contextText
+       ? `\n\n${options.contextText}`
+       : ''
+   promptMessage = contextContent + contextTextSuffix
+ } else {
+   promptMessage = `/gsd ${options.command}${options.commandArgs.length > 0 ? ' ' + options.commandArgs.join(' ') : ''}`
+ }
+ await client.prompt(promptMessage)
```

**File 2: `src/resources/extensions/memory/auto-extract.ts`** — Fix `resolveCliPath()`

Use `LSD_BIN_PATH` / `GSD_BIN_PATH` env vars as primary resolution.

**File 3: `src/resources/extensions/memory/auto-extract.ts`** — Fix spawn command

The spawn args need to include a proper command. Since we're fixing headless to support bare+context generically, we just need to make sure the args are structured correctly. The current args actually work IF headless handles bare+context properly (which fix #1 addresses). The command defaults to `'auto'` which is fine — the bare+context path will bypass it.

BUT we should also ensure `--context-text` is the extraction instruction that gets appended to the context file content. Currently the args pass both `--context <file>` (the transcript) and `--context-text "Extract memories..."` (the instruction). The headless fix needs to combine these properly.

### Test Plan

1. **Unit test `resolveCliPath()`** — verify it uses env vars first
2. **Integration test the full extraction flow** — mock session entries, verify memory files are created
3. **Manual test** — run a session with 3+ user messages, exit, check that MEMORY.md is populated

### Files Modified

| File | Change |
|------|--------|
| `src/headless.ts` | Support `--context` for all commands, not just new-milestone. Skip `.gsd/` check for bare+context mode. Combine context file + contextText as prompt in bare mode. |
| `src/resources/extensions/memory/auto-extract.ts` | Fix `resolveCliPath()` to use `LSD_BIN_PATH` env var. |

### Risk Assessment

- **Low risk**: Changes to headless.ts are additive — new code paths only activate when `bare + context` are both set, which is only used by the extraction agent today. Existing headless commands (auto, new-milestone, etc.) are unaffected.
- **Edge case**: The 120s temp file cleanup timer in `extractMemories` may race with slow agent startup. Consider extending to 300s or using a cleanup-on-exit approach instead.
