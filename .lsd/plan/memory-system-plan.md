# Memory System Plan — All Phases

## Goal
Full Claude Code memory pattern: persistent memory + topic files + LLM recall + auto-extract.

---

## Phase 1: Core Memory (MVP) — ~4 hours

### Files
```
src/resources/extensions/memory/
├── extension-manifest.json
├── index.ts
└── memory-paths.ts
```

### `memory-paths.ts` (~40 lines)
- `getMemoryDir(cwd)` → `~/.lsd/projects/<basename>-<hash>/memory/`
  - `sanitizeProjectPath(cwd)` → `basename-shortsha256` (avoids collisions + readable)
- `getMemoryEntrypoint(cwd)` → `{memoryDir}/MEMORY.md`
- `ensureMemoryDir(cwd)` → `mkdirSync(..., { recursive: true })`
- `isMemoryPath(absolutePath, cwd)` → containment check

### `extension-manifest.json`
```json
{
  "id": "memory",
  "name": "Persistent Memory",
  "version": "1.0.0",
  "description": "Persistent file-based memory across sessions",
  "tier": "bundled",
  "provides": {
    "hooks": ["session_start", "before_agent_start", "session_shutdown"]
  }
}
```

### `index.ts` (~100 lines)
- `session_start` → bootstrap memory dir, create MEMORY.md if missing
- `before_agent_start` → read MEMORY.md, truncate (200 lines / 25KB), build prompt, inject via `{ systemPrompt: event.systemPrompt + prompt }`

