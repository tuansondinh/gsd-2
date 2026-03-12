# Configurable Workflow Depth

Control how much research and verification GSD runs before executing code.

## The Problem

By default, GSD runs 4 separate LLM sessions before writing a single line of code:

```
research-milestone → plan-milestone → research-slice → plan-slice → execute
```

For a milestone with 3 slices, that's **8 research/planning sessions** before execution starts. Each planning session also includes a 10-point self-audit, observability planning, and post-slice reassessment — all useful for large projects, but overhead for smaller or familiar work.

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
| `thorough` (default) | separate session | 10-point check | after each slice | full planning |
| `standard` | skipped | skipped | kept | kept |
| `minimal` | skipped | skipped | skipped | skipped |

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

**Default:** `false` (thorough), `true` (standard/minimal)

### `skip_slice_research`

Skips the `research-slice` unit. Same idea — no separate research session per slice, planning goes straight to decomposing tasks.

**Default:** `false` (thorough), `true` (standard/minimal)

### `skip_plan_self_audit`

Removes the 10-point self-audit checklist from slice planning. This audit checks completion semantics, requirement coverage, task completeness, dependency correctness, key links, scope sanity, context compliance, proof honesty, and feature completeness. Useful, but time-consuming.

**Default:** `false` (thorough), `true` (standard/minimal)

### `skip_reassessment`

Skips the `reassess-roadmap` unit that runs after each slice completes. This unit validates whether the remaining roadmap still covers all success criteria. Disabling it means slices execute back-to-back without a pause to re-evaluate.

**Default:** `false` (thorough/standard), `true` (minimal)

### `skip_observability`

Removes observability/diagnostics sections from planning prompts and suppresses observability validation warnings at dispatch time. These sections define how future agents should inspect state and detect failures.

**Default:** `false` (thorough/standard), `true` (minimal)

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

No research sessions, but slice plans still get the full self-audit.

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
