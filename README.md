# LSD

**Looks Sort of Done** — a standalone coding-agent CLI built on the Pi SDK. Use all your AI providers and all your loved features from Claude Code, Codex, and Gemini in one place.

![LSD Screenshot](./lsd.png)

```bash
npm install -g lsd-pi@latest
```

---

## What LSD is

LSD is a general-purpose coding agent CLI. It combines:

- **Interactive TUI** inspired by Gemini CLI — including an embedded interactive terminal inside the LSD CLI that both you and the agent can use, so the agent is not blocked by commands or tools that require terminal interaction
- **Memory system and permission modes** inspired by Claude Code
- **Sandbox isolation** inspired by Codex
- **Auto mode** — a classifier-based autonomous execution mode
- **Remote questions** — relay agent prompts to Telegram, Discord, or Slack so you can respond from your phone
- **Background subagents, skills, worktrees, sessions, usage tracking, and more**

- **Package:** `lsd-pi`
- **Binary:** `lsd`
- **Alt binary:** `lsd-cli`
- **Project config dir:** `.lsd/`
- **User config dir:** `~/.lsd/`

### Fork lineage

LSD is a fork of **GSD 2**. The GSD-specific project workflow layer was stripped out. LSD is centered on being a general-purpose coding agent CLI — the agent shell, tools, TUI, browser tools, sessions, worktrees, and integrations remain core.

---

## Install

### Requirements

- Node.js **>= 22** (Node 24 LTS recommended)
- Git
- macOS, Linux, or Windows

### Global install

```bash
npm install -g lsd-pi
```

If `lsd` is not found after install, check your npm global bin path:

```bash
npm prefix -g
```

Then ensure `$(npm prefix -g)/bin` is on your `PATH`.

### Local development build

```bash
npm install
npm run build
npm link
```

---

## Quick start

```bash
lsd                          # start interactive session
lsd -c                       # resume last session
lsd --print "summarize repo" # one-shot mode
lsd -w                       # start in an isolated git worktree
lsd config                   # re-run setup wizard
```

---

## First launch

On first run, LSD opens an interactive setup wizard for:

- LLM provider login or API key (Anthropic, OpenAI, Google, GitHub Copilot, and others)
- Web search provider (Brave, Tavily, built-in)
- Remote questions channel (Telegram, Discord, Slack)
- Tool API keys (Context7, Jina, Groq for voice)

Re-run setup any time:

```bash
lsd config
```

---

## Permission modes

LSD supports different permission modes controlling how aggressively it acts in your environment:

| Mode | Behaviour |
|------|-----------|
| **interactive** (default) | Asks for approval before write/edit/shell operations |
| **auto** | Uses a classifier model to approve low-risk tool calls automatically; still asks for high-risk ones |
| **bypass** | Runs without asking (used internally by headless/subagent workers) |

Switch modes with `/permission` inside a session or pass flags to headless commands.

---

## Sandbox

LSD supports filesystem sandboxing:

```bash
lsd --sandbox workspace-write   # restrict writes to the current directory tree
lsd --sandbox none               # no sandbox (default)
lsd --no-sandbox                 # explicit no-sandbox
```

`workspace-write` prevents the agent from writing outside the project directory.

---

## Context files (lsd.md / CLAUDE.md / AGENTS.md)

LSD automatically loads project instructions from these files (in order of preference):

- `lsd.md` — LSD-native project instructions
- `CLAUDE.md` — Claude Code-compatible instructions
- `AGENTS.md` — Codex-compatible instructions

Place one of these files at the project root (or in `.lsd/`) to give the agent persistent per-project context, coding conventions, and rules.

The `--bare` flag suppresses all of these (useful for CI):

```bash
lsd headless --bare auto
```

---

## Interactive TUI
LSD comes with an embedded interactive terminal inspired by the gemini cli
- user interaction with that terminal directly from the TUI
- agent interaction with terminal programs and commands that require prompts, input, or other interactive flows without getting blocked

![Interactive TUI Terminal](./docs/images/interactive-tui-terminal.png)

### TUI slash commands

Use `/help` inside LSD to see the live command list for your current session, including built-ins, extension commands, prompt templates, and skill commands.

| Command | Description |
|---------|-------------|
| `/help [command]` | Show available commands or details for one command |
| `/model` | Switch model |
| `/login` | Add or switch provider credentials |
| `/settings` | Open settings panel |
| `/hotkeys` | Show keyboard shortcut reference |
| `/cache-timer` | Toggle the prompt-cache countdown in the footer |
| `/thinking` | Toggle extended thinking |
| `/voice` | Toggle voice input mode |
| `/clear` | Clear the current conversation |
| `/exit` | Exit LSD |

### Memory commands