### Memory prompt (embedded in index.ts)
Concise instructions telling the agent:
- Where the memory dir is (and that it exists — don't mkdir)
- 4 types: user preferences, feedback, project context, references
- What NOT to save (code-derivable stuff, git history, ephemera)
- Format: keep entries concise, update/remove stale ones
- Appends current MEMORY.md contents (or "empty" message)

---

## Phase 2: Topic Files + Frontmatter — ~3 hours

### New files
```
src/resources/extensions/memory/
├── memory-types.ts
├── memory-scan.ts
└── memory-age.ts
```

### `memory-types.ts` (~30 lines)
- `MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const`
- `type MemoryType`
- `parseMemoryType(raw)` → validate string
- Frontmatter format constant (for prompt)

### `memory-scan.ts` (~80 lines)
- `MemoryHeader = { filename, filePath, mtimeMs, description, type }`
- `scanMemoryFiles(memoryDir)` → read all `.md` (except MEMORY.md), parse frontmatter, sort by mtime desc, cap at 200
- `formatMemoryManifest(memories)` → one-line-per-file text for LLM
- Frontmatter parsing: simple regex for `---\n...\n---` block, extract `name`, `description`, `type`
  - No external YAML lib needed — our frontmatter is 3 fields max

### `memory-age.ts` (~30 lines)
- `memoryAgeDays(mtimeMs)` → floor-rounded days since mtime
- `memoryAge(mtimeMs)` → "today" / "yesterday" / "N days ago"
- `memoryFreshnessNote(mtimeMs)` → staleness caveat string for >1 day old

### Changes to `index.ts`
- Upgrade prompt to explain topic files + MEMORY.md-as-index pattern
- Prompt now instructs: "Step 1: write topic file with frontmatter, Step 2: add pointer to MEMORY.md"
- Includes 4-type taxonomy descriptions with examples
- Includes "what NOT to save" and "when to access" sections
- Includes "Before recommending from memory" trust section

### Changes to `memory-paths.ts`
- Add `getTopicFilePath(memoryDir, filename)` for validation

---

## Phase 3: LLM-Based Recall — ~4 hours

### New file
```
src/resources/extensions/memory/
└── memory-recall.ts
```

### `memory-recall.ts` (~100 lines)
- `findRelevantMemories(query, memoryDir, signal?)` → `{ path, mtimeMs }[]` (up to 5)
- Scans memory headers via `scanMemoryFiles()`
- Builds manifest via `formatMemoryManifest()`
- **LLM call**: spawn a quick subagent via `pi.exec()` or direct API call
  - System prompt: "You are selecting memories relevant to a query. Return JSON `{ selected_memories: string[] }`"
  - User message: query + manifest
  - Use `pi.exec` to run: `lsd headless --context-text "..." --output json --bare`
  - Or simpler: use `fetch()` against Anthropic API directly with env var API key
  - **Decision: Use `pi.exec` to spawn a headless lsd with --bare for the side query** — this reuses existing auth/model config with zero new infra

### Changes to `index.ts`
- On `before_agent_start`: after loading MEMORY.md, also run recall if topic files exist
- Inject relevant memory file contents alongside MEMORY.md
- Add staleness notes from `memory-age.ts` for old memories

### Fallback
- If recall fails (timeout, no API key, etc.), just inject MEMORY.md — graceful degradation

---

## Phase 4: Auto-Extract — ~5 hours

### New file
```
src/resources/extensions/memory/
└── auto-extract.ts
```

### How it works
On `session_shutdown`:
1. Read conversation transcript via `ctx.sessionManager.getEntries()`
2. Serialize relevant entries (user messages + assistant messages, skip tool calls)
3. Build an extraction prompt
4. Spawn a **fire-and-forget background process**: `spawn(process.execPath, [cliPath, "--bare", ...], { detached: true, stdio: "ignore" })`
   - The spawned process runs headless with the extraction prompt
   - It reads existing memories, identifies new things to save, writes topic files, updates MEMORY.md
   - Pattern: exactly how `subagent/index.ts` spawns child processes
5. `proc.unref()` — don't wait for it, don't block shutdown

### `auto-extract.ts` (~120 lines)
- `extractMemories(pi, ctx)` — main function called from session_shutdown hook
- `buildTranscriptSummary(entries)` — serialize conversation to text (~50 lines)
- `buildExtractionPrompt(transcript, memoryDir, existingManifest)` — system prompt for extraction agent
- `spawnExtractionAgent(prompt, cwd)` — fire-and-forget child process

### Extraction agent prompt
```
You are a memory extraction agent. Read the conversation transcript below
and save any durable facts worth remembering to the memory directory.

Rules:
- Only save: user preferences, feedback/corrections, project context, external references
- Do NOT save: code patterns, git history, debugging steps, ephemeral task details
- Check existing memories first — update don't duplicate
- Use frontmatter format: name, description, type
- Update MEMORY.md index after writing
- Be selective — quality over quantity

Memory directory: <path>
Existing memories:
<manifest>

Conversation transcript:
<transcript>
```

### Safety
- Skip extraction if conversation was <3 turns (nothing to extract)
- Skip if memory dir has been written to during this session (main agent already handled it)
- Detached process — parent exit doesn't kill it
- Timeout: extraction agent gets 60s max

---

## Phase 5: Slash Commands — ~2 hours

### Changes to `index.ts`

Register commands via `pi.registerCommand()`:

#### `/memories`
- List all memory files with descriptions and ages
- Uses `scanMemoryFiles()` + `memoryAge()`
- Display as formatted table

#### `/remember <text>`
- Immediately save a memory
- Auto-classify type (or default to 'project')
- Write topic file + update MEMORY.md
- Confirm to user

#### `/forget <topic>`
- Search memory files for matching topic
- Delete file + remove from MEMORY.md
- Confirm to user

---

## Phases Deferred (Not Now)

### Phase 6: Team Memory
- `team/` subdirectory with sync
- Private vs shared scope
- Symlink-safe path validation (Claude Code's `teamMemPaths.ts` is 300+ lines of security)
- Secret scanning
- **Why deferred**: Significant security surface, needs server-side sync, 3-5 days alone

### Phase 7: KAIROS Daily Logs
- Append-only `logs/YYYY/MM/YYYY-MM-DD.md` for long-lived sessions
- Nightly `/dream` consolidation
- **Why deferred**: Needs long-running session support (KAIROS mode) which doesn't exist yet

---

## Execution Order (All Phases 1-5)

| Step | File | Phase | Est. |
|------|------|-------|------|
| 1 | `memory-paths.ts` | P1 | 30min |
| 2 | `extension-manifest.json` | P1 | 5min |
| 3 | `index.ts` (basic: bootstrap + simple prompt) | P1 | 2hr |
| 4 | `memory-types.ts` | P2 | 30min |
| 5 | `memory-scan.ts` + frontmatter parser | P2 | 1hr |
| 6 | `memory-age.ts` | P2 | 20min |
| 7 | Upgrade `index.ts` prompt (topic files, full taxonomy) | P2 | 1hr |
| 8 | `memory-recall.ts` | P3 | 2hr |
| 9 | Wire recall into `index.ts` before_agent_start | P3 | 1hr |
| 10 | `auto-extract.ts` | P4 | 3hr |
| 11 | Wire auto-extract into `index.ts` session_shutdown | P4 | 1hr |
| 12 | Slash commands in `index.ts` | P5 | 2hr |
| | **Total** | | **~14hr** |

### Key decisions made
- **LLM recall**: spawn headless `lsd --bare` as side query (reuses auth/model, no new infra)
- **Auto-extract**: fire-and-forget detached child process on session_shutdown (same pattern as subagent extension)
- **Transcript access**: `ctx.sessionManager.getEntries()` (confirmed available)
- **Frontmatter parsing**: simple regex, no YAML lib (3 fields max)
- **Memory location**: `~/.lsd/projects/<basename>-<hash>/memory/`
- **No team memory**: deferred (security-heavy, needs sync server)
- **No KAIROS logs**: deferred (needs long-lived session mode)

---

## Reference: Claude Code Source

### File Map
| Claude Code file | What it does |
|---|---|
| `memdir/memdir.ts` | Core prompt builder, truncation, ensureDir |
| `memdir/memoryTypes.ts` | 4-type taxonomy, frontmatter format, exclusion rules |
| `memdir/paths.ts` | Path resolution, enable/disable checks, settings override |
| `memdir/findRelevantMemories.ts` | Sonnet side-query recall (scan headers → LLM picks top 5) |
| `memdir/memoryScan.ts` | Directory scanner + frontmatter parser |
| `memdir/memoryAge.ts` | Days-since-mtime + human-readable age strings |
| `memdir/teamMemPaths.ts` | Team memory security (symlinks, traversal, TOCTOU) |
| `memdir/teamMemPrompts.ts` | Combined private+team prompt |

### LSD Integration Points
| Claude Code | LSD |
|---|---|
| `before_agent_start` hook | ✅ `pi.on("before_agent_start")` → `{ systemPrompt }` |
| `session_start` hook | ✅ `pi.on("session_start")` |
| `session_shutdown` hook | ✅ `pi.on("session_shutdown")` |
| `sideQuery()` | `pi.exec()` spawning headless lsd |
| `ctx.sessionManager.getEntries()` | ✅ Same API available |
| Subagent spawn | ✅ `spawn(process.execPath, [cliPath, ...])` pattern from `subagent/index.ts` |
| `~/.claude/projects/*/memory/` | `~/.lsd/projects/*/memory/` |
