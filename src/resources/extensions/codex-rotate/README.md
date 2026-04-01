# Codex OAuth Rotation Extension

This extension manages multiple ChatGPT/Codex OAuth accounts with automatic rotation and background token refresh.

## Features

- **Multiple account management**: Add, remove, enable, and disable multiple Codex OAuth accounts
- **Automatic rotation**: LSD's built-in round-robin credential selection automatically rotates between accounts
- **Background token refresh**: Tokens are automatically refreshed before expiry (every 10 minutes)
- **Quota detection**: Automatically detects quota/rate limit errors and backs off affected accounts
- **Import support**: Import existing accounts from `~/.codex/auth.json` or Cockpit Tools

## Commands

### `/codex add`
Start OAuth login flow to add a new account to your pool.

```bash
/codex add
```

### `/codex list`
Display all configured accounts with their status.

```bash
/codex list
```

### `/codex status`
Show current rotation state, token expiry, and backoff status.

```bash
/codex status
```

### `/codex remove <index|email>`
Remove an account from the pool.

```bash
/codex remove 1
# or
/codex remove user@example.com
```

### `/codex enable <index|email>`
Re-enable a previously disabled account.

```bash
/codex enable 2
```

### `/codex disable <index|email>`
Temporarily disable an account (excludes it from rotation).

```bash
/codex disable 1
```

### `/codex import`
Import your existing Codex account from `~/.codex/auth.json`.

```bash
/codex import
```

### `/codex import-cockpit`
Import all accounts from Cockpit Tools store.

```bash
/codex import-cockpit
```

### `/codex sync`
Force refresh all tokens and update auth.json.

```bash
/codex sync
```

## Architecture

The extension uses a dual-store architecture:

1. **Extension store** (`~/.lsd/agent/codex-accounts.json`): Private store with refresh tokens
2. **LSD auth store** (`~/.lsd/agent/auth.json`): Access tokens written as `api_key` credentials

### Why "api_key" type?

Codex access tokens work identically to API keys:
- They contain the account ID in the JWT payload
- The Codex provider extracts this automatically
- Using `api_key` type gets full round-robin + backoff support
- Avoids the multi-OAuth refresh bug (only first OAuth credential gets refreshed)

### Token Refresh Strategy

- Background timer runs every 10 minutes
- Tokens are refreshed when expiring within 5 minutes
- Refreshed tokens are atomically synced to auth.json
- Failed refreshes disable the account with a reason

### Error Handling

The extension hooks into `agent_end` events to detect:
- Rate limit errors (429) → 30s backoff
- Quota exhausted errors → 30min backoff
- Auth errors (401) → treated as rate limits for immediate rotation

## Security

- `codex-accounts.json` is always `chmod 600`
- File locking prevents concurrent access issues
- Refresh tokens are long-lived but handled securely
- Tokens are never logged in plaintext

## Migration Path

1. Install extension (bundled with LSD)
2. Run `/codex import` to pull your current Codex login
3. Run `/codex add` (multiple times) to add more accounts
4. Extension writes `openai-codex` array to auth.json
5. LSD's fallback to `~/.codex/auth.json` is never reached
6. Cockpit Tools becomes optional (dashboard only, not required)

## Example Workflow

```bash
# Add first account
/codex add
# → Opens browser, complete login

# Add second account
/codex add
# → Opens browser, complete login

# Check status
/codex status
# → Shows 2 active accounts, token expiry times

# Disable one temporarily
/codex disable 1
# → Account excluded from rotation

# Re-enable later
/codex enable 1

# Refresh all tokens manually
/codex sync
```

## Troubleshooting

### "No accounts configured"
Run `/codex add` or `/codex import` to set up your first account.

### "All Codex credentials are backed off"
Wait for the backoff period (30s for rate limit, 30min for quota) or run `/codex status` to see wait times.

### Token refresh failures
The extension automatically disables accounts that fail to refresh. Check `/codex status` for details and re-add the account with `/codex add`.

### Want to go back to single account?
Run `/codex remove` to delete unwanted accounts, keeping only one.