| Command | Description |
|---------|-------------|
| `/memories` | Browse saved memories for this project |
| `/remember <text>` | Save a memory immediately |
| `/forget <topic>` | Remove a memory |
| `/dream` | Run a memory consolidation pass manually |

### Remote questions commands

| Command | Description |
|---------|-------------|
| `/lsd remote` | Show remote questions menu |
| `/lsd remote telegram` | Connect Telegram |
| `/lsd remote discord` | Connect Discord |
| `/lsd remote slack` | Connect Slack |
| `/lsd remote status` | Show current connection status |
| `/lsd remote disconnect` | Disconnect and remove saved token |

### Background process commands

| Command | Description |
|---------|-------------|
| `/bg <cmd>` | Start a background shell process |
| `/jobs` | List running async jobs |

### Codex account commands

| Command | Description |
|---------|-------------|
| `/codex add` | Add a ChatGPT/Codex OAuth account |
| `/codex list` | List configured accounts |
| `/codex status` | Show rotation state and token expiry |
| `/codex remove <n>` | Remove an account |
| `/codex enable <n>` | Re-enable a disabled account |
| `/codex disable <n>` | Temporarily disable an account |
| `/codex import` | Import from `~/.codex/auth.json` |
| `/codex import-cockpit` | Import from Cockpit Tools |
| `/codex sync` | Force refresh all tokens |

### Other commands

| Command | Description |
|---------|-------------|
| `/usage [today\|7d\|YYYY-MM-DD]` | Show token and cost usage |
| `/subagents` | List background subagent jobs |
| `/subagent` | Manage a specific subagent |
| `/configs` | Discover config files from other AI tools (Claude Code, Cursor, Copilot, etc.) |
| `/plan` | Create and run a multi-step plan |
| `/audit` | Run a codebase audit |
| `/search-provider` | Switch web search provider |

### Compatibility note

LSD is LSD-first. Some legacy `/gsd` aliases may still exist for compatibility, but the recommended commands and docs use `/lsd` and the standard slash commands shown above.

### TUI settings

The settings panel (`/settings`) includes toggles for:

- **Codex rotate** — enable multi-account OAuth rotation
- **Cache timer** — show a prompt-cache countdown in the footer
- **Pin last prompt** — keep your most recent non-command prompt visible above the editor
- **RTK shell compression** — compress repetitive shell output to save tokens
- **Main accent** — change the accent color across the UI and thinking-level indicators

---

## Persistent memory

LSD includes a built-in **persistent memory** extension.

- Stores durable facts under `~/.lsd/projects/<project>/memory/`
- Injects `MEMORY.md` into future sessions for the same project
- Runs an **auto-extract** pass on session shutdown (detached worker, uses `budgetSubagentModel` if configured)

Debug files written to the project memory directory:

- `.last-auto-extract.txt` — latest status (`saved_memory`, `nothing_worth_saving`, etc.)
- `.last-auto-extract.log` — extractor stdout/stderr

---

## Codex multi-account rotation

LSD bundles a Codex OAuth rotation extension for managing multiple ChatGPT/Codex accounts.

- Round-robin credential selection across accounts
- Background token refresh every 10 minutes
- Automatic quota/rate-limit detection and per-account backoff
- Import from `~/.codex/auth.json` or Cockpit Tools

See `/codex` commands above. Stored in `~/.lsd/agent/codex-accounts.json`.

---

## Voice input

LSD supports voice input via microphone:

- **macOS** — uses a compiled Swift speech recognizer (built automatically on first use via `swiftc`)
- **Linux** — uses a Python speech recognizer (requires `GROQ_API_KEY` and `python3` with `sounddevice`)

Toggle with `/voice` or the keyboard shortcut `Ctrl+Alt+V`.

---

## Usage tracking

Track token consumption and cost across sessions:

```bash
/usage              # today, grouped by model
/usage 7d           # last 7 days
/usage 2024-03-01   # specific date
/usage today --by project-model   # by project + model
/usage --all-projects             # across all projects
/usage --json                     # machine-readable output
```

---

## Telegram integration

LSD can relay permission prompts and questions to a Telegram chat while running autonomously. Reply from your phone and LSD continues.

### Step 1 — create a Telegram bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` and follow the prompts
3. Copy the **bot token** (looks like `123456789:ABCdefGHI...`)

### Step 2 — get your chat ID

**Easiest:** forward any message to **@userinfobot** — it replies with your chat ID.

