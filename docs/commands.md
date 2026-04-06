# Commands Reference

> Preferred command surface: use `/lsd ...` in docs and examples. Legacy `/gsd ...` aliases may still work for compatibility, but they are not the primary workflow.

## Session Commands

| Command | Description |
|---------|-------------|
| `/lsd` | Step mode — execute one unit at a time, pause between each |
| `/lsd next` | Explicit step mode (same as `/lsd`) |
| `/lsd auto` | Autonomous mode — research, plan, execute, commit, repeat |
| `/lsd quick` | Execute a quick task with LSD guarantees (atomic commits, state tracking) without full planning overhead |
| `/lsd stop` | Stop auto mode gracefully |
| `/lsd pause` | Pause auto-mode (preserves state, `/lsd auto` to resume) |
| `/lsd steer` | Hard-steer plan documents during execution |
| `/lsd discuss` | Discuss architecture and decisions (works alongside auto mode) |
| `/lsd status` | Progress dashboard |
| `/lsd widget` | Cycle dashboard widget: full / small / min / off |
| `/lsd queue` | Queue and reorder future milestones (safe during auto mode) |
| `/lsd capture` | Fire-and-forget thought capture (works during auto mode) |
| `/lsd triage` | Manually trigger triage of pending captures |
| `/lsd dispatch` | Dispatch a specific phase directly (research, plan, execute, complete, reassess, uat, replan) |
| `/lsd history` | View execution history (supports `--cost`, `--phase`, `--model` filters) |
| `/lsd forensics` | Full-access LSD debugger — structured anomaly detection, unit traces, and LLM-guided root-cause analysis for auto-mode failures |
| `/lsd cleanup` | Clean up LSD state files and stale worktrees |
| `/lsd visualize` | Open workflow visualizer (progress, deps, metrics, timeline) |
| `/lsd export --html` | Generate self-contained HTML report for current or completed milestone |
| `/lsd export --html --all` | Generate retrospective reports for all milestones at once |
| `/lsd update` | Update LSD to the latest version in-session |
| `/lsd knowledge` | Add persistent project knowledge (rule, pattern, or lesson) |
| `/fast` | Toggle service tier for supported models (prioritized API routing) |
| `/lsd rate` | Rate last unit's model tier (over/ok/under) — improves adaptive routing |
| `/lsd changelog` | Show categorized release notes |
| `/lsd logs` | Browse activity logs, debug logs, and metrics |
| `/lsd remote` | Control remote auto-mode |
| `/lsd help` | Categorized command reference with descriptions for all LSD subcommands |

## Configuration & Diagnostics

| Command | Description |
|---------|-------------|
| `/lsd prefs` | Model selection, timeouts, budget ceiling |
| `/lsd mode` | Switch workflow mode (solo/team) with coordinated defaults |
| `/lsd config` | Re-run the provider setup wizard (LLM provider + tool keys) |
| `/lsd keys` | API key manager — list, add, remove, test, rotate, doctor |
| `/lsd doctor` | Runtime health checks with auto-fix |
| `/lsd inspect` | Show SQLite DB diagnostics |
| `/lsd init` | Project init wizard — detect, configure, bootstrap `.lsd/` |
| `/lsd setup` | Global setup status and configuration |
| `/lsd skill-health` | Skill lifecycle dashboard — usage stats, success rates, token trends, staleness warnings |
| `/lsd skill-health <name>` | Detailed view for a single skill |
| `/lsd skill-health --declining` | Show only skills flagged for declining performance |
| `/lsd skill-health --stale N` | Show skills unused for N+ days |
| `/lsd hooks` | Show configured post-unit and pre-dispatch hooks |
| `/lsd run-hook` | Manually trigger a specific hook |
| `/lsd migrate` | Migrate a `.planning` (v1) or `.gsd/` directory to `.lsd/` format |

## Milestone Management

