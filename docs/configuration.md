# Configuration

LSD preferences live in `~/.lsd/PREFERENCES.md` (global) or `.lsd/PREFERENCES.md` (project-local). Manage interactively with `/lsd prefs`.

> Preferred command surface: use `/lsd ...`. Legacy `/gsd ...` aliases may still exist for compatibility.

## `/lsd prefs` Commands

| Command | Description |
|---------|-------------|
| `/lsd prefs` | Open the global preferences wizard (default) |
| `/lsd prefs global` | Interactive wizard for global preferences (`~/.lsd/PREFERENCES.md`) |
| `/lsd prefs project` | Interactive wizard for project preferences (`.lsd/PREFERENCES.md`) |
| `/lsd prefs status` | Show current preference files, merged values, and skill resolution status |
| `/lsd prefs wizard` | Alias for `/lsd prefs global` |
| `/lsd prefs setup` | Alias for `/lsd prefs wizard` — creates preferences file if missing |

## Preferences File Format

Preferences use YAML frontmatter in a markdown file:

```yaml
---
version: 1
models:
  research: claude-sonnet-4-6
  planning: claude-opus-4-6
  execution: claude-sonnet-4-6
  completion: claude-sonnet-4-6
subagent:
  budget_model: claude-haiku-4-5-20250414
skill_discovery: suggest
auto_supervisor:
  soft_timeout_minutes: 20
  idle_timeout_minutes: 10
  hard_timeout_minutes: 30
budget_ceiling: 50.00
token_profile: balanced
---
```

## Global vs Project Preferences

| Scope | Path | Applies to |
|-------|------|-----------|
| Global | `~/.lsd/PREFERENCES.md` | All projects |
| Project | `.lsd/PREFERENCES.md` | Current project only |

**Merge behavior:**
- **Scalar fields** (`skill_discovery`, `budget_ceiling`): project wins if defined
- **Array fields** (`always_use_skills`, etc.): concatenated (global first, then project)
- **Object fields** (`models`, `git`, `auto_supervisor`, `subagent`): shallow-merged, project overrides per-key

### `subagent.budget_model`

Optional budget-friendly model alias used by bundled budget-oriented subagents.

```yaml
subagent:
  budget_model: claude-haiku-4-5-20250414
```

The bundled `scout` subagent resolves `model: $budget_model`, so if this preference is set the scout runs on the cheaper model automatically. If omitted, scout falls back to the current session/default model.

## Global API Keys (`lsd config`)

Tool API keys are stored globally in `~/.lsd/agent/auth.json` and apply to all projects automatically. Set them once with `lsd config` — no need to configure per-project `.env` files.

```bash
lsd config
```

This opens an interactive wizard showing which keys are configured and which are missing.

### Supported keys

