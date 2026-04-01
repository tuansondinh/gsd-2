# Memory System Plan Review

Reviewed artifacts:
- `.lsd/plan/memory-system-plan.md`
- `src/resources/extensions/bg-shell/index.ts`
- `src/resources/extensions/bg-shell/extension-manifest.json`
- `src/resources/extensions/mac-tools/index.ts`
- `src/resources/extensions/mac-tools/extension-manifest.json`
- `src/resources/extensions/shared/frontmatter.ts`
- `src/shared-paths.ts`
- `src/resource-loader.ts`
- extension lifecycle docs under `src/resources/skills/create-gsd-extension/references/`

## Executive summary

The current plan is **directionally right but materially underestimates integration work**.

If you mean **"ship a useful MVP that injects a per-project MEMORY.md and lets the agent update it manually"**, this is roughly **1 focused day**.

If you mean **"copy Claude Code's pattern closely, including relevant-memory recall and automatic post-session extraction"**, this is more like **3–6 focused days**, and could become **1–2 weeks** if you want it production-safe, model-provider-agnostic, and well-tested.

The hard part is **not** frontmatter parsing or building a prompt string.
The hard parts are:
1. **where recall/extraction LLM calls come from** in LSD's architecture,
2. **how to safely trigger and observe background extraction**,
3. **how to avoid memory quality rot** (duplication, stale junk, noisy writes), and
4. **how to integrate with session history and prompt assembly without surprising side effects**.

## 1. Effort estimate

### A. MVP: manual persistent memory only
Scope:
- per-project memory path
- bootstrap memory dir + `MEMORY.md`
- inject `MEMORY.md` into `before_agent_start`
- basic prompt instructions for how the agent should use/update memory
- reuse shared frontmatter parser if needed later, but probably not required for v1
- no recall LLM, no auto extract, no slash commands

Estimate: **6–10 hours**

Breakdown:
- Path resolution + sanitization + tests: **1.5–2h**
- Prompt builder + truncation + tests: **2–3h**
- Extension entry + manifest + hook wiring: **1–2h**
- Bootstrap behavior / edge cases / smoke testing: **1.5–3h**

This is the only version I would confidently call a true "ship in a day" candidate.

### B. Useful v1: manual memory + explicit commands
Scope:
- everything in MVP
- `/memories`, `/remember`, maybe `/forget`
- list/update index safely
- basic file organization conventions

Estimate: **1.5–2 days** (**10–16 hours**)

Breakdown:
- MVP base: **6–10h**
- slash commands + UX + tests: **4–6h**

### C. Planned feature set minus team memory
Scope:
- pathing
- types/frontmatter/scanner/age
- prompt injection
- relevant-memory recall via LLM selection
- post-session auto extract background flow
- dedupe/skip logic
- tests for nontrivial parts

Estimate: **3–6 focused days** (**24–45 hours**)

Breakdown by phase:
- Core file/path/types/scan/prompt infra: **0.75–1.5 days**
- Extension integration + prompt injection + bootstrap: **0.5 day**
- Relevant-memory recall LLM path: **0.5–1.5 days**
- Auto-extract trigger + transcript assembly + background execution: **1–2 days**
- Quality controls (dedupe, stale handling, skip-if-already-written, tests): **0.5–1.5 days**

### D. "Production-grade Claude-like" version
Scope:
- all above, plus robust provider abstraction, failure handling, observability, stale-memory management, race protection, good tests, migration story, maybe explicit forget/list UX

Estimate: **1–2 weeks**

This is where hidden complexity shows up.

## 2. Complexity assessment

## Straightforward / mostly copy-adaptation

### 1. Memory path resolution
This is easy.
- LSD already has conventions around `~/.lsd/` and project state roots.
- A per-project directory under `~/.lsd/projects/<sanitized>/memory/` is trivial to implement.
- `mkdir -p`, entrypoint path helpers, containment checks: all standard.

