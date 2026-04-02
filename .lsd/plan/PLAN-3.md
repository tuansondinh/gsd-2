# Plan #3: Todo Batch — Subagents/Skills Fix, Model/Provider Updates, Plan Mode UX

Plan ID: #3
Generated: 2025-04-02
Platform: web
Status: draft

## Summary

Tackle 6 open items from todo.md across three related groups:

**Group A — Subagents & Skills:**
1. Fix subagents with skills — lsd is not aware how to use corectl models
2. Verify that custom subagents and skills work
3. Check that auto memory really uses budget model

**Group B — Model & Provider Management:**
4. Add Bedrock to the onboarding setup command
5. Add missing model: gpt-5.4-mini

**Group C — Plan Mode UX:**
6. Plan mode: auto-switch to high reasoning model after plan is generated; show approval dialog for user to approve and switch to bypass or auto mode

## Architecture Decision: Model Resolution Ownership

**Decision:** The PARENT process resolves all model aliases (like `$budget_model`) to fully-qualified `provider/id` strings BEFORE spawning child processes. Children receive stable, resolved model strings via `--model` flag and never need to resolve aliases themselves.

**Rationale:** Child processes may not have the same extension/model registries loaded. Resolving in the parent guarantees consistency and avoids boot-order dependencies in child processes.

## Phases

1. [ ] Phase 1: Subagent Model Resolution & Corectl Awareness — complexity: standard
   - **Architecture:** Enforce parent-resolves-all-aliases pattern — the parent process resolves `$budget_model` and other aliases to `provider/id` strings before passing `--model` to child processes
   - Audit `runSingleAgent()` in `src/resources/extensions/subagent/index.ts`: verify that `resolveConfiguredSubagentModel()` → `resolveSubagentModel()` chain produces a fully-qualified `provider/id` string, not an alias
   - Fix `resolveConfiguredSubagentModel()` in `configured-model.ts`: when `$budget_model` is resolved, ensure the output is a valid `provider/id` format (e.g. `anthropic/claude-haiku-4-5`), not just a model ID
   - Fix `resolveSubagentModel()` in `model-resolution.ts`: ensure the fallback to `parentModel` produces `provider/id` format consistently
   - Handle edge case: when resolved model is an extension-provided model (e.g. `claude-code/claude-sonnet-4-6`), verify the child process receives `GSD_BUNDLED_EXTENSION_PATHS` so extensions that provide that model are loaded
   - Verify `auto-extract.ts` (auto memory): trace `readBudgetMemoryModel()` → headless spawn — ensure it passes a fully-qualified model string, not a bare alias
   - Handle edge cases: missing/empty `budgetSubagentModel` in settings, malformed model strings, extension loading failure in child
   - Add/update unit tests in `src/tests/subagent-model-inference.test.ts`: resolved model format validation, `$budget_model` with and without settings, parent model fallback, empty/malformed input
   - Run existing tests to ensure nothing is broken

2. [ ] Phase 2: Custom Subagents & Skills Verification — complexity: standard
   - **Unit tests for discovery:** Add tests for `discoverAgents()` covering: user-level agents (`~/.lsd/agent/agents/`), project-local agents (`.lsd/agents/`), name collision/override rules (project overrides user), scope filtering (`user`/`project`/`both`)
   - Test agent frontmatter parsing: valid frontmatter, missing required fields (name/description), `$budget_model` special value, invalid/malformed model strings, empty tools list
   - Verify `GSD_BUNDLED_EXTENSION_PATHS` propagation: check that `runSingleAgent()` reads env and passes `--extension` flags to child process — test with missing/empty/multiple paths
   - Test skill discovery: verify skills from `~/.agents/skills/`, project-local `.lsd/skills/`, and bundled `dist/resources/skills/` are found — test name shadowing between project-local and user-level
   - Integration test: spawn a scout agent with `$budget_model`, verify it receives the resolved model string and starts successfully
   - Test the `teams-builder` and `teams-reviewer` built-in agents can be found and spawned
   - Fix any issues discovered during verification
   - Run the full test suite to confirm no regressions

