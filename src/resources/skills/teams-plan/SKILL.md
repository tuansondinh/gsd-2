---
name: teams-plan
description: "Plan and build a feature. Orchestrator plans, spawns sequential builder subagents per phase (with Playwright/Maestro verification), then a reviewer subagent, then a builder to apply fixes. Supports parallel mode for independent phases."
user-invocable: true
---

# Teams: Plan + Build

You are the planner and orchestrator. Your job: discuss the feature, create a plan, execute it with sequential builder subagents, review the result with a reviewer subagent, and apply fixes.

---

## Step 1: Discuss + Plan

Ask: **"What do you want to build?"**

Discuss with the user. Identify the target platform: **web** or **mobile** (this determines whether the builder uses Playwright or Maestro for verification).

**Phase sizing:** Each phase runs in its own builder agent with a 200k token context window. A well-sized phase **MUST target ~60% of that context** — enough that the builder is doing substantial work, but not so much that it risks context exhaustion (context rot). Phases contain tasks (concrete steps the builder follows).
- **Too small:** a phase that takes only a few minutes or touches one file — merge it into a related phase or make it a task within a larger phase.
- **Too big:** a phase whose tasks would push the builder past ~60% context — context rot causes quality to degrade. Split it into two phases.
- **Right size:** "Implement full auth system" (tasks: user model + DB migration, signup/login endpoints, JWT middleware + refresh tokens, password reset flow, email verification, auth guards on all protected routes, unit + integration tests), "Build product catalog" (tasks: product model + seed data, list page with filters + pagination, detail page, search endpoint, cart integration, component tests).

> **Rule of thumb:** a phase = one meaningful feature area with enough depth to keep a builder busy for a substantial session. Tasks = the concrete steps the builder takes to complete it. Aim for 4–8 tasks per phase. Target ~60% context usage — not less (wasted capacity), not more (context rot).

**Phase complexity:** For each phase, assign a complexity level:
- `simple`: truly trivial phases only — renaming, copy changes, config tweaks, adding a single field
- `standard`: everything else — the default for any phase with real logic, UI, CRUD, auth, migrations, architecture, etc.

**Parallel phases:** Identify phases that are fully independent (no shared files, no ordering dependency) and can safely run at the same time. Annotate these with `parallel-group: [A/B/C/...]`. Phases sharing the same group label will run concurrently in parallel mode. Phases without a `parallel-group` annotation always run sequentially.

> **Safety rule:** Only mark phases as parallel if they touch completely different parts of the codebase and have no dependencies on each other's output. When in doubt, leave them sequential.

**Prepare the build directory:**

```bash
mkdir -p .lsd/plan
```

**Determine the plan number:**
- Check for existing plan files: `.lsd/plan/PLAN-*.md`
- Count existing files to determine N (next plan number = count + 1)
- If plans exist, inform the user:
  > **Found [N-1] existing plan(s). Creating Plan #[N]. Use `/teams-run` to resume an existing plan.**
- If no existing plans: plan number = 1

Write `.lsd/plan/PLAN-[N].md`:

```markdown
# Plan #[N]: [Feature Name]

Plan ID: #[N]
Generated: [date]
Platform: web | mobile
Status: draft

## Phases
1. [ ] Phase 1: [Description] — complexity: simple
   - [Task 1 description]
   - [Task 2 description]
2. [ ] Phase 2: [Description] — complexity: standard — parallel-group: A
   - [Task 1 description]
   - [Task 2 description]
   - [Task 3 description]
3. [ ] Phase 3: [Description] — complexity: standard — parallel-group: A
   - [Task 1 description]
   - [Task 2 description]

## Acceptance Criteria
- [Criterion 1]
- [Criterion 2]

## Verification
Tool: Playwright | Maestro
Scenarios:
- [Scenario 1: name — steps — expected result]
- [Scenario 2: name — steps — expected result]
```

---

## Step 2: Optional Plan Review

After writing the draft plan, ask the user:

> **"Would you like another AI to review this plan for completeness and edge cases? (Recommended: Yes)"**

If **yes**:
1. Read `.lsd/plan/PLAN-[N].md`.
2. Run via Bash:
   ```bash
   echo "Review this implementation plan. Identify missing phases, edge cases, or architectural gaps. Be concise.\n\n$(cat .lsd/plan/PLAN-[N].md)" | codex exec -m gpt-5.4
   ```
