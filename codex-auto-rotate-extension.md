# Codex Auto-Rotate Extension for LSD

## Problem Statement

Users with multiple ChatGPT/Codex accounts want to automatically rotate between them when using LSD CLI to maximize quota utilization. Currently, the only option is relying on Cockpit Tools to externally rewrite `~/.codex/auth.json`, which:

- Only supports 1 active account at a time (serial swap)
- Requires an external Tauri app running
- Detects quota exhaustion reactively (after periodic refresh), not instantly
- Has no awareness of LSD's request lifecycle

## Goal

Build an LSD extension that manages multiple Codex OAuth accounts natively, leveraging LSD's built-in `AuthStorage` credential array + round-robin + per-credential backoff system.

## Key Technical Insights

### LSD's AuthStorage already supports multi-credential rotation

From `auth-storage.js`:
- `getCredentialsForProvider(provider)` — returns array of credentials
- `selectCredentialIndex(provider, credentials, sessionId)` — round-robin or session-sticky pick
- `markUsageLimitReached(provider, sessionId, { errorType })` — backs off one credential, tries next
- Backoff durations: 30s (rate limit), 30min (quota exhausted), 20s (server error)

### The Codex provider uses access_token as a Bearer token

From `openai-codex-responses.js`:
- `extractAccountId(token)` — extracts `chatgpt_account_id` from JWT claims
- `buildHeaders(...)` — sets `Authorization: Bearer <token>` and `chatgpt-account-id` header
- Both are derived from the token itself, so different tokens automatically target different accounts

### The auth resolution chain (per LLM API call)

```
agent-loop.js:254 — called every tool-use iteration:
  config.getApiKey(provider)
    → sdk.js: modelRegistry.getApiKeyForProvider("openai-codex")
      → authStorage.getApiKey("openai-codex", sessionId)
        1. Check runtime overrides
        2. Check auth.json credentials array → round-robin pick
        3. Check env var OPENAI_API_KEY
        4. Fallback: read ~/.codex/auth.json
```

### Why we can't just store multiple OAuth entries

`refreshOAuthTokenWithLock()` only finds the first OAuth credential:
```js
const cred = creds.find((c) => c.type === "oauth"); // only first
```

So storing 5 accounts as `type: "oauth"` would break token refresh for accounts 2-5.

## Design: "api_key" Credential Array with External Refresh

### Architecture

```
Extension-managed (private store with refresh tokens):
~/.lsd/agent/codex-accounts.json
┌──────────────────────────────────┐
│ { "accounts": [                  │
│   {                              │
│     "id": "acc_abc123",          │
│     "email": "user1@example.com",│
│     "accountId": "chatgpt_...",  │
│     "refreshToken": "rt_...",    │
│     "accessToken": "eyJ...",     │
│     "expiresAt": 1711234567890,  │
│     "addedAt": 1711234000000,    │
│     "lastUsed": 1711234500000,   │
│     "disabled": false            │
│   },                             │
│   { ... account 2 ... },         │
│   { ... account N ... }          │
│ ]}                               │
└──────────┬───────────────────────┘
           │
           │ Extension syncs fresh access tokens ↓
           │
LSD-native auth (auto-consumed by AuthStorage):
~/.lsd/agent/auth.json
┌──────────────────────────────────┐
│ {                                │
│   "anthropic": { ... },          │
│   "openai-codex": [              │
│     { "type":"api_key",          │
│       "key":"<access_token_1>" },│
│     { "type":"api_key",          │
│       "key":"<access_token_2>" },│
│     { "type":"api_key",          │
│       "key":"<access_token_N>" } │
│   ]                              │
│ }                                │
└──────────────────────────────────┘
```

### Why "api_key" type works

The `streamOpenAICodexResponses` provider only needs the access_token as `options.apiKey`. It:
1. Extracts `accountId` from the JWT payload itself
2. Sets `Authorization: Bearer <token>`
3. Sets `chatgpt-account-id` header from the extracted accountId

So from LSD's perspective, each Codex access_token looks and behaves like an API key. The `api_key` credential type gets:
- Round-robin selection ✅
- Per-credential backoff ✅
- No broken multi-OAuth refresh path ✅

### Token Refresh Strategy

Codex access tokens expire in ~30 minutes. The extension must proactively refresh them.

**Option A: Background interval timer**
- Extension starts a `setInterval` every 10-15 minutes
- Iterates all accounts, refreshes any token expiring within 10 minutes
- Atomically rewrites both `codex-accounts.json` and the `auth.json` credential array
- Uses `AuthStorage.withLockAsync()` pattern for safe concurrent access

