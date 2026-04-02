# Skill-only extension authoring migration plan

## Goal
Migrate the overlapping extension-creation UX to a **skill-only** solution, keeping skills visible as skills and removing overlapping slash-command entrypoints.

As part of the same change, rename the legacy-branded skill from:
- `skill:create-gsd-extension`

to:
- `skill:create-lsd-extension`

## Decision
Use the **skill** as the single canonical entry for extension authoring help.

- Keep a visible skill-based invocation path.
- Rename the skill from `create-gsd-extension` to `create-lsd-extension`.
- Remove overlapping slash commands:
  - `create-extension`
  - `create-slash-command`
- Preserve the rest of the slash-commands extension (`audit`, `clear`, `plan`, `execute`, `cancel-plan`).

## Findings from investigation

### Current overlapping surfaces
1. **Skill**
   - `src/resources/skills/create-gsd-extension/SKILL.md`
   - currently surfaced as `skill:create-gsd-extension`
   - target name after migration: `skill:create-lsd-extension`

2. **Slash commands**
   - `src/resources/extensions/slash-commands/create-extension.ts`
   - `src/resources/extensions/slash-commands/create-slash-command.ts`
   - both registered from `src/resources/extensions/slash-commands/index.ts`
   - both declared in `src/resources/extensions/slash-commands/extension-manifest.json`

### Why they all appear
- Interactive mode builds autocomplete from built-in commands, prompt templates, extension commands, and skill commands.
- Skills are intentionally surfaced in the command system.
- Non-user-invocable skills appear with the `skill:` prefix.
- `create-gsd-extension` is currently a skill, while `create-extension` and `create-slash-command` are independent registered commands.

### Relevant runtime behavior
- `packages/pi-coding-agent/src/modes/interactive/interactive-mode.ts`
  - merges extension commands and skill commands into one autocomplete source
  - already avoids short-name duplication for **user-invocable** skills when a reserved command name exists
- `packages/pi-coding-agent/src/modes/rpc/rpc-mode.ts`
  - exposes skills separately as `source: "skill"`
- `packages/pi-coding-agent/src/core/agent-session.ts`
  - expands `/skill:name` commands
  - also supports bare `/name` aliases only for skills with `user-invocable: true`
- `packages/pi-coding-agent/src/core/settings-manager.ts`
  - `enableSkillCommands` already exists and defaults to true

## Recommended implementation scope

### 1. Remove overlapping slash-command registrations
Update bundled slash-command extension so it no longer registers:
- `create-extension`
- `create-slash-command`

Likely touch points:
- `src/resources/extensions/slash-commands/index.ts`
- `src/resources/extensions/slash-commands/extension-manifest.json`

### 2. Decide whether to fully delete or soft-deprecate command files
Recommended path: **soft removal in UX, then optional code deletion in same change if no references remain**.

Options:
- **A. Immediate removal**
  - delete both command modules and their imports
  - cleanest end-state
- **B. Transitional deprecation**
  - keep files temporarily but stop registering them
  - optionally leave comments/changelog note

Preferred: **B during implementation**, then delete if tests/docs are straightforward.

### 3. Keep skill visible as a skill
Do **not** convert the skill into a normal slash command.

Specifically:
- rename it to `skill:create-lsd-extension`
- update the skill frontmatter `name`
- rename the bundled skill directory from `src/resources/skills/create-gsd-extension/` to `src/resources/skills/create-lsd-extension/`
- update internal references/docs/changelog strings that mention `create-gsd-extension`
- do not add `user-invocable: true` unless product explicitly wants a bare `/create-lsd-extension` alias

### 4. Rename scope and compatibility stance
This change should update the legacy GSD-branded skill name in one pass.

Recommended canonical name:
- `create-lsd-extension`

Compatibility options:
- **A. Hard rename**
  - only `skill:create-lsd-extension` remains
  - cleanest outcome, no duplicate entries
- **B. Temporary alias**
  - keep old `create-gsd-extension` alongside new name briefly
  - not recommended because it reintroduces duplicate skill UX

Preferred: **A. Hard rename**.

## Documentation and discoverability updates
Update docs and generated maps that currently imply both command-based and skill-based entrypoints.

Likely files:
- `docs/skills.md`
- `docs/FILE-SYSTEM-MAP.md`
- `CHANGELOG.md` references for the old skill name
- any README/docs references found by grep for:
  - `create-extension`
  - `create-slash-command`
  - `create-gsd-extension`
  - `create-lsd-extension`

Docs should make clear:
- extension authoring guidance is available as a **skill**
- the canonical skill name is `skill:create-lsd-extension`
- the old slash-command generators are no longer the primary path

## Validation plan

### Runtime / UX checks
1. Command palette / autocomplete no longer lists:
   - `create-extension`
   - `create-slash-command`
2. Skills list shows:
   - `skill:create-lsd-extension`
3. Old skill name no longer appears in discovery:
   - `skill:create-gsd-extension`
4. Skill invocation still expands correctly under the new name.
5. Other slash commands in the same extension still work.

### Code-level checks
- search confirms removed command names are no longer registered in source
- manifest matches actual registrations
- no stale imports remain

### Tests to run/update
Potential targets:
- any command registration tests for slash commands extension
- skill command tests should continue to pass unchanged
- add/update a focused test if coverage for bundled command inventory exists

## Risks
1. **Docs drift**
   - docs may still advertise removed slash commands or the old skill name
2. **Manifest/runtime mismatch**
   - if manifest still lists removed commands, downstream tooling may show stale entries
3. **User muscle memory**
   - users familiar with `/create-extension` may lose the old path without an explanation
4. **Rename fallout**
   - references to `create-gsd-extension` may remain in docs, tests, or code comments after the rename

## Mitigations
- update docs in same change
- update manifest in same change
- update the skill directory/frontmatter/name references in same change
- add changelog note or release note for the removal and rename
- mention replacement path in docs: use `skill:create-lsd-extension`

## Proposed execution sequence
1. Remove command registration/imports for `create-extension` and `create-slash-command`
2. Update slash-commands manifest
3. Rename bundled skill directory and frontmatter from `create-gsd-extension` to `create-lsd-extension`
4. Update source/docs/changelog/file-map references to the new skill name
5. Remove or retain-unused command source files based on reference scan
6. Run targeted tests/search validation
7. Verify interactive/RPC command inventories show only the new skill path for extension authoring

## Acceptance criteria
- There is only **one visible product solution** for extension authoring help: the skill.
- The canonical skill is `skill:create-lsd-extension`.
- `skill:create-gsd-extension` no longer appears in discovery.
- `create-extension` and `create-slash-command` no longer appear in command discovery.
- No source/manifest/docs inconsistencies remain for the removed commands or the renamed skill.

## Out of scope for this change
- redesigning the general skill command UX
- changing `enableSkillCommands` defaults
- converting the skill into a bare slash alias
