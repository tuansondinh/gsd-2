# LSD built-in usage command plan

Date: 2026-04-02
Status: proposed
Mode: plan-only

## User goal
Add a built-in LSD command to show token/cost usage, especially "how much I burned per model in the day", without relying on old GSD workflow metrics.

## Findings

### Existing LSD data we can use
- LSD stores sessions under `~/.lsd/sessions/` or `$LSD_HOME/sessions/`.
  - Source: `src/app-paths.ts`
- Project-specific session directories are derived from cwd.
  - Source: `src/project-sessions.ts`
- Assistant messages in session JSONL include:
  - `provider`
  - `model`
  - `usage.input`
  - `usage.output`
  - `usage.cacheRead`
  - `usage.cacheWrite`
  - `usage.cost.total`
  - `timestamp`
  - Source: `packages/pi-ai/src/types.ts`
- `/session` already reports current-session totals only.
  - Sources:
    - `packages/pi-coding-agent/src/modes/interactive/slash-command-handlers.ts`
    - `packages/pi-coding-agent/src/core/agent-session.ts`

### Important conclusion
LSD already persists everything needed for daily per-model usage reporting. What is missing is a built-in aggregation command over session JSONL files.

## Recommended product shape
Add a new built-in slash command:

- `/usage`

Recommended defaults:
- `/usage` => today, current project, grouped by model
- `/usage today` => same as default
- `/usage 7d` => trailing 7 days, grouped by model
- `/usage 2026-04-02` => specific day

Recommended flags/arguments for v1:
- `--all-projects` => scan all LSD sessions, not just current project
- `--by project` => group by project
- `--by project-model` => group by project + model
- `--json` => machine-readable output in chat/status block

## Why `/usage`
- matches the user’s mental model better than `/session`
- avoids reusing GSD terminology like metrics/history
- can stay focused on token/cost reporting rather than broader session metadata

## Recommended implementation strategy
Implement as an LSD extension command rather than touching deep core session logic.

### Likely new files
- `src/resources/extensions/usage/index.ts`
- maybe `src/resources/extensions/usage/collector.ts`
- maybe `src/resources/extensions/usage/format.ts`

### Integration pattern
Use `pi.registerCommand("usage", ...)`, similar to other extension commands.

## Core implementation steps

### 1. Session scan + parsing layer
Build a read-only collector that:
- resolves session root from `src/app-paths.ts`
- resolves current project session dir via `getProjectSessionsDir(process.cwd())`
- recursively scans `.jsonl` files
- parses entries line by line
- keeps only `entry.type === "message" && message.role === "assistant"`
- filters by message timestamp for requested day/range
- aggregates by selected key:
  - model
  - project
  - project+model

### 2. Time-range handling
Support:
- local-day boundaries for `today`
- explicit `YYYY-MM-DD`
- rolling range like `7d`

Recommended v1 behavior:
- interpret days in local time
- filter by assistant message timestamp, not file mtime

### 3. Output formatting
Render a compact table-like text block with columns:
- model / group
- assistant msgs
- input
- output
- cache read
- cache write
- total
- cost

Also show summary header:
- scope: current project vs all projects
- date/range
- session root / project path (briefly)
- number of session files scanned
- number of assistant messages matched

### 4. Command parser
Recommended accepted forms:
- `/usage`
- `/usage today`
- `/usage 7d`
- `/usage 2026-04-02`
- `/usage today --all-projects`
- `/usage today --by project-model`
- `/usage 7d --json`

### 5. Docs/help
Update command docs/help text to mention `/usage`.

## Recommended v1 scope
Recommended default behavior for least surprise:
- current project only by default
- all-projects only when explicitly requested

Reason:
- users are usually asking about the repo they’re in
- scanning all sessions may be slower and mix unrelated work
- still leaves a path for full personal rollups via `--all-projects`

## Nice-to-have v2
- CLI equivalent: `lsd usage today`
- footer/widget summary for today’s burn
- export to CSV/JSON file
- provider grouping in addition to model grouping
- top projects by spend for the week

## Acceptance criteria
1. `/usage` works in plain LSD with no GSD workflow dependency.
2. `/usage` returns today’s per-model token/cost totals from persisted session JSONL.
3. It uses assistant message timestamps, not file timestamps.
4. Default scope is current project.
5. `--all-projects` aggregates across all LSD session directories.
6. Output clearly shows input/output/cache/cost columns and totals.
7. No source writes or side effects occur while generating the report.

## Scope decision confirmed
User chose: **all projects by default**.

Adjusted default behavior:
- `/usage` => today + all projects + by model
- add an explicit current-project narrowing flag, e.g. `--project-current`

## Final recommendation
Implement `/usage` as a built-in extension command with:
- default = today + all projects + by model
- optional `--project-current`
- optional `--by project|project-model`
- optional `--json`
