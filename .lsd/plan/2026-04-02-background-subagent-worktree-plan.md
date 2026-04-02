# Background subagent continuation plan (same checkout / same branch, no git worktree)

Date: 2026-04-02
Status: planned
Mode: plan-only

## User goal
Allow LSD users to keep talking to the agent in the same CLI while long-running delegated work continues in the background, using the **same checkout / same branch** rather than git worktree isolation.

This should feel closer to the Claude/OpenClaw model:
- spawn a background subagent run/session
- return control to the main conversation immediately
- let the child keep working
- announce results back into the parent session later

## Scope confirmed
Chosen direction: **Option B**

Meaning:
- detached/background subagents
- same repo checkout
- same branch
- child may write files directly in that checkout
- no git worktree requirement for the first implementation

## Findings from investigation

### What LSD already has
1. **Interactive message queue already exists in the vendored PI TUI**
   - `packages/pi-coding-agent/dist/modes/interactive/controllers/input-controller.js`
   - `packages/pi-coding-agent/dist/modes/interactive/interactive-mode.js`
   - `packages/pi-coding-agent/dist/core/agent-session.js`
2. Current interactive behavior is:
   - **Enter** during streaming => queue a **steering** message
   - **Alt+Enter** during streaming => queue a **follow-up** message
   - **Alt+Up** => restore queued messages back into the editor
3. This matches the docs in:
   - `docs/what-is-pi/12-the-message-queue-talking-while-pi-thinks.md`
4. `async_bash` is already a true background primitive:
   - `src/resources/extensions/async-jobs/index.ts`
   - `src/resources/extensions/async-jobs/async-bash-tool.ts`
   - it returns immediately and posts completion later as a visible message
5. `subagent` is **not** backgrounded today:
   - `src/resources/extensions/subagent/index.ts`
   - it blocks until the delegated process finishes
6. Subagent isolation exists, but is optional and not the target behavior for this feature:
   - `src/resources/extensions/subagent/isolation.ts`

### What the public Claude/OpenClaw-style material suggests
From the public docs/material available during planning, the closest visible behavior is:
- spawn is **non-blocking**
- main session gets a **run id** immediately
- child runs in its own **session / queue lane**
- completion is **announced back** to the requester session/chat
- the important isolation is **session/runtime isolation**, not necessarily git isolation

So the relevant model is:
- separate **agent run/session**
- same user-facing conversation stays responsive
- completion is delivered back later

## Important distinction
There are still two different meanings of “continue talking while waiting”:

### 1. Queued input while the current turn is running
Already supported today.
This does **not** create a truly concurrent child worker.

### 2. True detached background subagent
This is the requested target.
The long-running delegated work should continue while the main conversation is free to accept new prompts immediately.

## Recommended product shape
Implement a **background subagent job/session model** for LSD.

Core idea:
- add detached/background execution for `subagent`
- use the same checkout/branch by default
- report completion back into the parent session as a custom/follow-up message
- avoid changing the core single-turn engine more than necessary

## Proposed implementation direction

### Phase 1 — detached/background subagent mode
Add a background mode to `subagent`, preferably:
- `background: true`

Reason:
- keeps one conceptual tool
- mirrors `async_bash` semantics
- avoids inventing a second tool if not necessary

Expected behavior:
- subagent tool call returns quickly with a stable job/run id
- child process keeps running independently
- main agent can answer new prompts right away
- final result is injected later into the parent session

### Phase 2 — background subagent manager
Create a session-scoped manager similar to `AsyncJobManager` that tracks:
- job id / run id
- agent name
- task summary
- cwd
- startedAt / completedAt
- status: `running | completed | failed | cancelled`
- stdout/stderr capture
- final summary/result payload
- relation to parent session

Possible file(s):
- `src/resources/extensions/subagent/background-job-manager.ts`
- `src/resources/extensions/subagent/background-runner.ts`

### Phase 3 — result announcement back into the parent session
When the child finishes:
- create a visible custom message in the parent session
- include:
  - agent name
  - task label/summary
  - status
  - concise output summary
  - optional truncated raw output if useful