**Alternative:** open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` after sending your bot a message — look for `"chat":{"id":...}` in the response.

Group chat IDs are negative numbers starting with `-100` (e.g. `-1001234567890`).

### Step 3 — connect

```bash
/lsd remote telegram
```

LSD prompts for your bot token and chat ID, validates both, and sends a test message.

You can also connect during initial setup with `lsd config`.

### Step 4 — verify

```bash
/lsd remote status
```

### Disconnect

```bash
/lsd remote disconnect
```

### PREFERENCES.md reference

```yaml
remote_questions:
  channel: telegram
  channel_id: "-1001234567890"
  timeout_minutes: 5        # 1–30, how long LSD waits for a reply
  poll_interval_seconds: 5  # 2–30, how often LSD polls
```

Stored in `~/.lsd/PREFERENCES.md`. Project-level overrides go in `.lsd/PREFERENCES.md`.

---

## Discord & Slack integration

Same flow as Telegram — run `/lsd remote discord` or `/lsd remote slack`. Both support:

- bot token validation
- channel auto-discovery (Discord lists your servers and channels; Slack lists channels)
- manual channel ID entry as fallback
- test message on connect

---

## MCP integrations

LSD discovers and connects to MCP servers configured in:

- `.mcp.json`
- `.lsd/mcp.json`

Use `/configs` inside a session to scan for MCP servers from other AI tools (Claude Code, Cursor, Copilot, etc.) and import them.

---

## Sessions

LSD stores per-project sessions and can resume prior work.

```bash
lsd sessions     # browse and pick a session to resume
lsd -c           # resume the most recent session automatically
```

---

## Worktrees

LSD supports isolated git worktrees for parallel streams of work:

```bash
lsd -w                        # auto-named worktree
lsd -w my-feature             # named worktree
lsd worktree list             # list with status
lsd worktree merge my-feature # squash-merge into main
lsd worktree clean            # remove merged/empty worktrees
lsd worktree remove NAME      # remove specific worktree
```

Lifecycle:
1. `lsd -w` — creates worktree, starts session inside it
2. Work normally — all changes stay on the worktree branch
3. Exit — dirty work is auto-committed
4. `lsd -w` — resume where you left off
5. `lsd worktree merge` — squash-merge into main when done

---

## Headless mode

Run LSD without the TUI for CI, scripts, or automation:

```bash
lsd headless                                    # run auto mode
lsd headless next                               # run one unit
lsd headless status                             # show queue status
lsd headless --json auto                        # JSONL event stream
lsd headless --output-format json auto          # structured JSON result
lsd headless --timeout 60000 auto              # with 1-minute timeout
lsd headless --bare auto                        # skip lsd.md/CLAUDE.md/settings
lsd headless --resume abc123 auto              # resume a prior session
lsd headless --supervised auto                 # orchestrator mode
lsd headless --answers answers.json auto       # pre-supply answers/secrets
lsd headless new-milestone --context spec.md   # create milestone from file
lsd headless new-milestone --context spec.md --auto  # create + execute
```

Exit codes: `0` success, `1` error/timeout, `10` blocked, `11` cancelled.

---

## Browser automation

LSD includes full browser automation via Playwright:

- local app verification and screenshots
- form filling and interaction
- DOM inspection and accessibility tree
- assertions and debug bundles
- network request inspection
- device emulation

---

## LSP code intelligence

LSD includes a first-class `lsp` tool for semantic code navigation in typed codebases.

Use it for:

- go-to-definition
- find references and implementations
- hover/type info
- workspace and file symbols
- incoming/outgoing calls
- diagnostics and quick fixes
- formatting and safe rename operations

### Why LSP is good

Unlike raw text search, LSP understands symbols, types, scopes, and project structure. That means the agent can:

- jump to the right definition instead of matching the wrong string
- find real references across the codebase
- inspect function signatures and docs without reading huge files
- catch type errors immediately after edits
- apply safer refactors like rename and format

In practice this makes the agent faster, more accurate, and less likely to break typed projects during navigation or refactors.

### Typical LSP usage

```text
lsp definition      # jump to a symbol definition
lsp references      # find where a symbol is used
lsp hover           # inspect type/docs at a position
lsp diagnostics     # check errors in a file or workspace
lsp rename          # perform a semantic rename
lsp format          # format a file with the language server
lsp status          # show installed/active language servers
```

### In LSD sessions

LSD prefers `lsp` over grep/find for typed codebases when a language server is available.

If a server is missing, run:

```bash
/setup
```

or inspect status with:

```text
lsp status
```

---

## RTK shell compression

LSD supports **RTK** for shell-command compression.

RTK rewrites certain shell commands into a more compact representation before they run, which helps reduce repetitive terminal output in agent context.

### Why RTK is good

RTK is useful when the agent or a background shell runs lots of repetitive commands like:

- `git status`
- `git diff`
- test runs
- package-manager commands
- other high-noise shell commands

Benefits:

- saves context tokens
- reduces noisy terminal output
- keeps long sessions cleaner
- lets the agent spend more context on code and reasoning instead of duplicated shell text

When active, LSD can also surface session savings like how many tokens RTK saved.

### Enable RTK

Turn it on in `/settings` by enabling **RTK**.

You can also enable it in preferences:

```yaml
experimental:
  rtk: true