3. Evaluate the feedback. Incorporate valid findings into `.lsd/plan/PLAN-[N].md`.
4. Briefly tell the user what changed.

If **no**: skip to Step 3.

---

## Step 3: Get Approval

Display `.lsd/plan/PLAN-[N].md` and ask:

> **"Plan looks good? Reply `yes` to start, or tell me what to change."**

---

## Step 3.5: Choose Execution Mode

After approval, check whether any phases have a `parallel-group` annotation.

**If no phases have `parallel-group`:** all phases are sequential — skip this step and set `EXEC_MODE = sequential` automatically.

**If at least one `parallel-group` exists:** ask the user:

> **"Would you like to run phases in parallel or sequential mode?**
> - **Sequential** (default): phases run one at a time in order — safer, easier to debug
> - **Parallel**: independent phase groups run simultaneously — faster
>
> The plan has [N] phase(s) marked for parallel execution. Reply `parallel` or `sequential`."

Save the answer as `EXEC_MODE` (`parallel` or `sequential`).

---

## Step 4: Execute — Builder Subagents

When approved:

1. Update `.lsd/plan/PLAN-[N].md` status to `approved`.
2. Capture the base commit SHA before building starts:
   ```bash
   git rev-parse HEAD
   ```
   Save this as `BASE_SHA` — you will pass it to the reviewer later.
3. Print:
   ```
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     RALPH-TEAMS Plan #[N] — Starting build... [SEQUENTIAL | PARALLEL]
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ```

**Group phases into execution batches:**
- Phases without `parallel-group` → each is its own batch (always sequential)
- Phases sharing the same `parallel-group` label → form one batch
- Batches execute in the order the first phase of each batch appears in the plan

Example grouping for phases `[1, 2(A), 3(A), 4, 5(B), 6(B)]`:
- Batch 1: Phase 1 (sequential)
- Batch 2: Phases 2+3 (parallel-group A)
- Batch 3: Phase 4 (sequential)
- Batch 4: Phases 5+6 (parallel-group B)

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

Plan file: .lsd/plan/PLAN-[N].md — read this file for full context, acceptance criteria, and verification scenarios.

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

Plan file: .lsd/plan/PLAN-[N].md — read this file for full context, acceptance criteria, and verification scenarios.

IMPORTANT: You are running in parallel with other builders. Only modify files for your specific phase.
Do not modify shared config files, package.json, or files touched by parallel phases.
Your assignment: implement Phase [N] only. Verify it works, then commit with message: 'feat: [phase name]'."
    },
    {
      agent: "teams-builder",
      task: "You are implementing Phase [N2] of [M] (running in parallel with Phase [N]): [phase description].
      ... (same structure)"
    }
  ]
})
```

After each batch completes, update `.lsd/plan/PLAN-[N].md` (change `[ ]` to `[x]` on success, `[!]` on failure for each phase) and print the phase board:

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

## Step 5: Review

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

Plan file: .lsd/plan/PLAN-[N].md — read this file for phases, acceptance criteria, and verification scenarios.

Append your review to .lsd/plan/PLAN-[N].md as a '## Review' section."
})
```

---

## Step 6: Apply Fixes

After the reviewer completes, read the `## Review` section from `.lsd/plan/PLAN-[N].md`.

If there are **blocking findings** (issues the reviewer escalated — not ones already marked `[fixed by reviewer]`):
1. Print a summary of the review findings.
2. Spawn a fix-pass builder:
   ```
   subagent({
     agent: "teams-builder",
     task: "You are applying review fixes (not implementing a new phase).

Review findings to fix (from '## Review' section of .lsd/plan/PLAN-[N].md):
[paste blocking findings]

Platform: [web|mobile]

Fix each blocking issue. Verify the fixes work using [Playwright|Maestro].
If verification tools are not available, run tests/lint instead.
Commit all fixes together with message: 'fix: address review findings'."
   })
   ```
3. Print final summary when done.

If no blocking findings, print final summary directly.

Final summary format:
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

## Step 7: Optional — Update Docs

Ask the user:

> **"Would you like to update your documentation? Run `/teams-document` to have the scribe update your README, ARCHITECTURE.md, and other docs."**

If yes, invoke the `teams-document` skill.

If **no**, skip.
