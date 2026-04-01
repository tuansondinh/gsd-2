---
name: teams-document
description: "Update existing project docs (README.md, ARCHITECTURE.md, etc.) and the active plan file to reflect the latest build. Spawns a worker subagent scribe to find and update relevant documentation files and ensure the plan is accurate, then appends a docs status update to the plan."
user-invocable: true
---

# Teams: Document

Update existing project documentation to reflect what was built in the current plan. Spawns a worker subagent that finds relevant docs and updates them — no new files created unless explicitly needed.

**Prerequisite:** A `.lsd/plan/PLAN-*.md` file must exist. If none found, stop:
> No plan files found in `.lsd/plan/`. Run `/teams-plan` first.

---

## Step 1: Load Context

Find and read the most recent `.lsd/plan/PLAN-*.md` (highest number). Store as `PLAN_FILE`.

Run `git log --oneline` to identify recent commits from the build.

---

## Step 2: Confirm Scope

Show the user what will be updated:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  RALPH-TEAMS Plan #[N] — [Feature Name]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Scribe will scan for and update:
  • [PLAN_FILE] (verify phase statuses + overall status)
  • README.md
  • ARCHITECTURE.md
  • docs/**
  • Any other relevant docs found
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Ask:
> **Anything to skip or add? Reply `go` to start, or tell me what to adjust.**

---

## Step 3: Spawn the Scribe

When confirmed, print:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  RALPH-TEAMS  Plan #[N] — Updating docs...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Spawn a worker subagent:

```
subagent({
  agent: "worker",
  task: "You are a documentation scribe. Your job is to update existing project documentation to reflect recent changes — not to create new files.

Plan ID: #[N]
Feature: [feature name]

Phases completed:
[paste phase list from PLAN_FILE]

Acceptance criteria:
[paste acceptance criteria from PLAN_FILE]

Instructions:
1. Update [PLAN_FILE] first:
   - Run `git log --oneline` to verify which phases were actually committed.
   - Ensure each phase checkbox matches reality: `[x]` if committed, `[!]` if it failed, `[ ]` if not started.
   - Update the top-level `Status:` field to reflect the current state (e.g., `complete`, `in-progress`).
2. Find all existing documentation files: README.md, ARCHITECTURE.md, docs/**, CHANGELOG.md, or any other .md files that describe the project.
3. For each relevant file, update only the sections affected by the completed phases — do not rewrite unrelated content.
4. Keep changes minimal and accurate. Only document what was actually built.
5. Do NOT create new documentation files unless one is completely missing and clearly expected (e.g., no README.md at all).
6. After updating, commit all changes with message: 'docs: update docs for Plan #[N] — [feature name]'
7. Report back: list each file you updated and a one-line summary of what changed.

What to update (examples):
- README: feature descriptions, usage instructions, setup steps
- ARCHITECTURE.md: new components, changed data flows, updated diagram descriptions
- CHANGELOG.md: add an entry for this feature
- API docs: new or changed endpoints"
})
```

---

## Step 4: Append Docs Status to Plan

After the scribe completes, append a `## Documentation` section to `[PLAN_FILE]` (do not overwrite — append at the end):

```markdown
---

## Documentation

Date: [date]
Commit: docs: update docs for Plan #[N] — [feature name]

Updated files:
- [filename]: [one-line summary of what changed]
- [filename]: [one-line summary of what changed]
```

---

## Step 5: Done

Print:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  RALPH-TEAMS  Plan #[N] — Docs updated
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  [list of files updated by the scribe]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```