| Command | Description |
|---------|-------------|
| `/lsd new-milestone` | Create a new milestone |
| `/lsd skip` | Prevent a unit from auto-mode dispatch |
| `/lsd undo` | Revert last completed unit |
| `/lsd undo-task` | Reset a specific task's completion state (DB + markdown) |
| `/lsd reset-slice` | Reset a slice and all its tasks (DB + markdown) |
| `/lsd park` | Park a milestone — skip without deleting |
| `/lsd unpark` | Reactivate a parked milestone |
| Discard milestone | Available via `/lsd` wizard → "Milestone actions" → "Discard" |

## Parallel Orchestration

| Command | Description |
|---------|-------------|
| `/lsd parallel start` | Analyze eligibility, confirm, and start workers |
| `/lsd parallel status` | Show all workers with state, progress, and cost |
| `/lsd parallel stop [MID]` | Stop all workers or a specific milestone's worker |
| `/lsd parallel pause [MID]` | Pause all workers or a specific one |
| `/lsd parallel resume [MID]` | Resume paused workers |
| `/lsd parallel merge [MID]` | Merge completed milestones back to main |

See [Parallel Orchestration](./parallel-orchestration.md) for full documentation.

## Workflow Templates

| Command | Description |
|---------|-------------|
| `/lsd start` | Start a workflow template (bugfix, spike, feature, hotfix, refactor, security-audit, dep-upgrade, full-project) |
| `/lsd start resume` | Resume an in-progress workflow |
| `/lsd templates` | List available workflow templates |
| `/lsd templates info <name>` | Show detailed template info |

## Custom Workflows

| Command | Description |
|---------|-------------|
| `/lsd workflow new` | Create a new workflow definition (via skill) |
| `/lsd workflow run <name>` | Create a run and start auto-mode |
| `/lsd workflow list` | List workflow runs |
| `/lsd workflow validate <name>` | Validate a workflow definition YAML |
| `/lsd workflow pause` | Pause custom workflow auto-mode |
| `/lsd workflow resume` | Resume paused custom workflow auto-mode |

## Extensions

| Command | Description |
|---------|-------------|
| `/lsd extensions list` | List all extensions and their status |
| `/lsd extensions enable <id>` | Enable a disabled extension |
| `/lsd extensions disable <id>` | Disable an extension |
| `/lsd extensions info <id>` | Show extension details |

## Git & Worktrees

| Command | Description |
|---------|-------------|
| `/worktree` (`/wt`) | Git worktree lifecycle — create, switch, merge, remove |

```bash
lsd -w               # create/resume worktree session
lsd worktree list
lsd worktree merge NAME
lsd worktree clean
lsd worktree remove NAME
```

## Session Management

