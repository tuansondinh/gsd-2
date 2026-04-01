---
name: teams-debug
description: "Fix any bug related to an active Teams plan. Can be triggered by the user at any time or automatically from teams-verify on failure. Reads the plan for context, spawns a targeted builder subagent to fix the issue, then appends a debug status update to the plan."
user-invocable: true
---

# Teams: Debug

Fix a bug related to the current Teams plan. This skill can be triggered:
- **By the user at any time** — e.g. "something's broken, use `/teams-debug`"
- **Automatically from `/teams-verify`** — when a scenario fails during manual verification

It reads the plan (which contains all review and verification history) before fixing.

**Prerequisite:** A `.lsd/plan/PLAN-*.md` file must exist. If none found, stop and tell the user to run `/teams-plan` first.

---

## Step 1: Load Context

Find and read the most recent `.lsd/plan/PLAN-*.md` (highest number). Store as `PLAN_FILE`.

It contains the full plan, review findings, and verification results.

---

## Step 2: Identify the Bug

If the user described the bug when invoking this skill, use that description.

Otherwise, ask:

> **What's the bug?**
>
> Describe what went wrong, what you expected, and what you saw. Include the scenario name if it came from `/teams-verify`.

Wait for their response.

---

## Step 3: Confirm Scope

Summarize your understanding back to the user:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  RALPH-TEAMS Plan #[N] — Bug report
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Feature:   [feature name from plan]
  Bug:       [one-line summary]
  Related:   [phase(s)/task(s) or scenario(s) from the plan]
  Criteria:  [affected acceptance criteria, if any]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Ask:
> **Correct? Reply `yes` to fix, or clarify what I got wrong.**

---

## Step 4: Spawn a Fix Builder

When confirmed, print:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  RALPH-TEAMS  Plan #[N] — Fixing bug...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Spawn a builder subagent:

```
subagent({
  agent: "teams-builder",
  task: "You are fixing a bug found during manual verification of a completed feature.

Bug report:
[user's bug description]

Full plan (includes review findings and verification results):
[paste full PLAN_FILE content]

Instructions:
- Investigate the root cause of the bug before making changes
- Fix only what is broken — do not refactor unrelated code
- Platform: [web|mobile from plan]
- Verify the fix using [Playwright|Maestro] after applying it
- If verification tools are not available, run tests/lint instead
- Commit with message: 'fix: [short description of the bug fixed]'"
})
```

---

## Step 5: Append Debug Status to Plan

After the builder completes, append a `## Debug Fix` entry to `[PLAN_FILE]` (do not overwrite — append at the end):

```markdown
---

## Debug Fix

Date: [date]
Bug: [one-line summary]
Fix: [brief description of what was changed]
Commit: fix: [commit message]
Status: Resolved
```

If the `## Verification` section exists in the plan and has a matching failed scenario, update that scenario's status inline from `FAIL` to `FIXED`.

---

## Step 6: Done

Print:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  RALPH-TEAMS  Plan #[N] — Fix applied
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Bug:    [summary]
  Status: Fixed + committed
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Then ask:
> **Want to re-verify this scenario? Run `/teams-verify` to continue from where you left off.**
