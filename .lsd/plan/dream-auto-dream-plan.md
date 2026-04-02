# Dream / Auto-Dream Plan

## User request
Add a `dream` function and `auto-dream`, using the Claw Code / autoDream pattern as the reference.

## Source-backed finding (updated)
I re-checked against a public archived source snapshot and found the real implementation surface under:
- `src/services/autoDream/autoDream.ts`
- `src/services/autoDream/config.ts`
- `src/services/autoDream/consolidationPrompt.ts`
- `src/services/autoDream/consolidationLock.ts`
- `src/memdir/paths.ts`

This materially changes the interpretation:

- **auto memory / extract memories** = capture new durable facts from sessions
- **dream / autoDream** = perform a reflective consolidation pass over existing memory files, prune stale/contradicted items, merge duplicates, tighten the index, and summarize what changed

So the user clarification was correct.

## What Claw Code autoDream actually does

### 1) It is a background consolidation service, not raw extraction
From `src/services/autoDream/autoDream.ts`:
- comment: `Background memory consolidation. Fires the /dream prompt as a forked subagent`
- it runs only when enough time has passed **and** enough sessions have accumulated
- it uses a forked agent via `runForkedAgent(...)`
- it builds a dedicated consolidation prompt via `buildConsolidationPrompt(...)`

### 2) It uses explicit gates before firing
Gate order in the source:
1. **Time gate** — enough hours since last consolidation
2. **Session gate** — enough sessions touched since last consolidation
3. **Lock gate** — avoid concurrent consolidations

Defaults from source:
- `minHours: 24`
- `minSessions: 5`

There is also a scan throttle:
- `SESSION_SCAN_INTERVAL_MS = 10 * 60 * 1000`

### 3) It is separately toggleable
From `src/services/autoDream/config.ts`:
- user setting: `autoDreamEnabled` in settings
- if user setting is unset, it falls through to a feature flag default

That means Claw Code treats autoDream as a distinct feature toggle, not just part of extraction.

### 4) The prompt semantics match the user’s description exactly
From `src/services/autoDream/consolidationPrompt.ts`:
- title: `# Dream: Memory Consolidation`
- describes dream as `a reflective pass over your memory files`
- phases:
  - **Phase 1 — Orient**: inspect memory dir, read MEMORY.md, skim topic files
  - **Phase 2 — Gather recent signal**: review logs, drifted memories, optionally grep transcripts narrowly
  - **Phase 3 — Consolidate**: update or merge memory files, avoid duplicates, convert relative dates to absolute, delete contradicted facts
  - **Phase 4 — Prune and index**: keep `MEMORY.md` as a short index, remove stale pointers, shorten verbose entries, resolve contradictions

This is exactly the “check if memories are still relevant, clean them up, consolidate, summarize” behavior.

### 5) It records consolidation time with a lock file
From `src/services/autoDream/consolidationLock.ts`:
- lock file: `.consolidate-lock`
- lock file `mtime` is used as `lastConsolidatedAt`
- source uses this both as concurrency control and as the timestamp for the next gate
- manual `/dream` appears to stamp consolidation time via `recordConsolidation()`

### 6) Memory layout includes logs + topic files + MEMORY.md
From `src/memdir/paths.ts`:
- auto memory directory has an entrypoint `MEMORY.md`
- there is also a daily log path helper:
  - `logs/YYYY/MM/YYYY-MM-DD.md`
- source comment says a separate nightly `/dream` distills these logs into topic files + `MEMORY.md`

## Important local implications for LSD

### Existing LSD memory code is closer to extract-memories, not dream
LSD already has:
- `src/resources/extensions/memory/index.ts`
- `src/resources/extensions/memory/auto-extract.ts`

That system currently:
- reads recent session transcript
- spawns a detached headless process
- asks an agent to save durable memories

So that is closer to **extract memories / auto memory**, not dream.

### We should not map `/dream` to current auto-extract
That would be semantically wrong.