3. [ ] Phase 3: Add Bedrock to Onboarding + gpt-5.4-mini Model — complexity: standard — parallel-group: A
   - **Provider ID consistency:** Determine the correct Bedrock provider ID used across the runtime — check `aws-auth` extension, any existing Bedrock provider registration, and `cli.ts` provider management. Use the same ID everywhere.
   - Add Bedrock as a provider option in onboarding's LLM step in `src/onboarding.ts`:
     - Browser auth option: "AWS SSO Login" — runs `aws sso login --profile <profile>` with profile prompt
     - API key option: prompt for AWS Access Key ID, Secret Access Key, and AWS Region
   - Save credentials to auth storage with the correct provider ID
   - Add Bedrock provider ID to `LLM_PROVIDER_IDS` array so `shouldRunOnboarding()` recognizes it
   - Handle edge case: AWS CLI not installed — detect and show helpful error with install instructions
   - Handle edge case: region configuration — prompt for region and save it (Bedrock requires region)
   - **Settings schema:** Add `gpt-5.4-mini` to `BUDGET_MODEL_OPTIONS` in onboarding with hint `'fast and cheap — OpenAI'`
   - Add `gpt-5.4-mini` to `startup-model-validation.ts` fallback chain if appropriate
   - Ensure backward compatibility: existing `settings.json` without Bedrock config still works
   - Test the modified onboarding flow — verify Bedrock appears as an option, credentials save correctly

4. [ ] Phase 4: Plan Mode Auto-Switch & Approval Dialog — complexity: standard — parallel-group: A
   - **Settings schema:** Add `planModeReasoningModel` to settings.json schema with type `string | undefined`, default `undefined` (uses current model). Add validation for `provider/id` format. Add to `/settings` command if it exists.
   - Read `planModeReasoningModel` from settings in `plan.ts` — add a `readPlanModeReasoningModel()` function similar to `readBudgetSubagentModelFromSettings()` pattern
   - **State machine updates:** Extend `PlanModeState` interface with:
     - `preplanModel?: { provider: string; id: string }` — model before plan mode started
     - `targetPermissionMode?: PermissionMode` — chosen execution mode from approval dialog
   - Save the current model when entering plan mode (`enablePlanMode`)
   - **Approval dialog enhancement:** In `tool_result` handler, when `latestPlanPath` is set and `approvalStatus` becomes `pending`, inject a steering message telling the agent to present approval options via `ask_user_questions`
   - Change the approval question options to: "Approve & switch to Auto mode" / "Approve & switch to Bypass mode" / "Revise plan" / "Cancel"
   - **On approval:** call `pi.setModel()` with `planModeReasoningModel` (if configured and different from current), then `setPermissionMode()` to chosen mode (auto/bypass)
   - **Edge cases:**
     - Current model already equals reasoning model → skip model switch, just change permission mode
     - Revise after switch → model stays at reasoning model during revision, not reset
     - Cancel → restore `preplanModel` and original permission mode
     - Dialog dismissed / no response → treat as "continue planning"
     - Repeated plan writes in same session → each new plan file re-triggers approval
     - Non-interactive / headless context → skip approval dialog, auto-approve with default mode
   - Add unit tests for state transitions: pending→approved, pending→revising→pending→approved, pending→cancelled, model save/restore
   - Test end-to-end: enter plan mode → write plan → verify dialog → approve → verify model + mode switch

## Acceptance Criteria
- Subagents receive fully-qualified `provider/id` model strings from parent (never raw aliases)
- `$budget_model` correctly resolves from settings.json in parent process before spawn
- Auto memory extraction uses budget model when configured (verified via audit log)
- Custom user/project agents and skills are discovered with correct override precedence
- `GSD_BUNDLED_EXTENSION_PATHS` is propagated to child processes
- Bedrock appears as a provider option in the onboarding wizard with SSO and API key flows
- `gpt-5.4-mini` appears in budget model options in onboarding
- `planModeReasoningModel` setting is added with validation and backward compatibility
- Plan mode shows approval dialog with Auto/Bypass mode options after plan is written
- Plan mode saves/restores pre-plan model on cancel
- All existing tests continue to pass
- New unit tests cover model resolution, agent discovery, and plan state machine

## Verification
Tool: Playwright
Scenarios:
- Scenario 1: Subagent model resolution — run `lsd` with a scout subagent using `$budget_model`, verify child process receives fully-qualified `provider/id` model string
- Scenario 2: Custom agent discovery — create a test `.md` agent in `.lsd/agents/`, run `/subagent` command, verify it appears in the list with correct precedence
- Scenario 3: Onboarding Bedrock — run onboarding flow, select Bedrock provider, verify credentials are saved with correct provider ID
- Scenario 4: Plan mode approval — enter plan mode, write a plan file, verify approval dialog shows Auto/Bypass options, approve and verify model + mode switch, cancel and verify model restore
