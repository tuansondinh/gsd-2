# Auto Mode

Auto mode is LSD's autonomous execution engine. Type `/lsd auto`, walk away, come back to built software with a clean git history.

> Preferred command surface: use `/lsd ...`. Legacy `/gsd ...` aliases may still exist for compatibility.

## How It Works

Auto mode is a **state machine driven by files on disk**. It reads `.lsd/STATE.md`, determines the next unit of work, creates a fresh agent session, injects a focused prompt with all relevant context pre-inlined, and lets the LLM execute. When the LLM finishes, auto mode reads disk state again and dispatches the next unit.

### The Loop

Each slice flows through phases automatically:

```
Plan → Execute (per task) → Complete → Reassess Roadmap → Next Slice
                                                            ↓ (all slices done)
                                                  Validate Milestone → Complete Milestone
```

- **Plan** — scouts the codebase, researches relevant docs, and decomposes the slice into tasks
- **Execute** — runs each task in a fresh context window
- **Complete** — writes summary, UAT script, marks roadmap, commits
- **Reassess** — checks if the roadmap still makes sense
- **Validate Milestone** — reconciliation gate after all slices complete

## Key Properties

### Fresh Session Per Unit

Every task, research phase, and planning step gets a clean context window. No accumulated garbage. No degraded quality from context bloat. The dispatch prompt includes everything needed — task plans, prior summaries, dependency context, decisions register — so the LLM starts oriented.

### Context Pre-Loading

The dispatch prompt is carefully constructed with:

| Inlined Artifact | Purpose |
|------------------|---------|
| Task plan | What to build |
| Slice plan | Where this task fits |
| Prior task summaries | What's already done |
| Dependency summaries | Cross-slice context |
| Roadmap excerpt | Overall direction |
| Decisions register | Architectural context |

The amount of context inlined is controlled by your [token profile](./token-optimization.md).

### Git Isolation

LSD isolates milestone work using one of three modes (configured via `git.isolation`):

- **`worktree`** (default): Each milestone runs in its own git worktree at `.lsd/worktrees/<MID>/` on a `milestone/<MID>` branch. When the milestone completes, it's squash-merged to main as one clean commit.
- **`branch`**: Work happens in the project root on a `milestone/<MID>` branch.
- **`none`**: Work happens directly on your current branch. No worktree, no milestone branch.

### Parallel Execution

When your project has independent milestones, you can run them simultaneously. Each milestone gets its own worker process and worktree. See [Parallel Orchestration](./parallel-orchestration.md).

### Crash Recovery

A lock file tracks the current unit. If the session dies, the next `/lsd auto` reads the surviving session file, synthesizes a recovery briefing, and resumes with full context.

**Headless auto-restart:** When running `lsd headless auto`, crashes trigger automatic restart with exponential backoff (5s → 10s → 30s cap, default 3 attempts). Configure with `--max-restarts N`. Combined with crash recovery, this enables true overnight "run until done" execution.

### Provider Error Recovery

LSD classifies provider errors and auto-resumes when safe:

| Error type | Examples | Action |
|-----------|----------|--------|
| **Rate limit** | 429, "too many requests" | Auto-resume after retry-after header or 60s |
| **Server error** | 500, 502, 503, "overloaded" | Auto-resume after 30s |
| **Permanent** | "unauthorized", "invalid key", "billing" | Pause indefinitely (requires manual resume) |

### Incremental Memory

LSD maintains a `KNOWLEDGE.md` file — an append-only register of project-specific rules, patterns, and lessons learned. The agent reads it at the start of every unit and appends to it when discovering recurring issues or non-obvious patterns.

### Context Pressure Monitor

When context usage reaches 70%, LSD sends a wrap-up signal to the agent, nudging it to finish durable output (commit, write summaries) before the context window fills.

### Stuck Detection

LSD uses a sliding-window analysis to detect stuck loops. Instead of a simple "same unit dispatched twice" counter, the detector examines recent dispatch history for repeated patterns — catching cycles like A→B→A→B as well as single-unit repeats. On detection, LSD retries once with a deep diagnostic prompt.

### Timeout Supervision

Three timeout tiers prevent runaway sessions:

| Timeout | Default | Behavior |
|---------|---------|----------|
| Soft | 20 min | Warns the LLM to wrap up |
| Idle | 10 min | Detects stalls, intervenes |
| Hard | 30 min | Pauses auto mode |

Configure in preferences:

```yaml
auto_supervisor:
  soft_timeout_minutes: 20
  idle_timeout_minutes: 10
  hard_timeout_minutes: 30
```

### Cost Tracking

Every unit's token usage and cost is captured, broken down by phase, slice, and model. Budget ceilings can pause auto mode before overspending.

See [Cost Management](./cost-management.md).

### Verification Enforcement

Configure shell commands that run automatically after every task execution:

```yaml
verification_commands:
  - npm run lint
  - npm run test
verification_auto_fix: true
verification_max_retries: 2
```

Failures trigger auto-fix retries — the agent sees the verification output and attempts to fix the issues before advancing.

### HTML Reports

After a milestone completes, LSD auto-generates a self-contained HTML report in `.lsd/reports/`. Reports include project summary, progress tree, slice dependency graph, cost/token metrics, execution timeline, changelog, and knowledge base.

```yaml
auto_report: true    # enabled by default
```

Generate manually with `/lsd export --html`, or for all milestones with `/lsd export --html --all`.

## Controlling Auto Mode

### Start

```
/lsd auto
```

### Pause

Press **Escape**. The conversation is preserved. You can interact with the agent, inspect state, or resume.

### Resume

```
/lsd auto
```

Auto mode reads disk state and picks up where it left off.

### Stop

```
/lsd stop
```

Stops auto mode gracefully. Can be run from a different terminal.

### Steer

```
/lsd steer
```

Hard-steer plan documents during execution without stopping the pipeline. Changes are picked up at the next phase boundary.

### Capture

```
/lsd capture "add rate limiting to API endpoints"
```

Fire-and-forget thought capture. Captures are triaged automatically between tasks.

### Visualize

```
/lsd visualize
```

Open the workflow visualizer — interactive tabs for progress, dependencies, metrics, and timeline.

## Dashboard

`Ctrl+Alt+G` or `/lsd status` shows real-time progress:

- Current milestone, slice, and task
- Auto mode elapsed time and phase
- Per-unit cost and token breakdown
- Cost projections
- Completed and in-progress units
- Parallel worker status (when running parallel milestones)

## Phase Skipping

Token profiles can skip certain phases to reduce cost:

| Phase | `budget` | `balanced` | `quality` |
|-------|----------|------------|-----------|
| Milestone Research | Skipped | Runs | Runs |
| Slice Research | Skipped | Skipped | Runs |
| Reassess Roadmap | Skipped | Runs | Runs |

See [Token Optimization](./token-optimization.md) for details.

## Dynamic Model Routing

When enabled, auto-mode automatically selects cheaper models for simple units and reserves expensive models for complex work. See [Dynamic Model Routing](./dynamic-model-routing.md).

## Two Terminals, One Project

The recommended workflow for large builds: auto mode in one terminal, steering from another.

**Terminal 1 — let it build:**

```bash
lsd
/lsd auto
```

**Terminal 2 — steer while it works:**

```bash
lsd
/lsd discuss    # talk through architecture decisions
/lsd status     # check progress
/lsd queue      # queue the next milestone
```

Both terminals read and write the same `.lsd/` files. Decisions in terminal 2 are picked up at the next phase boundary automatically.