**Option B: On-demand refresh (lazy)**
- Override the `resolveCredentialApiKey` path — check expiry before returning
- If expired, refresh inline before returning the key
- Simpler but adds latency to the first request after expiry

**Recommendation: Option A** — background refresh is better UX (no per-request latency spike) and aligns with how LSD's built-in OAuth refresh works.

### OAuth Login Flow

Reuse LSD's existing `loginOpenAICodex()` from `@gsd/pi-ai/oauth`:
```js
import { loginOpenAICodex } from "@gsd/pi-ai/oauth";
// or
import { openaiCodexOAuthProvider } from "@gsd/pi-ai/oauth";
```

This handles:
- PKCE challenge generation
- Local callback server on port 1455
- Authorization code → token exchange
- Account ID extraction from JWT

### Extension Commands

| Command | Description |
|---|---|
| `/codex add` | Start OAuth flow, add new account to pool |
| `/codex list` | Show all accounts: email, plan, token expiry, disabled status |
| `/codex remove <email\|index>` | Remove account from pool |
| `/codex enable <email\|index>` | Re-enable a disabled account |
| `/codex disable <email\|index>` | Temporarily exclude from rotation |
| `/codex status` | Show current rotation state, backoff timers, last errors |
| `/codex import` | Import from ~/.codex/auth.json (existing Codex login) |
| `/codex import-cockpit` | Import all accounts from Cockpit Tools store |
| `/codex sync` | Force-refresh all tokens and update auth.json |

### Extension Events / Hooks

1. **`session_start`** — Verify tokens are fresh, trigger refresh if needed
2. **`agent_end`** — Detect quota errors in the last response, call `markUsageLimitReached` for instant backoff
3. **Interval timer** — Background token refresh every 10 minutes
4. **`credential_change` listener** — Re-sync if auth.json is modified externally

### File Structure

```
~/.lsd/agent/extensions/codex-rotate/
├── index.js          # Extension entry point, lifecycle hooks
├── accounts.js       # Account CRUD, token refresh logic
├── oauth.js          # OAuth flow wrapper
├── sync.js           # auth.json ↔ codex-accounts.json sync
├── commands.js       # /codex command handlers
├── quota.js          # Error detection and backoff integration
└── config.js         # Extension settings (refresh interval, etc.)
```

### Security Considerations

1. `codex-accounts.json` stores refresh tokens → must be `chmod 600`
2. File locking for concurrent access (multiple LSD instances)
3. Refresh tokens are long-lived — handle revocation gracefully
4. Never log access tokens or refresh tokens in plaintext

### Edge Cases

1. **All accounts exhausted** — LSD's `areAllCredentialsBackedOff()` returns true, agent shows friendly error with estimated wait time
2. **Token refresh fails** — Mark account as temporarily disabled, log warning, continue with remaining accounts
3. **auth.json modified externally** — `reload()` on next `getApiKey` call picks up changes
4. **User also has Cockpit Tools** — Our extension takes priority (auth.json entry exists), Cockpit's `~/.codex/auth.json` becomes irrelevant as a fallback
5. **Mixed auth modes** — If user has some accounts via OAuth and manually adds API keys, both coexist in the credentials array

### Migration Path

1. User installs extension
2. `/codex import` pulls their current Codex login
3. `/codex add` (repeated) adds more accounts
4. Extension writes `openai-codex` array to auth.json
5. LSD's fallback to `~/.codex/auth.json` is never reached
6. Cockpit Tools becomes optional (nice-to-have dashboard, not required)

### Open Questions — Resolved

1. **Import from Cockpit Tools?** → **Yes.** High value. `~/.antigravity_cockpit/codex_accounts/*.json` files contain refresh tokens. Use `refreshOpenAICodexToken(refreshToken)` from `@gsd/pi-ai/oauth` to get fresh access tokens.
2. **Write back to `~/.codex/auth.json`?** → **No.** Once the extension writes `openai-codex` to `~/.lsd/agent/auth.json`, the fallback path to `~/.codex/auth.json` is never reached. Writing there adds complexity for zero benefit.
3. **Session-sticky vs round-robin?** → **Session-sticky is already the default.** `selectCredentialIndex` uses `hashString(sessionId)` when sessionId is provided. This is good — it aligns with Codex's `prompt_cache_key` (which is `sessionId`) for better server-side cache hits. Round-robin only kicks in when the sticky credential is backed off.
4. **Refresh interval?** → **10 minutes, refresh when `expiresAt - Date.now() < 5 * 60 * 1000`** (5 min before expiry). Handles clock skew and gives two retry windows.
5. **Proactive quota monitoring?** → **Skip for MVP.** Reactive 429 detection is sufficient. `markUsageLimitReached` with `errorType: "quota_exhausted"` gives 30-min backoff automatically.