```

RTK requires a restart after toggling.

### Where RTK helps most

RTK is most valuable in long-running sessions, background shell workflows, and repos where the agent repeatedly checks git state, runs tests, or invokes build tooling.

---

## Web research

- Google-backed search (`google_search`)
- Brave / Tavily web search
- Page extraction via Jina
- Context7 library docs lookup (`/context7`)

---

## Extensions, themes, and skills

LSD supports a package-like extension system:

```bash
lsd install <source>   # install extension/theme/skill
lsd remove <source>    # remove
lsd list               # list installed packages
```

Sources: `npm:@scope/pkg`, `git:github.com/user/repo`, `https://...`, local paths.

Bundled extensions include: memory, remote-questions, browser-tools, subagent, codex-rotate, usage, voice, bg-shell, async-jobs, context7, universal-config, search-the-web, cache-timer, mac-tools, aws-auth.

---

## Configuration reference

### PREFERENCES.md

Stored in `~/.lsd/PREFERENCES.md` (global) or `.lsd/PREFERENCES.md` (project). YAML frontmatter:

```yaml
---
search_provider: tavily         # tavily | brave | ollama | native | auto
remote_questions:
  channel: telegram             # telegram | discord | slack
  channel_id: "-1001234567890"
  timeout_minutes: 5
  poll_interval_seconds: 5
experimental:
  rtk: true                     # RTK shell-command compression
  codex_rotate: true            # Codex multi-account rotation
subagent:
  budget_model: claude-haiku-4  # model used for memory/subagent background work
cmux:
  enabled: false
  notifications: false
---
```

### settings.json

Located at `~/.lsd/agent/settings.json`. Editable via `/settings` in the TUI. Includes model preferences, UI toggles (cache timer, pin last prompt, accent color), and `budgetSubagentModel`.

### auth.json

Located at `~/.lsd/agent/auth.json`. Stores provider API keys and OAuth tokens. Modified by `/login` and `/codex add`.

### Configuration paths

```text
~/.lsd/
  agent/
    auth.json         API keys + OAuth tokens
    settings.json     UI + model preferences
    extensions/       Installed extensions
    agents/           Custom agent definitions
  sessions/           Saved sessions (all projects)
  projects/
    <project>/
      memory/         Persistent memory files
  PREFERENCES.md      Global preferences
```

```text
.lsd/               Per-project state
  PREFERENCES.md    Project-level preference overrides
  mcp.json          Project MCP servers
```

---

## Full CLI reference

```bash
lsd                          # interactive session
lsd -c                       # resume last session
lsd --continue               # resume last session (long form)
lsd --print "..."            # one-shot mode
lsd -w [name]                # worktree session
lsd --model <id>             # override model
lsd --sandbox <mode>         # sandbox mode: none | workspace-write | auto
lsd --no-sandbox             # disable sandbox
lsd --no-session             # disable session persistence
lsd --extension <path>       # load extra extension
lsd --tools a,b,c            # restrict available tools
lsd --list-models [search]   # list available models
lsd --version                # print version
lsd --help                   # print help
lsd --mode <text|json|rpc|mcp>  # output mode

lsd config                   # re-run setup wizard
lsd update                   # update to latest version
lsd sessions                 # browse saved sessions
lsd install <source>         # install package/extension
lsd remove <source>          # remove installed package
lsd list                     # list installed packages
lsd worktree list            # list worktrees
lsd worktree merge [name]    # merge worktree into main
lsd worktree clean           # remove merged/empty worktrees
lsd worktree remove <name>   # remove specific worktree
lsd headless [cmd] [flags]   # headless mode (see above)
```

---

## Naming note

LSD evolved from GSD 2, but the product, docs, and recommended workflows are LSD-first. Prefer:

- `lsd` — binary
- `.lsd/` — project state
- `~/.lsd/` — global state
- `/lsd remote` — remote questions
- `/help` — live in-session command reference

Any remaining `/gsd` surfaces should be treated as compatibility aliases, not the primary workflow.

---

## Documentation

See [`docs/`](./docs/) for deeper details:

- [Getting Started](./docs/getting-started.md)
- [Commands Reference](./docs/commands.md)
- [Configuration](./docs/configuration.md)
- [Auto Mode](./docs/auto-mode.md)
- [Architecture](./docs/architecture.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Skills](./docs/skills.md)
- [Custom Models](./docs/custom-models.md)

---

## Development

```bash
npm run build    # build
npm link         # link local CLI globally
npm run gsd      # run dev CLI
npm test         # run tests
```

---

## License

MIT
