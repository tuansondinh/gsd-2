# Configurable Workflow Depth

Control how much research and verification GSD runs before executing code.

## The Problem

By default, GSD runs 4 separate LLM sessions before writing a single line of code:

```
research-milestone → plan-milestone → research-slice → plan-slice → execute
```

For a milestone with 3 slices, that's **8 research/planning sessions** before execution starts. Each planning session also includes a 10-point self-audit, observability planning, and post-slice reassessment — all useful for large projects, but overhead for smaller or familiar work.

## The Full Pipeline Explained

Here's every phase a milestone goes through, in order, and exactly what each one does:

### 1. Research Milestone

**Unit:** `research-milestone` | **Output:** `RESEARCH.md`

A dedicated LLM session that explores the codebase before any planning happens. It:
- Scans existing code for relevant patterns, conventions, and integration points
- Looks up unfamiliar libraries via documentation tools
- Identifies common pitfalls ("Don't Hand-Roll" table)
- Answers strategic questions: What should be proven first? What existing patterns should be reused? What boundary contracts matter?
- Surfaces candidate requirements that might be missing

This runs **once per milestone**. The output is advisory — it informs planning but doesn't auto-expand scope.

### 2. Plan Milestone

**Unit:** `plan-milestone` | **Output:** `ROADMAP.md`

Decomposes the milestone into vertical slices (independently demoable chunks of work). It:
- Reads the RESEARCH.md (if it exists) and milestone CONTEXT.md
- Creates a roadmap with ordered slices, each with: title, risk level, dependencies, demo sentence, and proof strategy
- Maps every Active requirement to at least one slice
- Orders slices risk-first (hardest/riskiest work goes first)
- Writes success criteria as observable truths, not implementation tasks
- Follows a 13-point "Planning Doctrine" (e.g. "every slice is vertical and demoable", "ship features not proofs", "brownfield bias")

This runs **once per milestone**.

### 3. Research Slice

**Unit:** `research-slice` | **Output:** per-slice `RESEARCH.md`

Same idea as milestone research, but scoped to a single slice. It:
- Explores the specific code paths this slice will touch
- Reads dependency slice summaries (especially "Forward Intelligence" sections from completed slices)
- Identifies risks and unknowns specific to this slice's scope

This runs **once per slice**.

### 4. Plan Slice

**Unit:** `plan-slice` | **Output:** `PLAN.md` + `T01-PLAN.md`, `T02-PLAN.md`, etc.

The most detailed planning phase. Decomposes a slice into executable tasks. It:
- Defines slice-level verification first (what "done" looks like — usually real test files)
- Plans observability/diagnostics (how to inspect state and detect failures)
- Fills "Proof Level" and "Integration Closure" sections
- Breaks work into tasks, each fitting one context window (2-5 steps, 3-8 files)
- Writes individual task plans with: description, steps, must-haves, verification, inputs, expected output
- Runs the **10-point self-audit** (see below)
- Commits the plan and updates STATE.md

This runs **once per slice**.

#### The 10-Point Self-Audit

Before finishing, the plan-slice agent walks through these checks and fixes any failures:

1. **Completion semantics** — If every task were completed exactly as written, would the slice goal actually be true? No scaffolding-only plans.
2. **Requirement coverage** — Every must-have maps to at least one task. No orphans.
3. **Task completeness** — Every task has steps, must-haves, verification, observability impact, inputs, and expected output. None are blank or vague.
4. **Dependency correctness** — Task ordering is consistent. No task references work from a later task.
5. **Key links planned** — For every pair of artifacts that must connect (component to API, API to database, form to handler), there's an explicit wiring step.
6. **Scope sanity** — 2-5 steps and 3-8 files per task. 10+ steps or 12+ files must split.
7. **Context compliance** — Plan honors locked decisions from DECISIONS.md and doesn't include deferred/out-of-scope items.
8. **Requirement coverage (REQUIREMENTS.md)** — Every Active requirement this slice owns has a task with verification that proves it's met.
9. **Proof honesty** — Proof Level and Integration Closure match what the slice will actually prove. No claiming live end-to-end when only fixtures are tested.
10. **Feature completeness** — Every task produces real user-facing progress. UI slices build real UI. API slices connect to real data sources. A non-technical stakeholder should see real product progress.

### 5. Execute Task

**Unit:** `execute-task` | **Output:** code changes + `T0x-SUMMARY.md`

Actually writes code. Runs once per task in the slice plan. Each task is a fresh LLM session with the task plan as its contract.

### 6. Complete Slice

**Unit:** `complete-slice` | **Output:** slice `SUMMARY.md` + `UAT.md`

After all tasks are done, verifies the slice by running all verification checks from the plan. Writes a summary with "Forward Intelligence" for downstream slices.

### 7. Reassess Roadmap

**Unit:** `reassess-roadmap` | **Output:** `ASSESSMENT.md`