---

## Review Findings (GPT-5.4 Audit)

### 🔴 Critical: 401 on expired tokens is NOT retried

When tokens are stored as `type: "api_key"`, AuthStorage does NOT attempt refresh — it returns the literal string. If background refresh fails and tokens expire, Codex returns 401. The provider's `isRetryableError()` only retries 429 and 5xx. Result: **hard failure, not graceful rotation.**

**Fix required:** The extension must hook `agent_end` events, detect 401/auth errors, and either:
- Trigger immediate token refresh for that credential, OR
- Call `authStorage.markUsageLimitReached(provider, sessionId, { errorType: "rate_limit" })` to skip to next credential

### 🟡 Do NOT use `authStorage.set()` for syncing

`set()` with `type: "api_key"` **appends and deduplicates by key value**. Since refreshed access tokens are different strings, calling `set()` after each refresh would grow the array with stale tokens forever.

**Fix required:** Use `storage.withLockAsync()` directly to atomically write the entire `openai-codex` credential array. Or call `remove("openai-codex")` then re-add all credentials.

### 🟡 Index-based backoff race on refresh

Backoff tracking uses credential **array index**, not credential identity. If the extension reorders or replaces the array during a backoff window, `markUsageLimitReached` could back off the wrong (new) credential at that index.

**Mitigation:** Keep credential order stable across refreshes. Only replace token values in-place, never reorder.

### ✅ Confirmed correct

- `api_key` type credentials get full round-robin + backoff
- JWT access tokens work as api_key values (no part of the chain assumes they're not JWTs)
- `resolveConfigValue()` is safe on JWTs (they start with `eyJ`, not `$` or `env:`)
- `getApiKey` is called per-turn in the tool-use loop (each `streamAssistantResponse()` call)

---

## Implementation Priority (MVP)

### Phase 1 — Core (build first)
1. **Account store** — `codex-accounts.json` CRUD with `chmod 600`
2. **Token sync to auth.json** — write `openai-codex` array using `FileAuthStorageBackend.withLockAsync()`, NOT `authStorage.set()`
3. **Background refresh timer** — `setInterval` in `session_start`, clear on shutdown. Call `refreshOpenAICodexToken(account.refreshToken)` for accounts within 5 min of expiry
4. **`/codex add`** — call `loginOpenAICodex()` from `@gsd/pi-ai/oauth`, store result
5. **`/codex list`** and **`/codex status`**

### Phase 2 — Resilience
6. **Error detection in `agent_end`** — detect quota/rate-limit/401 errors, call `markUsageLimitReached()`
7. **`/codex import`** — read `~/.codex/auth.json` for existing users
8. **`/codex remove`**, **`/codex disable`**, **`/codex enable`**

### Phase 3 — Polish
9. **`/codex import-cockpit`** — import from `~/.antigravity_cockpit/codex_accounts/*.json`
10. Credential change listener for external modifications
11. Status bar / floating card integration

---

## Key Source Files for Implementation

The implementing agent should read these files to understand the APIs:

| File | What to learn |
|---|---|
| `~/.nvm/versions/node/v22.22.0/lib/node_modules/lsd-pi/pkg/docs/extensions.md` | Extension API, lifecycle hooks, command registration |
| `~/.nvm/versions/node/v22.22.0/lib/node_modules/lsd-pi/packages/pi-coding-agent/dist/core/auth-storage.js` | `FileAuthStorageBackend`, `withLockAsync`, credential array format |
| `~/.nvm/versions/node/v22.22.0/lib/node_modules/lsd-pi/packages/pi-ai/dist/utils/oauth/openai-codex.js` | `loginOpenAICodex()`, `refreshOpenAICodexToken()`, OAuth flow |
| `~/.nvm/versions/node/v22.22.0/lib/node_modules/lsd-pi/packages/pi-ai/dist/providers/openai-codex-responses.js` | How tokens are used: `extractAccountId()`, `buildHeaders()` |
| `~/.lsd/agent/extensions/` | Existing extensions as examples for structure and patterns |
