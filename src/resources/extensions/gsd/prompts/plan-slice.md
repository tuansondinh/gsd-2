You are executing GSD auto-mode.

## UNIT: Plan Slice {{sliceId}} ("{{sliceTitle}}") — Milestone {{milestoneId}}

All relevant context has been preloaded below — start working immediately without re-reading these files.

{{inlinedContext}}

### Dependency Slice Summaries

Pay particular attention to **Forward Intelligence** sections — they contain hard-won knowledge about what's fragile, what assumptions changed, and what this slice should watch out for.

{{dependencySummaries}}

Narrate your decomposition reasoning — why you're grouping work this way, what risks are driving the order, what verification strategy you're choosing and why. Keep the narration proportional to the work — a simple slice doesn't need a long justification.

**Right-size the plan.** If the slice is simple enough to be 1 task, plan 1 task. Don't split into multiple tasks just because you can identify sub-steps. Don't fill in sections with "None" when the section doesn't apply — omit them entirely. The plan's job is to guide execution, not to fill a template.

Then:
0. If `REQUIREMENTS.md` was preloaded above, identify which Active requirements the roadmap says this slice owns or supports. These are the requirements this plan must deliver — every owned requirement needs at least one task that directly advances it, and verification must prove the requirement is met.
1. Read the templates:
   - `~/.gsd/agent/extensions/gsd/templates/plan.md`
   - `~/.gsd/agent/extensions/gsd/templates/task-plan.md`
2. If a `GSD Skill Preferences` block is present in system context, use it to decide which skills to load and follow during planning, without overriding required plan formatting
3. Define slice-level verification — the objective stopping condition for this slice:
   - For non-trivial slices: plan actual test files with real assertions. Name the files.
   - For simple slices: executable commands or script assertions are fine.
   - If the project is non-trivial and has no test framework, the first task should set one up.
   - If this slice establishes a boundary contract, verification must exercise that contract.
{{observabilityStep}}
5. Fill the `Proof Level` and `Integration Closure` sections truthfully:
   - State whether the slice proves contract, integration, operational, or final-assembly behavior.
   - Say whether real runtime or human/UAT is required.
   - Name the wiring introduced in this slice and what still remains before the milestone is truly usable end-to-end.
6. Decompose the slice into tasks, each fitting one context window. Each task needs:
   - a concrete, action-oriented title
   - the inline task entry fields defined in the plan.md template (Why / Files / Do / Verify / Done when)
   - a matching task plan file with description, steps, must-haves, verification, inputs, and expected output
   - Observability Impact section **only if the task touches runtime boundaries, async flows, or error paths** — omit it otherwise
7. Write `{{outputPath}}`
8. Write individual task plans in `{{sliceAbsPath}}/tasks/`: `T01-PLAN.md`, `T02-PLAN.md`, etc.
{{selfAuditStep}}
10. If planning produced structural decisions (e.g. verification strategy, observability strategy, technology choices, patterns to follow), append them to `.gsd/DECISIONS.md`
11. Commit: `docs({{sliceId}}): add slice plan`
12. Update `.gsd/STATE.md`

The slice directory and tasks/ subdirectory already exist. Do NOT mkdir. You are on the slice branch; all work stays here.

**You MUST write the file `{{outputAbsPath}}` before finishing.**

When done, say: "Slice {{sliceId}} planned."
