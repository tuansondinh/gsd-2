---
name: teams-verify
description: "Guide the user through manually verifying the build E2E — walks through each scenario step-by-step, records pass/fail, and appends a verification status update to the plan file."
user-invocable: true
---

# Teams: Manual Verify

You guide the user through manually verifying the completed build end-to-end. One scenario at a time. You record their results and append a status update to the plan.

---

## Step 1: Load the Plan

Find and read the most recent `.lsd/plan/PLAN-*.md` (highest number). Store as `PLAN_FILE`. If none exist:
> No plan files found in `.lsd/plan/`. Run `/teams-plan` first.

Extract:
- Plan ID (the `Plan ID:` field — e.g. `#2`)
- All tasks
- Acceptance criteria
- Verification scenarios
- Any existing `## Review` section (to know what the automated reviewer already flagged)

---

## Step 2: Setup Check

Before starting, ask the user:

> **Before we verify, confirm setup:**
>
> - Is the app running? (URL or device/simulator)
> - Any test accounts or data needed?
> - Anything you want to skip?

Wait for their response. Note any skips.

---

## Step 3: Walk Through Scenarios

For each verification scenario from the plan, present it one at a time:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  RALPH-TEAMS Plan #[N] — Scenario [N of M]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  [Scenario name]

  Steps:
  1. [Step]
  2. [Step]
  3. [Step]

  Expected result:
  [What the user should see]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Then ask:
> **Result? `pass` / `fail` / `skip` — or describe what you saw.**

- **pass** → record it, move to next scenario
- **fail** → ask: *"What went wrong?"* Record their description. Then immediately offer:
  > **Bug detected. Run `/teams-debug` to fix it now, or continue verifying the rest first?**

  If they say **fix now**: invoke the `teams-debug` skill directly, passing the scenario name and their failure description as context. After the fix is applied, re-run this scenario before continuing.

  If they say **continue**: record the failure and move to the next scenario.
- **skip** → record as skipped with reason, move on

Keep going until all scenarios are covered.

---

## Step 4: Append Verification Status to Plan

Append a `## Verification` section to `[PLAN_FILE]` (do not overwrite anything — append at the end):

```markdown
---

## Verification

Date: [date]
Verified by: User
Summary: [N passed, N failed, N skipped]

- ✓ [Scenario name]: PASS
- ✗ [Scenario name]: FAIL — [what user reported]
- — [Scenario name]: SKIPPED — [reason]

### Acceptance Criteria
- [x] Criterion 1: verified
- [ ] Criterion 2: FAILED (see above)
```

---

## Step 5: Summary

Print the final result:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  RALPH-TEAMS  Plan #[N] — Done — [N passed, N failed, N skipped]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✓  Scenario 1: [name]
  ✗  Scenario 2: [name]
  —  Scenario 3: [name]  (skipped)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

If there are failures, offer:

> **N scenario(s) failed. Options:**
> - `/teams-debug` — fix bugs one at a time with full plan context (recommended)
> - **Fix all** — I spawn a single builder to address all failures at once

If they choose **`/teams-debug`**: invoke the `teams-debug` skill for each failed scenario in order, passing the scenario name and failure description. After each fix, update the `## Verification` section in the plan to mark the scenario as `FIXED`.

If they choose **fix all**: read the failures from the plan's `## Verification` section and spawn a **Sonnet** builder subagent with the full list of issues. Then offer to re-run verification on just the failed scenarios.