### 2. Prompt injection via extension hook
This is also easy.
- `mac-tools` shows exactly how to inject system prompt text via `before_agent_start`.
- Manifest pattern is simple.
- An extension with `hooks: ["session_start", "before_agent_start"]` is normal in this codebase.

### 3. Prompt truncation / MEMORY.md inclusion
Straightforward.
- 200-line / 25KB truncation is simple.
- The bigger question is content quality, not implementation.

### 4. Basic frontmatter scanning
Mostly easy.
- There is already a shared frontmatter parser in `src/resources/extensions/shared/frontmatter.ts`.
- Creating a second `frontmatter-parser.ts` is probably unnecessary unless memory needs richer YAML support.
- Scanning `.md` files and sorting by mtime is routine.

### 5. Age / freshness helpers
Trivial utility work.

## Medium complexity

### 6. Semantic file organization and MEMORY.md maintenance
This sounds easy but gets annoying fast.
- Who creates topic files?
- When does the agent update `MEMORY.md` versus a topic file?
- How do you stop duplicate pointers and stale references?
- What if the model writes garbage frontmatter or malformed markdown?

Still solvable, but this is where "copy the pattern" starts becoming product behavior, not plumbing.

### 7. Session-history extraction from LSD
Likely medium, maybe hard depending on how cleanly session entries expose what you need.
- `ctx.sessionManager.getEntries()` exists.
- But the plan handwaves "reads the conversation transcript" as if a canonical transcript already exists.
- In LSD, you'll need to reconstruct a usable transcript from message entries/tool results/custom entries, and probably decide what to exclude.

That is implementation work the plan does not really account for.

## Actually hard

### 8. LLM recall side-query
This is one of the biggest gaps.

Claude Code has an internal `sideQuery()` primitive. LSD apparently does not.
The plan says "use the agent's configured API" but that is not a real design yet.

Current LSD extension patterns show:
- extensions can access auth through `ctx.modelRegistry`
- individual extensions sometimes call external APIs directly (`google-search`)
- but there is **no obvious generic 'ask the current model a cheap side question' helper** in the reviewed files

So for recall you must choose one of these unpleasant options:
1. hardcode a provider-specific direct API path,
2. build a generic side-query helper in core/platform,
3. shell out to a subagent / headless agent,
4. skip LLM recall and do heuristic retrieval.

That decision dominates complexity.

### 9. Auto-extract background agent
This is the other big hard part.

The phrase "fork a background agent" hides a lot:
- what executable launches it?
- with what prompt and model?
- how does it authenticate?
- how does it find the session transcript?
- how does it avoid colliding with active/manual memory writes?
- how do you keep it from silently failing and leaving users confused?
- what happens on shutdown race conditions?

LSD does have patterns for long-running/background-ish behavior (`bg-shell`, `async-jobs`, `subagent`), but none of the reviewed code gives you a drop-in "background memory summarizer" abstraction.
This is not copy-paste work.

### 10. Memory quality control
This is the product-hard part.

A naive auto-memory system becomes trash quickly:
- duplicates
- contradictions
- overfitting to one-off tasks
- stale project state
- too much prompt bloat
- sensitive junk stored forever

Claude's code likely relies on more invisible behavior norms and internal tooling than the plan acknowledges. Copying the file layout alone does not copy the quality bar.

## 3. Risk areas

## Highest risk

### A. No clear model invocation path for recall/extraction
This is the biggest risk in the plan.
Without a real side-query mechanism, both `memory-recall.ts` and `auto-extract.ts` are speculative.

### B. Auto-extract lifecycle reliability
Triggering on `session_shutdown` sounds neat, but shutdown hooks are exactly where things are easiest to lose:
- process exits early
- terminal killed
- model auth unavailable
- file writes race with shutdown cleanup
- background task detached incorrectly

A post-session feature that runs unreliably is worse than not having it.

### C. Bad memory writes by the agent
If the model is allowed to write files directly with weak constraints:
- malformed frontmatter
- junk topic names
- duplicate topic files
- giant `MEMORY.md`
- storing code facts that should live in repo docs instead

You'll need some kind of schema/validation or periodic cleanup story.

