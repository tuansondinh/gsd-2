# GSD Preferences Reference

Full documentation for `~/.gsd/preferences.md` (global) and `.gsd/preferences.md` (project).

---

## Notes

- Keep this skill-first.
- Prefer explicit skill names or absolute paths.
- Use absolute paths for personal/local skills when you want zero ambiguity.
- These preferences guide which skills GSD should load and follow; they do not override higher-priority instructions in the current conversation.

---

## Field Guide

- `version`: schema version. Start at `1`.

- `always_use_skills`: skills GSD should use whenever they are relevant.

- `prefer_skills`: soft defaults GSD should prefer when relevant.

- `avoid_skills`: skills GSD should avoid unless clearly needed.

- `skill_rules`: situational rules with a human-readable `when` trigger and one or more of `use`, `prefer`, or `avoid`.

- `custom_instructions`: extra durable instructions related to skill use.

- `models`: per-stage model selection for auto-mode. Keys: `research`, `planning`, `execution`, `completion`. Values: model IDs (e.g. `claude-sonnet-4-6`, `claude-opus-4-6`). Omit a key to use whatever model is currently active.

- `skill_discovery`: controls how GSD discovers and applies skills during auto-mode. Valid values:
  - `auto` — skills are found and applied automatically without prompting.
  - `suggest` — (default) skills are identified during research but not installed automatically.
  - `off` — skill discovery is disabled entirely.

- `auto_supervisor`: configures the auto-mode supervisor that monitors agent progress and enforces timeouts. Keys:
  - `model`: model ID to use for the supervisor process (defaults to the currently active model).
  - `soft_timeout_minutes`: minutes before the supervisor issues a soft warning (default: 20).
  - `idle_timeout_minutes`: minutes of inactivity before the supervisor intervenes (default: 10).
  - `hard_timeout_minutes`: minutes before the supervisor forces termination (default: 30).

- `planning_depth`: controls how much research and verification happens before execution. Valid values:
  - `thorough` — (default) full research, planning with self-audit, observability, and reassessment.
  - `standard` — skip separate research units, skip plan self-audit. Planning still does inline codebase exploration.
  - `minimal` — all of standard, plus skip reassessment and observability planning.

- `workflow`: fine-grained overrides for the planning pipeline. Individual keys override `planning_depth`. Keys:
  - `skip_milestone_research`: skip the research-milestone unit (default: false).
  - `skip_slice_research`: skip the research-slice unit (default: false).
  - `skip_plan_self_audit`: remove the 10-point self-audit from slice planning (default: false).
  - `skip_reassessment`: skip roadmap reassessment after each slice (default: false).
  - `skip_observability`: remove observability/diagnostics from plans and suppress warnings (default: false).

---

## Best Practices

- Keep `always_use_skills` short.
- Use `skill_rules` for situational routing, not broad personality preferences.
- Prefer skill names for stable built-in skills.
- Prefer absolute paths for local personal skills.

---

## Models Example

```yaml
---
version: 1
models:
  research: claude-sonnet-4-6
  planning: claude-opus-4-6
  execution: claude-sonnet-4-6
  completion: claude-sonnet-4-6
---
```

Opus for planning (where architectural decisions matter most), Sonnet for everything else (faster, cheaper). Omit any key to use the currently selected model.

---

## Example Variations

**Minimal — always load a UAT skill and route Clerk tasks:**

```yaml
---
version: 1
always_use_skills:
  - /Users/you/.claude/skills/verify-uat
skill_rules:
  - when: finishing implementation and human judgment matters
    use:
      - /Users/you/.claude/skills/verify-uat
---
```

**Richer routing — prefer cleanup and authentication skills:**

```yaml
---
version: 1
prefer_skills:
  - commit-ignore
skill_rules:
  - when: task involves Clerk authentication
    use:
      - clerk
      - clerk-setup
  - when: the user is looking for installable capability rather than implementation
    prefer:
      - find-skills
---
```

---

## Workflow Examples

**Standard depth — skip research, streamline planning:**

```yaml
---
version: 1
planning_depth: standard
---
```

**Minimal depth — fastest pipeline, skip everything optional:**

```yaml
---
version: 1
planning_depth: minimal
---
```

**Custom mix — skip research but keep self-audit:**

```yaml
---
version: 1
planning_depth: standard
workflow:
  skip_plan_self_audit: false
---
```