| Command | Description |
|---------|-------------|
| `/clear` | Start a new session (alias for `/new`) |
| `/exit` | Graceful shutdown — saves session state before exiting |
| `/kill` | Kill LSD process immediately |
| `/model` | Switch the active model |
| `/login` | Log in to an LLM provider |
| `/settings` | Open interactive settings, including theme selection, main accent presets, Codex rotate, cache timer, pin-last-prompt, and RTK toggles |
| `/hotkeys` | Show the full keyboard shortcut reference |
| `/cache-timer` | Toggle the footer cache elapsed-time indicator |
| `/thinking` | Toggle thinking level during sessions |
| `/voice` | Toggle real-time speech-to-text (macOS, Linux) |
| `/usage` | Show built-in token/cost usage reports from LSD session history |
| `/memories` | View persistent memory store for current project |
| `/remember <text>` | Save a fact to persistent memory |
| `/forget <topic>` | Remove a memory by topic |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Alt+G` | Toggle dashboard overlay |
| `Ctrl+Alt+V` | Toggle voice transcription |
| `Ctrl+Alt+B` | Show background shell processes |
| `Ctrl+V` / `Alt+V` | Paste image from clipboard (screenshot → vision input) |
| `Escape` | Pause auto mode (preserves conversation) |

> **Note:** In terminals without Kitty keyboard protocol support (macOS Terminal.app, JetBrains IDEs), slash-command fallbacks are shown instead of `Ctrl+Alt` shortcuts.
>
> **Tip:** If `Ctrl+V` is intercepted by your terminal (e.g. Warp), use `Alt+V` instead for clipboard image paste.

## CLI Flags

| Flag | Description |
|------|-------------|
| `lsd` | Start a new interactive session |
| `lsd --continue` (`-c`) | Resume the most recent session for the current directory |
| `lsd --model <id>` | Override the default model for this session |
| `lsd --print "msg"` (`-p`) | Single-shot prompt mode (no TUI) |
| `lsd --mode <text\|json\|rpc\|mcp>` | Output mode for non-interactive use |
| `lsd --list-models [search]` | List available models and exit |
| `lsd --worktree` (`-w`) [name] | Start session in a git worktree (auto-generates name if omitted) |
| `lsd --no-session` | Disable session persistence |
| `lsd --extension <path>` | Load an additional extension (can be repeated) |
| `lsd --append-system-prompt <text>` | Append text to the system prompt |
| `lsd --tools <list>` | Comma-separated list of tools to enable |
| `lsd --version` (`-v`) | Print version and exit |
| `lsd --help` (`-h`) | Print help and exit |
| `lsd sessions` | Interactive session picker — list all saved sessions for the current directory and choose one to resume |
| `lsd --debug` | Enable structured JSONL diagnostic logging |
| `lsd config` | Set up global API keys (saved to `~/.lsd/agent/auth.json`, applies to all projects) |
| `lsd update` | Update LSD to the latest version |
| `lsd headless new-milestone` | Create a new milestone from a context file (headless — no TUI required) |

## Headless Mode

`lsd headless` runs commands without a TUI — designed for CI, cron jobs, and scripted automation. It spawns a child process in RPC mode, auto-responds to interactive prompts, detects completion, and exits with meaningful exit codes.

```bash
# Run auto mode (default)
lsd headless

# Run a single unit
lsd headless next

# With timeout for CI
lsd headless --timeout 600000 auto

# Force a specific phase
lsd headless dispatch plan

# Create a new milestone from a context file and start auto mode
lsd headless new-milestone --context brief.md --auto

# Create a milestone from inline text
lsd headless new-milestone --context-text "Build a REST API with auth"

# Pipe context from stdin
echo "Build a CLI tool" | lsd headless new-milestone --context -
```

| Flag | Description |
|------|-------------|
| `--timeout N` | Overall timeout in milliseconds (default: 300000 / 5 min) |
| `--max-restarts N` | Auto-restart on crash with exponential backoff (default: 3). Set 0 to disable |
| `--json` | Stream all events as JSONL to stdout |
| `--model ID` | Override the model for the headless session |
| `--context <file>` | Context file for `new-milestone` (use `-` for stdin) |
| `--context-text <text>` | Inline context text for `new-milestone` |
| `--auto` | Chain into auto-mode after milestone creation |

**Exit codes:** `0` = complete, `1` = error or timeout, `2` = blocked.

Any `/lsd` subcommand works as a positional argument — `lsd headless status`, `lsd headless doctor`, `lsd headless dispatch execute`, etc.

## MCP Server Mode

`lsd --mode mcp` runs LSD as a [Model Context Protocol](https://modelcontextprotocol.io) server over stdin/stdout. This exposes all LSD tools to external AI clients — Claude Desktop, VS Code Copilot, and any MCP-compatible host.

```bash
lsd --mode mcp
```

## Export

`/lsd export` generates reports of milestone work.

```bash
# Generate HTML report for the active milestone
/lsd export --html

# Generate retrospective reports for ALL milestones at once
/lsd export --html --all
```

Reports are saved to `.lsd/reports/` with a browseable `index.html`.
