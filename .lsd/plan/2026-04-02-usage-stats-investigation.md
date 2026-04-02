# Usage stats investigation

Date: 2026-04-02
Status: investigated
Mode: plan-only

## User question
Does LSD have stats to show how many tokens were used/burned per model in the day?

## Findings

### LSD core / interactive session
- LSD persists assistant message usage in session JSONL files.
- `/session` shows totals for the current session only: input, output, cache read/write, and cost.
- The TUI footer also shows running totals for the current session plus the active model.
- I did not find a built-in LSD command that aggregates usage **by model across the day**.

Relevant sources:
- `packages/pi-coding-agent/src/modes/interactive/slash-command-handlers.ts`
- `packages/pi-coding-agent/src/core/agent-session.ts`
- `docs/what-is-pi/07-sessions-memory-that-branches.md`
- `src/resources/extensions/bg-shell/bg-shell-lifecycle.ts`

### GSD compatibility / auto-mode layer
- GSD docs describe persisted metrics in `.gsd/metrics.json`.
- GSD dashboards/visualizer can aggregate cost/token data by model.
- Commands/docs mention `/gsd status`, `/gsd visualize`, and `/gsd history` filters.
- This appears tied to GSD workflow/auto-mode metrics, not a general LSD-wide daily usage report.

Relevant sources:
- `docs/cost-management.md`
- `docs/visualizer.md`
- `docs/commands.md`

## Conclusion
- **Current-session stats:** yes (`/session`, footer).
- **Daily per-model burn report in LSD core:** not found.
- **Closest existing thing:** GSD auto-mode metrics/visualizer, if that workflow layer is in use.

## Suggested user-facing answer
Tell the user:
1. LSD currently shows per-session totals via `/session` and the footer.
2. There does not appear to be a built-in "today by model" report in LSD itself.
3. If they are using GSD auto-mode features, `.gsd/metrics.json`, `/gsd status`, `/gsd visualize`, and `/gsd history --model` are the closest existing stats surfaces.
4. Offer to add or script a daily per-model report from session JSONL files if they want.