After a slice completes (but before starting the next one), re-evaluates the remaining roadmap:
- Checks if each success criterion still has at least one remaining slice that will prove it
- Flags criteria that lost their owner as BLOCKING
- Biased toward "no change" — only rewrites the roadmap with concrete evidence

This runs **after each completed slice** (except the final one).

### 8. Observability Planning

Not a separate unit — it's a section within plan-slice that defines:
- How a future agent will inspect state, detect failure, and localize problems
- Structured logs/events, stable error codes, status surfaces, persisted failure state
- At least one verification check for a diagnostic or failure-path signal

Observability validation also runs at dispatch time, emitting warnings if plans lack these sections.

## The Solution

Two new fields in `~/.gsd/preferences.md` (global) or `.gsd/preferences.md` (project):

### `planning_depth` — Quick Shortcut

```yaml
---
planning_depth: standard
---
```

| Value | Research | Self-Audit | Reassessment | Observability |
|-------|----------|------------|--------------|---------------|
| `thorough` (default) | all separate sessions | 10-point check | after each slice | full planning |
| `standard` | milestone kept, slice skipped | skipped | kept | kept |
| `minimal` | all skipped | skipped | skipped | skipped |

### `workflow` — Fine-Grained Control

Override individual flags when the shortcut doesn't fit:

```yaml
---
planning_depth: standard
workflow:
  skip_milestone_research: true    # skip research-milestone unit
  skip_slice_research: true        # skip research-slice unit
  skip_plan_self_audit: false      # keep the 10-point audit (overrides standard)
  skip_reassessment: false         # keep roadmap reassessment after slices
  skip_observability: false        # keep observability/diagnostics in plans
---
```

Individual `workflow.*` flags always override `planning_depth`.

## What Each Flag Does

### `skip_milestone_research`

Skips the `research-milestone` unit. Instead of a separate session exploring the codebase and writing a RESEARCH.md, the planning session proceeds directly.

**Default:** `false` (thorough/standard), `true` (minimal)

### `skip_slice_research`

Skips the `research-slice` unit. Same idea — no separate research session per slice, planning goes straight to decomposing tasks.

**Default:** `false` (thorough), `true` (standard/minimal)

### `skip_plan_self_audit`

Removes the 10-point self-audit checklist from slice planning. The plan-slice agent will still write task plans, but won't walk through the verification checklist before finishing.

**Default:** `false` (thorough), `true` (standard/minimal)

### `skip_reassessment`

Skips the `reassess-roadmap` unit that runs after each slice completes. Slices execute back-to-back without pausing to re-evaluate whether the remaining roadmap still covers all success criteria.

**Default:** `false` (thorough/standard), `true` (minimal)

### `skip_observability`

Removes observability/diagnostics sections from planning prompts and suppresses observability validation warnings at dispatch time.

**Default:** `false` (thorough/standard), `true` (minimal)

## Recommended Configurations

| Scenario | Config | Why |
|----------|--------|-----|
| Large unfamiliar codebase, high stakes | `planning_depth: thorough` | Research catches pitfalls. Self-audit prevents bad plans. Worth the extra sessions. |
| Familiar codebase, medium features | `planning_depth: standard` | You already know the code. Skip research and self-audit. Planning still writes proper artifacts. |
| Small features, bug fixes, quick iterations | `planning_depth: minimal` | Get to execution fast. No research, no self-audit, no reassessment, no observability overhead. |
| Greenfield project, first milestone | `thorough` + `skip_plan_self_audit: true` | Research is valuable when nothing exists yet. But the 10-point audit is overkill for initial scaffolding. |
| Familiar codebase, risky integration | `standard` + `skip_reassessment: false` | Skip research (you know the code), but keep reassessment because cross-boundary work can drift. |
| Solo dev, fast iteration | `planning_depth: minimal` | You're the quality gate. Let the agent plan and execute. |
| Team project with PRs | `planning_depth: standard` | PR review replaces the self-audit. Research is redundant if the team already discussed the approach. |

## Examples

### Fastest pipeline for small projects

```yaml
---
planning_depth: minimal
---
```

Pipeline becomes: `plan-milestone → plan-slice → execute` with lightweight prompts.

### Skip research but keep quality gates

```yaml
---
planning_depth: standard
workflow:
  skip_plan_self_audit: false
---
```

No research sessions, but slice plans still get the full 10-point self-audit.

### Only skip milestone-level research

```yaml
---
workflow:
  skip_milestone_research: true
---
```

Everything else stays at `thorough` defaults. Slice research, self-audit, reassessment, and observability all remain active.

## How It Works

The `planning_depth` shortcut expands into default values for all five `workflow.*` flags. Any explicitly set `workflow.*` flag then overrides the expanded default. This means you can use `planning_depth` as a baseline and fine-tune specific flags.

Resolution order:
1. Read `planning_depth` (defaults to `thorough`)
2. Expand into five boolean defaults
3. Apply any explicit `workflow.*` overrides on top

Project-level preferences (`.gsd/preferences.md`) override global preferences (`~/.gsd/preferences.md`) following the same merge rules as all other GSD preferences.