Default behavior should be:
- visible session message
- no automatic extra model turn unless explicitly enabled later

This mirrors how `async_bash` currently reports completion.

### Phase 4 — same-checkout concurrency rules
Because this is **Option B** and background subagents may write to the same checkout, define strict safety rules.

#### Minimum rules for v1
1. Child subagent runs in the same cwd/checkout as the parent unless overridden.
2. Child writes are allowed.
3. Foreground session remains usable while child runs.
4. Completion announcement must not mutate the live turn state directly.
5. Session switch/new session behavior must be defined.

#### Concurrency risks to handle explicitly
- foreground session edits file A while child also edits file A
- foreground applies a change while child is mid-task and reading stale files
- child tool approvals arrive after the parent session has moved on
- child failures produce noisy or oversized output

#### Recommended first-pass guardrails
For first implementation, reduce risk with a combination of:
- explicit background status visibility
- conservative output truncation
- optional warning in the completion message when child used mutating tools
- cancellation controls
- clear documentation that same-checkout concurrent writes can conflict

### Phase 5 — lifecycle behavior
Define what happens on:
- session switch
- new session
- shutdown
- reload/hot-reload

Recommended initial behavior:
- if the parent session ends/switches, background subagents are cancelled by default
- or, if kept alive, they are marked orphaned and stop announcing into the old session

Default recommendation for v1: **cancel on session switch/shutdown**

### Phase 6 — control surface
Add visibility and control commands, similar to `/jobs`.
Possible commands:
- `/subagents`
- `/subagents list`
- `/subagents cancel <id>`
- `/subagents output <id>`
- `/subagents info <id>`

If desirable later, async bash + background subagent jobs can share one unified job UI.

## Files likely involved

### Existing files to extend
- `src/resources/extensions/subagent/index.ts`
- `src/resources/extensions/subagent/worker-registry.ts`
- `src/resources/extensions/async-jobs/index.ts` (reference pattern)
- `src/resources/extensions/async-jobs/job-manager.ts` (reference pattern)
- `packages/pi-coding-agent` docs/help text if needed

### Likely new files
- `src/resources/extensions/subagent/background-job-manager.ts`
- `src/resources/extensions/subagent/background-runner.ts`
- `src/resources/extensions/subagent/background-command.ts`
- possibly `background-types.ts`

## Risks / constraints
1. **Core session remains single-writer**
   - child completion must be reported via custom/follow-up session messages
   - background child must not corrupt active foreground turn state
2. **Shared checkout conflicts are the main product risk**
   - this is the defining tradeoff of Option B
3. **Approval flow is tricky**
   - a detached subagent may request permissions after the parent moved on
   - this may require either inherited approvals, denial, or visible interruption UX
4. **Session lifecycle must be explicit**
   - switch/new/shutdown behavior cannot be left ambiguous
5. **Output volume can explode**
   - summaries and truncation are required

## Acceptance criteria
1. User can start a subagent in detached/background mode
2. The tool returns immediately with a stable run id
3. User can continue chatting in the same LSD session without waiting for that subagent to finish
4. Background subagent completion is surfaced back into that parent session
5. First implementation works on the **same checkout / same branch** without requiring git worktrees
6. Failures/cancellations are visible and do not corrupt the parent session
7. Same-checkout behavior is documented honestly, including concurrent write caveats

## Recommended execution order
1. Add background mode parameter surface to `subagent`
2. Implement background manager + detached child lifecycle
3. Implement parent-session completion announcement
4. Add cancellation/list/output controls
5. Define and enforce session switch/shutdown behavior
6. Add tests for lifecycle, completion delivery, and same-checkout job handling
7. Add docs/help text explaining difference between queueing vs background subagents

## Notes for later phases
Potential future upgrades after v1:
- optional “announce and auto-continue” behavior
- optional background subagent model overrides
- optional isolated mode for users who later want safer filesystem isolation
- structured same-file conflict detection/warnings
- unified jobs dashboard across async bash + background subagents

## Final recommendation
Proceed with **background subagent sessions on the same checkout/branch**.

This is the closest match to the requested Claude-style behavior and avoids overfitting the solution to LSD’s existing git worktree isolation support.