### D. Project path sanitization collisions
`~/.lsd/projects/{sanitized-cwd}/memory/` sounds simple, but beware:
- collisions between similarly named paths
- case sensitivity differences across platforms
- unicode normalization issues
- symlinked repos / different cwd aliases for same repo

If you do this, prefer a readable slug plus a hash, not just sanitized text.

### E. Prompt bloat and context tax
If you inject MEMORY.md every turn and also surface recalled topic files, context cost rises quickly.
This matters especially if the system becomes noisy or stale.

### F. Privacy / sensitive data retention
The plan mentions private/team scope but doesn't operationalize privacy rules.
If the system automatically stores user preferences, credentials-adjacent data, internal URLs, ticket numbers, or incident details, you need explicit boundaries.

## Medium risk

### G. Reusing vs duplicating frontmatter parsing
The plan proposes `frontmatter-parser.ts`, but there is already shared parsing code.
Duplicate parsers drift.

### H. Hook choice may be wrong for recall
The plan assumes `before_agent_start` is enough. It is enough for prompt injection, but relevant-memory recall might need:
- the current prompt text
- maybe recent session context
- maybe selective injection as a message instead of system-prompt append

That design isn't resolved.

### I. Team memory deferred, but taxonomy still assumes it
A lot of the taxonomy language in the plan is biased around private vs team decisions. If team memory is deferred, simplify the taxonomy and rules or you'll implement UX that implies a non-existent sharing model.

## 4. Simplification opportunities

If the goal is to ship something useful fast, cut aggressively.

### Cut 1: Remove LLM-based recall from v1
Do **not** build `memory-recall.ts` first.

Options instead:
- only inject `MEMORY.md`
- optionally include top N recently modified topic files
- optionally include files explicitly referenced by links in `MEMORY.md`

This avoids the entire side-query architecture problem.

### Cut 2: Remove auto-extract entirely from v1
This is the most seductive and most expensive part.
Defer it.

Manual memory is still valuable if the prompt tells the agent to update memory when it learns durable facts.

### Cut 3: Collapse to one file for MVP
For day-1, you may not even need topic files.
Use only:
- `~/.lsd/projects/<project>/memory/MEMORY.md`

That gives you 80% of the value with 20% of the complexity.
Topic files can come later.

### Cut 4: Skip type taxonomy enforcement in code
Keep the taxonomy as prompt guidance, not parser-enforced behavior, for MVP.
You can add structured topic files later.

### Cut 5: Skip slash commands initially
They are nice, but not required for value if the model can already write the memory file.
A plain file-based memory system works without them.

### Cut 6: Reuse shared frontmatter parser
If/when topic files arrive, reuse `src/resources/extensions/shared/frontmatter.ts` unless there is a proven limitation.

### Cut 7: No staleness system in MVP
Age helpers are low effort, but they are also low leverage if you are only loading one file.
Defer until retrieval exists.

## 5. Missing pieces in the plan

## Important missing design decisions

### 1. How exactly does the extension know the current project identity?
The plan says use sanitized cwd. That is probably insufficient.
It should define:
- symlink handling
- path normalization
- case normalization policy
- collision strategy
- maybe hash suffix

### 2. What is the exact session transcript source for auto extract?
The plan says "reads the conversation transcript" but does not specify:
- session JSONL path via `ctx.sessionManager.getSessionFile()`?
- filtered `getEntries()`?
- include tool outputs or not?
- include subagent/tool chatter or not?
- branch semantics?

That is a real missing piece.

### 3. Who is allowed to write memory files, and how is validity enforced?
If the main agent writes memory directly:
- do we validate frontmatter before accepting?
- do we repair malformed files?
- do we enforce filename conventions?

If not, the store will rot.

### 4. What is the failure UX?
If memory load fails, recall fails, or auto-extract fails:
- silent?
- toast?
- status line?
- debug log only?

Nothing in the plan addresses observability.

