<div align="center">

# LSD

**Lucent Software Developer** — a standalone coding-agent CLI built on the Pi SDK.

[![npm version](https://img.shields.io/npm/v/lsd-pi?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/lsd-pi)
[![npm downloads](https://img.shields.io/npm/dm/lsd-pi?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/lsd-pi)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)

LSD is a local-first agent shell for software work: coding, shell execution, browser automation, web research, MCP integrations, worktrees, sessions, and autonomous task execution.

It is a **fork of GSD 2**, but positioned differently:

- the heavy **GSD workflow/orchestration layer** was stripped away
- LSD focuses on the **agent shell, tools, sessions, worktrees, and execution surface**
- LSD keeps useful compatibility where practical, but it is **not presented as GSD**
- LSD adds and emphasizes **permission modes**, where **auto mode** is treated as a special permission/execution style rather than the center of the whole product

```bash
npm install -g lsd-pi@latest
```

</div>

---

## What LSD is

LSD is the product and CLI.

- **Package:** `lsd-pi`
- **Binary:** `lsd`
- **Alt binary:** `lsd-cli`
- **Project config dir:** `.lsd/`
- **User config dir:** `~/.lsd/`

It is built on the Pi SDK and ships with a rich tool/runtime layer for:

- code editing and file operations
- shell execution (`bash`, `async_bash`, `bg_shell`)
- browser automation and verification
- web search and page extraction
- MCP integrations
- sessions and resumability
- worktree-based parallel work
- interactive and headless execution
- configurable permission modes

### Fork lineage

LSD is a fork of **GSD 2**.

What changed:

- the old GSD-specific project workflow layer is no longer the identity of the tool
- LSD is centered on being a **general-purpose coding agent CLI**
- the agent shell, tools, TUI, browser tools, sessions, worktrees, and integrations remain the core
- auto execution still exists, but it is treated as **one operating mode among several**

### Permission modes

LSD supports different permission modes for how aggressively it can act in your environment.

A key point of the LSD model is:

- **auto** is a special permission mode / execution style
- it is not the whole product
- you can use LSD interactively, cautiously, or autonomously depending on the task

## Important note on naming

LSD has evolved from earlier GSD-branded work and is a fork of GSD 2. Some internal commands, docs, or compatibility surfaces may still use names like `/gsd`.

**For users, the tool is LSD.**

That means:

- install with `npm install -g lsd-pi`
- launch with `lsd`
- use `.lsd/` for project state
- use `~/.lsd/` for global LSD state

Inside the interactive session, some slash commands still use the legacy `/gsd ...` namespace for compatibility, but the LSD direction is broader than the old workflow-centric GSD model.

---

## Install

### Requirements

- Node.js **>= 22**
- Git
- macOS, Linux, or Windows

Node 24 LTS is recommended.

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

From this repo:

```bash
npm install
npm run build
npm link
```

That makes the local build available as `lsd` on your machine.

---

## Quick start

### Start an interactive session

```bash
lsd
```

### Resume the last session for the current directory

```bash
lsd --continue
# or
lsd -c
```

### One-shot prompt mode

```bash
lsd --print "summarize this repository"
```


```bash
```

### Start in a git worktree

```bash
lsd -w
lsd -w my-feature
```

---

## First launch

On first run, LSD opens a setup flow for:

- LLM provider login or API key setup
- optional web search provider setup
- optional tool/API credentials
- optional remote-question integrations

LSD supports multiple providers including Anthropic, OpenAI, Google, GitHub Copilot, and others depending on configuration and installed extensions.

Re-run setup any time with:

```bash
lsd config
```

---

## Persistent memory

LSD includes a bundled **persistent memory** extension.

What it does:

- stores durable user/project memories under `~/.lsd/projects/<project>/memory/`
- injects `MEMORY.md` into future turns for the same project
- supports explicit memory commands:
	- `/memories`
	- `/remember <text>`
	- `/forget <topic>`
- runs an **auto-extract** pass on session shutdown to save durable facts from the transcript

Auto-extract notes:

- it runs in a detached `lsd headless --bare ...` worker after you exit a session
- if `budgetSubagentModel` is configured in settings, auto-extract uses that model
- otherwise it falls back to the normal default model resolution
- it may decide that a transcript contains **nothing worth saving**

For debugging auto-extract, LSD writes two files in the project memory directory:

- `.last-auto-extract.txt` — latest status/result summary
- `.last-auto-extract.log` — extractor stdout/stderr

Typical results in `.last-auto-extract.txt` include:

- `status: finished`
- `result: saved_memory`
- `result: nothing_worth_saving`
- `completionReason: child_exit` or `completionReason: session_end_detected`

---

## Core ways to use LSD

## 1. Interactive TUI

The default `lsd` experience is an interactive terminal UI with:

- message history
- tool execution rendering
- slash commands
- model switching
- sessions
- background process management
- settings

Useful built-in commands include:

- `/model`
- `/login`
- `/settings`
- `/hotkeys`
- `/cache-timer`
- `/clear`
- `/exit`
- `/thinking`
- `/voice`

A few quality-of-life touches in the TUI:

- the footer can show a live cache timer for the current prompt-cache window
- `/hotkeys` gives you a full shortcut reference on demand
- `/settings` now includes toggles for Codex rotate, the cache timer, and RTK shell-command compression

Some workflow/automation commands still use the legacy namespace:

- `/gsd`
- `/gsd auto`
- `/gsd status`
- `/gsd config`
- `/gsd doctor`
- `/gsd update`

## 2. Headless mode

Run LSD without the TUI for CI, scripts, or automation:

```bash
lsd headless
lsd headless next
lsd headless status
```

Examples:

```bash
lsd headless --timeout 60000 auto
lsd headless --output-format json auto
lsd headless --json status
```

## 3. Web UI

Run LSD with a browser interface:

```bash
```

This is useful for local dashboards, session monitoring, and browser-based interaction.

## 4. Worktree workflow

LSD supports isolated git worktrees for parallel streams of work:

```bash
lsd -w my-feature
lsd worktree list
lsd worktree merge my-feature
lsd worktree clean
```

---

## Features

## Coding + shell tools

LSD includes file and shell tools such as:

- `read`, `write`, `edit`
- `bash`
- `async_bash`
- `bg_shell`
- LSP-backed navigation and diagnostics (hover, definition, references, rename, code actions, formatting)
- Language server auto-detection — run `/setup` to install missing servers for your project (TypeScript, Python, Go, Rust, and more)

## Browser automation

Browser tools support:

- local app verification
- screenshots
- assertions
- form filling
- DOM inspection
- interaction recording and debug bundles

## Web research

LSD supports:

- Google-backed search (`google_search`)
- Brave/Tavily-style web search flows
- page extraction
- combined search-and-read workflows
- Context7 library docs lookup

## MCP integrations

LSD can discover and connect to MCP servers configured in the project:

- `.mcp.json`
- `.lsd/mcp.json`

## Sessions

LSD stores per-project sessions and can resume prior work.

Browse sessions with:

```bash
lsd sessions
```

## Extensions, themes, and skills

LSD supports:

- extensions
- themes
- skills
- prompt templates
- package-like installs from supported sources

---

## Configuration paths

### User-level

LSD stores global state under:

```text
~/.lsd/
```

Typical contents include:

```text
~/.lsd/
  agent/
    auth.json
    settings.json
    extensions/
    agents/
  sessions/
```

### Project-level

Per-project state lives in:

```text
.lsd/
```

Depending on your workflow, this may contain plan files, state files, generated artifacts, and project-local config.

---

## Common commands

### Main CLI

```bash
lsd                      # start interactive session
lsd -c                   # resume last session
lsd --print "..."        # one-shot mode
lsd --list-models        # list available models
lsd --mode mcp           # run as MCP server
```

### Setup + maintenance

```bash
lsd config               # re-run setup wizard
lsd update               # update LSD
lsd sessions             # browse saved sessions
```

### Worktrees

```bash
lsd -w                   # create/resume worktree session
lsd worktree list
lsd worktree merge NAME
lsd worktree clean
lsd worktree remove NAME
```

### Headless

```bash
lsd headless
lsd headless next
lsd headless status
lsd headless --json auto
```

---

## Slash-command compatibility

Inside the session, you may still see legacy commands such as:

- `/gsd auto`
- `/gsd status`
- `/gsd config`
- `/gsd doctor`
- `/gsd queue`

These remain usable, but the product branding is LSD.

If you are rewriting docs or onboarding material, prefer:

- **LSD** for the product name
- **`lsd`** for the command
- **`.lsd/`** for project state
- **`~/.lsd/`** for global state

---

## Documentation

See the local docs in [`docs/`](./docs/) for deeper details.

Recommended starting points:

- [Getting Started](./docs/getting-started.md)
- [Commands Reference](./docs/commands.md)
- [Configuration](./docs/configuration.md)
- [Auto Mode](./docs/auto-mode.md)
- [Architecture](./docs/architecture.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Skills](./docs/skills.md)
- [Custom Models](./docs/custom-models.md)

> Note: parts of the docs may still contain older GSD wording. The README reflects the intended LSD-facing product language.

---

## Development

Build the repo:

```bash
npm run build
```

Link the local CLI globally:

```bash
npm link
```

Run the dev CLI:

```bash
npm run gsd
```

Run tests:

```bash
npm test
```

---

## License

MIT
