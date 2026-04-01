# Plan: Port Teams skills and subagents from `lucent-code` into `lsd`

## Request
Bring over the Teams workflow pieces from `/Users/sonwork/Workspace/lucent-code` into this project, and do the implementation work in a separate git worktree.

## Constraints
- Plan mode only: no source changes yet.
- Persist planning artifacts under `.lsd/plan/`.
- User requested a separate worktree for implementation.

## What I verified

### Source project located
- `/Users/sonwork/Workspace/lucent-code/package.json`

### Target project conventions located
- Current repo root is the `lsd` project.
- `README.md` and `docs/skills.md` indicate LSD skill conventions are:
  - project-local skills: `.lsd/skills/`
  - bundled/global-style resources are synced from repo resources
- Current repo has bundled subagent definitions under `src/resources/agents/` (confirmed with existing files like `src/resources/agents/scout.md`, `researcher.md`, `worker.md`).

### Teams skills found in lucent-code
Located exact source files:
- `/Users/sonwork/Workspace/lucent-code/src/resources/skills/teams-plan/SKILL.md`
- `/Users/sonwork/Workspace/lucent-code/src/resources/skills/teams-run/SKILL.md`

### Teams skill behavior observed
`teams-plan`:
- creates `.ralph-teams/PLAN-[N].md`
- asks for plan review
- supports sequential or parallel execution
- invokes subagents named `teams-builder` and `teams-reviewer`
- optionally suggests `teams-document`

`teams-run`:
- resumes an existing `.ralph-teams/PLAN-[N].md`
- re-runs incomplete phases
- invokes the same `teams-builder` and `teams-reviewer` subagents
- optionally suggests `teams-document`

## Open issue / likely follow-up during execution
I was able to locate the two skill files, but I did **not** yet locate the corresponding subagent definition files with the read-only tools available in plan mode.

The skills clearly reference these subagents:
- `teams-builder`
- `teams-reviewer`

There may also be a related documentation skill/agent path for `teams-document`, but that is not strictly required by the user request as stated.

## Execution plan

### 1. Create a dedicated worktree
Before any code changes:
- create a new git worktree from the `lsd` repo
- use that worktree for all edits and validation
- keep the main checkout untouched

Proposed branch/worktree naming:
- branch: `feature/port-teams-skills`
- worktree dir: sibling worktree or repo-managed worktree path

### 2. In the worktree, fully locate Teams-related source assets in `lucent-code`
Use filesystem search to find all of:
- `teams-builder`
- `teams-reviewer`
- `teams-document`
- any other `teams-*` skills/agents/docs referenced by the two skills

Expected search areas:
- `src/resources/agents/`
- `src/resources/skills/`
- project-local agent directories (if present)
- user/global agent directories only if the lucent project relies on them

### 3. Port the skill files into LSD
Bring over:
- `teams-plan`
- `teams-run`

Likely target location in this repo:
- `src/resources/skills/teams-plan/SKILL.md`
- `src/resources/skills/teams-run/SKILL.md`

While porting, verify whether any branding/path adjustments are needed for LSD compatibility.

### 4. Port or recreate the corresponding subagents
If source files are found, port them into LSD’s bundled agent location:
- `src/resources/agents/teams-builder.md`
- `src/resources/agents/teams-reviewer.md`

If exact source files are not found, implement equivalent bundled subagents based on the contracts implied by the skills:
- `teams-builder`: phase-scoped implementation worker with verification + commit expectations
- `teams-reviewer`: implementation reviewer that compares against the plan and appends a review section

### 5. Validate resource compatibility in LSD
Check whether LSD’s resource syncing/discovery already picks up newly added bundled skills and agents, or whether an index/manifest/update step is needed.

Areas to inspect during execution:
- resource loader / sync logic
- any bundled resource registration lists
- skill discovery expectations for bundled vs project-local assets

### 6. Smoke-check the port
After adding files in the worktree:
- confirm the new skills and agents are discoverable by the runtime conventions used in LSD
- confirm the skill text references valid agent names
- confirm there are no obvious broken paths or naming mismatches

### 7. Report back with exact files changed
Final implementation response should include:
- worktree path/branch used
- copied/adapted source files
- any inferred/recreated agent definitions
- any deviations from lucent-code due to repo differences

## Risks / decisions to watch
- The Teams skills use `.ralph-teams/` plan files. Decide whether to preserve this exact path or adapt it for LSD conventions. Default should be: preserve behavior unless there is a clear incompatibility.
- The skills mention `teams-document`; if LSD does not also receive that skill, keep the reference only if it is already valid or note it as a follow-up.
- If lucent-code relies on user-level rather than repo-bundled agents, the LSD port should prefer repo-bundled equivalents so the feature is self-contained.

## Status
- Investigation complete enough to start execution in a worktree.
- No source files modified yet.
- Plan artifact saved here: `.lsd/plan/teams-skills-port-plan.md`
