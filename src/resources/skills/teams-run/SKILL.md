---
name: teams-run
description: "Resume building a single Teams plan. Orchestrator spawns sequential or parallel builder subagents per incomplete phase, then a reviewer subagent, then applies fixes."
user-invocable: true
---

# Teams: Run (Resume Build)

You are the orchestrator. Resume an existing build by running all incomplete phases, then reviewing and applying fixes.

---

## Step 1: Find the Plan

List all files matching `.lsd/plan/PLAN-*.md`. If none exist:
> No plan files found in `.lsd/plan/`. Use `/teams-plan` to create a plan first.

If multiple plan files exist, show the list and ask the user which plan to resume. Default to the highest-numbered plan.

Read the selected plan file (e.g. `.lsd/plan/PLAN-2.md`). Store the filename as `PLAN_FILE`.

Identify:
- Plan ID (the `Plan ID:` field — e.g. `#2`)
- All phases, their status (`[x]` = done, `[!]` = failed, `[ ]` = incomplete), their complexity annotation (`complexity: simple` or `complexity: standard`), and any `parallel-group` annotations
- Platform (web or mobile)
- Verification scenarios

Print the current state:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  RALPH-TEAMS Plan #[N] — Resuming — [N of M phases already done]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✓  Phase 1: Project Setup          [done]
  ✓  Phase 2: Auth System            [done]
  ○  Phase 3: API Routes             [pending]
  ○  Phase 4: Frontend               [pending]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Step 1.5: Choose Execution Mode

Check whether any incomplete phases have a `parallel-group` annotation.

**If none do:** set `EXEC_MODE = sequential` automatically — skip this step entirely.

**If at least one incomplete phase has `parallel-group`:** ask the user:

> **"Would you like to run remaining phases in parallel or sequential mode?**
> - **Sequential** (default): phases run one at a time in order — safer, easier to debug
> - **Parallel**: independent phase groups run simultaneously — faster
>
> The plan has [M] incomplete phase(s) marked for parallel execution. Reply `parallel` or `sequential`."

Save the answer as `EXEC_MODE` (`parallel` or `sequential`).

---

## Step 2: Execute — Builder Subagents

Capture the base commit SHA before building starts:
```bash
git rev-parse HEAD
```
Save this as `BASE_SHA`.

**Group incomplete phases into execution batches:**
- Phases without `parallel-group` → each is its own batch (always sequential)
- Phases sharing the same `parallel-group` label → form one batch
- Batches execute in the order the first phase of each batch appears in the plan
- Skip already-completed phases (`[x]`)

**For each batch, execute as follows:**

**If `EXEC_MODE = sequential` OR batch has only 1 phase:**

Use the `subagent` tool in single mode:

```
subagent({
  agent: "teams-builder",
  task: "You are implementing Phase [N] of [M]: [phase description].

Tasks to complete:
[list tasks from the phase]

Platform: [web|mobile]

Plan file: [PLAN_FILE] — read this file for full context, acceptance criteria, and verification scenarios.

Your assignment: implement Phase [N] only, completing all its tasks. Verify it works using [Playwright|Maestro], then commit.
If [Playwright|Maestro] tools are not available, run tests/lint instead and note that E2E verification was skipped."
})
```

**If `EXEC_MODE = parallel` AND batch has 2+ phases:**

Use the `subagent` tool in parallel mode — pass all phases in the batch as a single `tasks` array:

```
subagent({
  tasks: [
    {
      agent: "teams-builder",
      task: "You are implementing Phase [N] of [M] (running in parallel with Phase [N2]): [phase description].

Tasks to complete:
[list tasks]

Platform: [web|mobile]

Plan file: [PLAN_FILE] — read this file for full context, acceptance criteria, and verification scenarios.

IMPORTANT: You are running in parallel with other builders. Only modify files for your specific phase.
Do not modify shared config files, package.json, or files touched by parallel phases.
Your assignment: implement Phase [N] only. Verify it works, then commit with message: 'feat: [phase name]'."
    },
    {
      agent: "teams-builder",
      task: "You are implementing Phase [N2] of [M] (running in parallel with Phase [N]): ..."
    }
  ]
})
```

After each batch completes, update `[PLAN_FILE]` (change `[ ]` to `[x]` on success, `[!]` on failure for each phase) and reprint the phase board:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  RALPH-TEAMS  [N of M phases complete]  [SEQUENTIAL | PARALLEL]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✓  Phase 1: Project Setup          [done]
  ►  Phase 2: Auth System            [building...] ┐ parallel-group A
  ►  Phase 3: DB Schema              [building...] ┘
  ○  Phase 4: API Routes             [pending]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Status symbols: `✓` completed · `►` in progress · `✗` failed · `○` pending

If a builder subagent fails, log it as failed and continue with the next batch.

---

## Step 3: Review

After all phases complete, print:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  RALPH-TEAMS  Reviewing implementation...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Spawn the reviewer:

```
subagent({
  agent: "teams-reviewer",
  task: "Review the implementation for: [feature name].

Base commit (before build started): [BASE_SHA]
Use `git diff [BASE_SHA]..HEAD` to see all changes.

Plan file: [PLAN_FILE] — read this file for phases, acceptance criteria, and verification scenarios.

Append your review to [PLAN_FILE] as a '## Review' section."
})
```

---

## Step 4: Apply Fixes

Read the `## Review` section from `[PLAN_FILE]`. If there are **blocking findings** (issues the reviewer escalated — not ones already marked `[fixed by reviewer]`):
1. Print a summary of the findings.
2. Spawn a fix-pass builder:
   ```
   subagent({
     agent: "teams-builder",
     task: "You are applying review fixes (not implementing a new phase).

Review findings to fix (from '## Review' section of [PLAN_FILE]):
[paste blocking findings]

Platform: [web|mobile]

Fix each blocking issue. Verify the fixes work using [Playwright|Maestro].
If verification tools are not available, run tests/lint instead.
Commit all fixes together with message: 'fix: address review findings'."
   })
   ```
3. After the fix-pass builder completes, append a fix summary to `[PLAN_FILE]`:
   ```markdown
   ---

   ## Review Fixes Applied

   Fixes: [brief description of what was changed]
   Commit: fix: address review findings
   Status: All blocking findings resolved
   ```
   Also update the `## Review` section in the plan to mark any blocking findings as `Resolved` inline.

Final summary:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  RALPH-TEAMS  Plan #[N] — Build complete!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✓  Phase 1: ...
  ✓  Phase 2: ...
  ✓  Review: [passed | N fixes applied]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Then suggest:
> **Build done. Run `/teams-verify` to walk through manual E2E verification.**

---

## Step 5: Optional — Update Docs

Ask the user:

> **"Would you like to update your documentation? Run `/teams-document` to have the scribe update your README, ARCHITECTURE.md, and other docs."**

If yes, invoke the `teams-document` skill.

If **no**, skip.