### 5. How do we prevent redundant writes?
The plan references `hasMemoryWritesSince()` but does not explain how LSD would detect this.
You likely need to inspect tool calls/results for writes into the memory directory, or append explicit custom state entries when memory is written.
That is nontrivial and currently unspecified.

### 6. Memory file schema/versioning
If you plan to evolve format later, define a minimal schema/version now or accept migration pain later.
Even a tiny frontmatter field like `schema: 1` helps.

### 7. Testing strategy for extension hooks
The plan lists tests for utilities, but not for hook-level behavior:
- `before_agent_start` prompt injection
- session start bootstrap
- session shutdown trigger behavior
- prompt truncation with real file content

These are the tests most likely to catch integration regressions.

### 8. Interaction with `lsd.md` / project instructions
The plan mentions "don't save what's already in lsd.md" but doesn't say how the system knows that.
Will the prompt just instruct the model not to duplicate it? If so, expect duplication anyway.

### 9. Concurrency / locking
Two LSD sessions in the same repo can race on `MEMORY.md`.
The plan does not mention file locking, merge strategy, or last-write-wins behavior.

### 10. Security boundaries
If memory files are outside the repo under `~/.lsd`, are they ever exposed to subagents, background jobs, or exported diagnostics? The plan should state the intended trust boundary.

## 6. Recommended MVP scope (what to ship in one day)

If you want a memory system in a day, ship this and nothing more:

### MVP scope

#### Files
- `src/resources/extensions/memory/index.ts`
- `src/resources/extensions/memory/extension-manifest.json`
- maybe `src/resources/extensions/memory/paths.ts`
- maybe `src/resources/extensions/memory/prompt.ts`

#### Behavior
1. Resolve a stable per-project memory dir under `~/.lsd/projects/<slug>-<hash>/memory/`
2. Ensure the dir exists on `session_start`
3. Ensure `MEMORY.md` exists if missing, with a tiny starter template
4. On `before_agent_start`, append a concise memory instruction block + current `MEMORY.md` contents
5. Truncate at a fixed line/byte cap
6. Tell the model:
   - use memory only for durable user/project facts
   - avoid saving code facts derivable from the repo
   - update/remove stale memory when wrong
   - keep the file concise

That's it.

### Optional same-day add-on
- `/memories` command that opens/lists the memory file path or prints its contents

### Explicitly defer
- topic files
- frontmatter taxonomy
- relevant-memory recall
- auto-extract
- team memory
- stale-age annotations
- forget/dream commands

## What I would change in the current plan

## Replace the 4-phase plan with 2 stages

### Stage 1: shippable MVP
- path helper
- `MEMORY.md` bootstrap
- prompt injection
- truncation
- maybe one command to inspect memory

### Stage 2: retrieval + automation (separate design doc)
Only after MVP proves useful, design:
- retrieval strategy (heuristic vs LLM side-query)
- background execution model
- transcript source and filtering
- write dedupe and validation
- observability

## Specific corrections to the current plan

### 1. Do not create `frontmatter-parser.ts`
Reuse `shared/frontmatter.ts` unless proven inadequate.

### 2. Do not commit to `memory-recall.ts` until the model-invocation path is real
This is an architecture dependency, not a routine module.

### 3. Do not commit to `auto-extract.ts` in the initial implementation plan
It is a separate project.

### 4. Reduce the initial file manifest drastically
The proposed manifest is too big for a first pass and encourages premature abstraction.

### 5. Add a slug+hash path format
Readable-only sanitized cwd is fragile.

## Brutally honest bottom line

The current plan reads like **"mostly copy Claude's files, adapt hook names, done."**
That is not true.

What is easy:
- file pathing
- prompt injection
- one-file persistent memory

What is not easy:
- model-powered recall in LSD
- robust auto extraction
- keeping memory high quality over time

So the realistic answer is:
- **One-day ship:** yes, but only for a **manual MEMORY.md injector MVP**
- **Claude-like system:** no, not in a day; **3–6 days minimum**, possibly more if you do it right

If speed matters, ship the dumb version first. The dumb version is still useful. The "smart" version is where the real engineering starts.