| Tool | Environment Variable | Purpose | Get a key |
|------|---------------------|---------|-----------|
| Tavily Search | `TAVILY_API_KEY` | Web search for non-Anthropic models | [tavily.com/app/api-keys](https://tavily.com/app/api-keys) |
| Brave Search | `BRAVE_API_KEY` | Web search for non-Anthropic models | [brave.com/search/api](https://brave.com/search/api) |
| Context7 Docs | `CONTEXT7_API_KEY` | Library documentation lookup | [context7.com/dashboard](https://context7.com/dashboard) |

### How it works

1. `lsd config` saves keys to `~/.lsd/agent/auth.json`
2. On every session start, `loadToolApiKeys()` reads the file and sets environment variables
3. Keys apply to all projects — no per-project setup required
4. Environment variables (`export BRAVE_API_KEY=...`) take precedence over saved keys
5. Anthropic models don't need Brave/Tavily — they have built-in web search

## MCP Servers

LSD can connect to external MCP servers configured in project files.

### Config file locations

LSD reads MCP client configuration from these project-local paths:

- `.mcp.json`
- `.lsd/mcp.json`

If both files exist, server names are merged and the first definition found wins. Use:

- `.mcp.json` for repo-shared MCP configuration you may want to commit
- `.lsd/mcp.json` for local-only MCP configuration you do **not** want to share

### Supported transports

| Transport | Config shape | Use when |
|-----------|--------------|----------|
| `stdio` | `command` + optional `args`, `env`, `cwd` | Launching a local MCP server process |
| `http` | `url` + optional `headers` | Connecting to an already-running MCP server over HTTP |

### Example: stdio server

```json
{
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "/absolute/path/to/python3",
      "args": ["/absolute/path/to/server.py"],
      "env": {
        "API_URL": "http://localhost:8000"
      }
    }
  }
}
```

### Example: HTTP server

```json
{
  "mcpServers": {
    "my-http-server": {
      "url": "http://localhost:8080/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_API_TOKEN}"
      }
    }
  }
}
```

### Verifying a server

After adding config, verify it from an LSD session:

```text
mcp_servers
mcp_discover(server="my-server")
mcp_call(server="my-server", tool="<tool_name>", args={...})
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LSD_HOME` | `~/.lsd` | Global LSD directory. All paths derive from this unless individually overridden. Affects preferences, skills, sessions, and per-project state. |
| `GSD_HOME` | `~/.lsd` | Legacy alias for `LSD_HOME` (also supported). |
| `GSD_PROJECT_ID` | (auto-hash) | Override the automatic project identity hash. Per-project state goes to `$LSD_HOME/projects/<GSD_PROJECT_ID>/` instead of the computed hash. Useful for CI/CD or sharing state across clones of the same repo. |
| `GSD_STATE_DIR` | `$LSD_HOME` | Per-project state root. Controls where `projects/<repo-hash>/` directories are created. |
| `GSD_CODING_AGENT_DIR` | `$LSD_HOME/agent` | Agent directory containing managed resources, extensions, and auth. |

## All Settings

### `models`

Per-phase model selection. Each key accepts a model string or an object with fallbacks.

```yaml
models:
  research: claude-sonnet-4-6
  planning:
    model: claude-opus-4-6
    fallbacks:
      - openrouter/z-ai/glm-5
  execution: claude-sonnet-4-6
  execution_simple: claude-haiku-4-5-20250414
  completion: claude-sonnet-4-6
  subagent: claude-sonnet-4-6
```

**Phases:** `research`, `planning`, `execution`, `execution_simple`, `completion`, `subagent`

- `execution_simple` — used for tasks classified as "simple" by the complexity router
- `subagent` — model for delegated subagent tasks (scout, researcher, worker)
- Provider targeting: use `provider/model` format (e.g., `bedrock/claude-sonnet-4-6`) or the `provider` field in object format

### Custom Model Definitions (`models.json`)

Define custom models and providers in `~/.lsd/agent/models.json`. This lets you add models not included in the default registry — useful for self-hosted endpoints (Ollama, vLLM, LM Studio), fine-tuned models, proxies, or new provider releases.

LSD resolves models.json with fallback logic:
1. `~/.lsd/agent/models.json` — primary
2. `~/.pi/agent/models.json` — fallback (Pi)

**Quick example for local models (Ollama):**

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "llama3.1:8b" },
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

The file reloads each time you open `/model` — no restart needed.

For full documentation, see the [Custom Models Guide](./custom-models.md).

**With fallbacks:**

```yaml
models:
  planning:
    model: claude-opus-4-6
    fallbacks:
      - openrouter/z-ai/glm-5
    provider: bedrock    # optional: target a specific provider
```

### `token_profile`

Coordinates model selection, phase skipping, and context compression.

Values: `budget`, `balanced` (default), `quality`

| Profile | Behavior |
|---------|----------|
| `budget` | Skips research + reassessment phases, uses cheaper models |
| `balanced` | Default behavior — all phases run, standard model selection |
| `quality` | All phases run, prefers higher-quality models |

### `phases`

Fine-grained control over which phases run in auto mode:

```yaml
phases:
  skip_research: false
  skip_reassess: false
  skip_slice_research: true
  reassess_after_slice: true
  require_slice_discussion: false
```

### `skill_discovery`

Controls how LSD finds and applies skills during auto mode.

| Value | Behavior |
|-------|----------|
| `auto` | Skills found and applied automatically |
| `suggest` | Skills identified during research but not auto-installed (default) |
| `off` | Skill discovery disabled |

### `auto_supervisor`

Timeout thresholds for auto mode supervision:

```yaml
auto_supervisor:
  model: claude-sonnet-4-6    # optional: model for supervisor
  soft_timeout_minutes: 20
  idle_timeout_minutes: 10
  hard_timeout_minutes: 30
```

### `budget_ceiling`

Maximum USD to spend during auto mode.

```yaml
budget_ceiling: 50.00
```

### `budget_enforcement`

| Value | Behavior |
|-------|----------|
| `warn` | Log a warning but continue |
| `pause` | Pause auto mode (default when ceiling is set) |
| `halt` | Stop auto mode entirely |

### `context_pause_threshold`

Context window usage percentage (0-100) at which auto mode pauses for checkpointing.

```yaml
context_pause_threshold: 80
```

### `verification_commands`

Shell commands that run automatically after every task execution. Failures trigger auto-fix retries before advancing.

```yaml
verification_commands:
  - npm run lint
  - npm run test
verification_auto_fix: true
verification_max_retries: 2
```

### `git`

Git behavior configuration:

```yaml
git:
  auto_push: false
  push_branches: false
  remote: origin
  snapshots: true
  pre_merge_check: auto
  commit_type: feat
  main_branch: main
  merge_strategy: squash      # "squash" or "merge"
  isolation: worktree         # "worktree", "branch", or "none"
  commit_docs: true
  manage_gitignore: true
  auto_pr: false
  pr_target_branch: develop
```

### `always_use_skills` / `prefer_skills` / `avoid_skills`

Skill routing preferences:

```yaml
always_use_skills:
  - debug-like-expert
prefer_skills:
  - frontend-design
avoid_skills: []
```

Skills can be bare names (looked up in `~/.lsd/skills/` and `.lsd/skills/`) or absolute paths.

### `skill_rules`

Situational skill routing with human-readable triggers:

```yaml
skill_rules:
  - when: task involves authentication
    use: [clerk]
  - when: frontend styling work
    prefer: [frontend-design]
```

### `custom_instructions`

Durable instructions appended to every session:

```yaml
custom_instructions:
  - "Always use TypeScript strict mode"
  - "Prefer functional patterns over classes"
```

### `dynamic_routing`

Complexity-based model routing. See [Dynamic Model Routing](./dynamic-model-routing.md).

```yaml
dynamic_routing:
  enabled: true
  escalate_on_failure: true
  budget_pressure: true
  cross_provider: true
```

### `parallel`

Run multiple milestones simultaneously. Disabled by default.

```yaml
parallel:
  enabled: false
  max_workers: 2
  budget_ceiling: 50.00
  merge_strategy: "per-milestone"
  auto_merge: "confirm"
```

See [Parallel Orchestration](./parallel-orchestration.md) for full documentation.

## Full Example

```yaml
---
version: 1

models:
  research: openrouter/deepseek/deepseek-r1
  planning:
    model: claude-opus-4-6
    fallbacks:
      - openrouter/z-ai/glm-5
  execution: claude-sonnet-4-6
  execution_simple: claude-haiku-4-5-20250414
  completion: claude-sonnet-4-6

token_profile: balanced

dynamic_routing:
  enabled: true
  escalate_on_failure: true
  budget_pressure: true

budget_ceiling: 25.00
budget_enforcement: pause
context_pause_threshold: 80

auto_supervisor:
  soft_timeout_minutes: 15
  hard_timeout_minutes: 25

git:
  auto_push: true
  merge_strategy: squash
  isolation: worktree
  commit_docs: true

skill_discovery: suggest
always_use_skills:
  - debug-like-expert
skill_rules:
  - when: task involves authentication
    use: [clerk]

notifications:
  on_complete: false
  on_milestone: true
  on_attention: true

auto_visualize: true
show_token_cost: true
---
```