Instead:
- current auto-extract remains the “capture new memories” pipeline
- new `dream` should be a **memory maintenance / consolidation** pipeline
- new `auto-dream` should be the scheduled/background trigger for that maintenance pipeline

## Recommended implementation scope

### MVP
Implement:
1. `/dream` — run a memory consolidation pass now
2. `/dream status` — show last consolidation status / last run metadata
3. `/auto-dream on|off|status` — toggle scheduled background consolidation

### Separate concerns clearly
- **auto memory**: extract new durable facts from sessions
- **dream**: consolidate existing memory state

## Recommended LSD design

## A. Add a new dream-specific module
New likely file:
- `src/resources/extensions/memory/dream.ts`

Responsibilities:
- build the consolidation prompt
- start a detached background dream worker
- maintain status artifacts
- expose reusable `startDream(...)` helper for manual and automatic triggers

## B. Reuse current memory directory and file format
Use the existing LSD memory layout:
- topic files in project memory dir
- `MEMORY.md` as index
- optionally add maintenance artifacts like:
  - `.last-dream.txt`
  - `.last-dream.log`
  - `.consolidate-lock`

No need to invent a second memory store.

## C. Dream prompt should mirror the Claw Code semantics
Prompt should instruct the agent to:
- inspect existing memories first
- merge duplicates
- remove stale or contradicted facts
- convert relative time references to absolute dates
- keep `MEMORY.md` short and index-like
- only grep transcripts/logs narrowly when needed
- return a short summary of what changed

## D. Add scheduling gates for auto-dream
Settings shape proposal:
```json
{
  "memory": {
    "autoDream": true,
    "autoDreamMinHours": 24,
    "autoDreamMinSessions": 5
  }
}
```

Recommended defaults:
- `autoDream: false` for first ship if we want low surprise
- OR `true` if we want closer parity with current source behavior
- `autoDreamMinHours: 24`
- `autoDreamMinSessions: 5`

We should preserve env-var compatibility if desired, but the primary interface should be settings-backed.

## E. Trigger points

### Manual
- `/dream`
- `/dream status`

### Automatic
Use extension lifecycle, likely `turn_end` and/or `session_start` as scheduling checkpoints:
- `turn_end` is the closest analog to “after enough work has accumulated, consider firing a background dream”
- `session_start` can also cheaply check the time gate and possibly fire

Recommendation:
- do cheap gate checks on `turn_end`
- fire detached dream worker only when gates pass

## F. Add a consolidation lock
Use a lock file inside the memory directory:
- `.consolidate-lock`

Use it to:
- prevent concurrent dream runs
- store/recover `lastConsolidatedAt` from file mtime, like the source does

## Concrete file impact

### Likely to change
- `src/resources/extensions/memory/index.ts`
- `src/resources/extensions/memory/extension-manifest.json`
- `packages/pi-coding-agent/src/core/settings-manager.ts`
- `src/resources/extensions/memory/auto-extract.ts` (only to keep extraction separate / shared helpers if useful)
- new: `src/resources/extensions/memory/dream.ts`
- tests under `src/resources/extensions/memory/tests/`

### Likely new tests
- dream gate logic (time / sessions)
- lock behavior
- prompt builder includes consolidation instructions
- `/dream status` parsing
- `/auto-dream on|off|status`

## Revised execution plan after approval
1. Add dream settings to settings manager
2. Add dream status/lock helpers
3. Implement consolidation prompt builder in LSD memory extension
4. Implement detached dream worker start helper
5. Register `/dream` and `/auto-dream` commands
6. Wire automatic gate checks on turn/session lifecycle
7. Update manifest
8. Add tests
9. Build and verify

## Success criteria
- `/dream` runs a consolidation pass over existing memories
- consolidation can merge/update/prune memory files and tighten `MEMORY.md`
- `/dream status` reports the last run and outcome
- `/auto-dream on|off|status` persists and controls scheduled consolidation
- current auto-extract continues to exist as a separate “auto memory” pipeline

## Confidence
High confidence on the semantics now, because they are directly reflected in the archived source files above rather than inferred from docs alone.
