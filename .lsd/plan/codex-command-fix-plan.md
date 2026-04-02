# Codex command visibility fix plan

## Goal
Make `/codex add` show up and work reliably.

## What I investigated
- Confirmed a bundled `codex-rotate` extension exists in `src/resources/extensions/codex-rotate/` and `dist/resources/extensions/codex-rotate/`.
- Confirmed the extension registers `/codex` with subcommands including `add`.
- Found the extension currently fails TypeScript extension checks in this repo (`npm run typecheck:extensions`), with errors in:
  - `src/resources/extensions/codex-rotate/index.ts`
  - `src/resources/extensions/codex-rotate/oauth.ts`
  - `src/resources/extensions/codex-rotate/sync.ts`
- The failures are caused by API drift against current extension/runtime types:
  - `agent_end` no longer exposes `event.response`; it exposes `event.messages`.
  - `ExtensionContext` no longer exposes `ctx.sessionId`; session ID should come from `ctx.sessionManager.getSessionId()`.
  - Codex OAuth helpers return `OAuthCredentials` with extra fields typed as `unknown`, so `accountId` needs narrowing.
  - `FileAuthStorageBackend` now requires `withLockAsync`; the extension’s local stub no longer matches runtime shape.

## Likely user-facing impact
Even though an older built JS copy may still exist, the source extension is out of sync with the current runtime contracts. That makes `/codex` fragile and prevents a clean, releasable build. Fixing the contract drift is the right path before validating command visibility.

## Proposed changes
1. **Fix `codex-rotate/index.ts`**
   - Update `agent_end` handling to inspect the last assistant error from `event.messages`.
   - Use `ctx.sessionManager.getSessionId()` instead of `ctx.sessionId`.
   - Preserve quota/backoff behavior using the correct classified error type.

2. **Fix `codex-rotate/oauth.ts`**
   - Add a small narrowing helper for Codex OAuth credentials so `accountId` is treated as a string safely.
   - Narrow imported JSON values from `~/.codex/auth.json` / Cockpit files before use.

3. **Fix `codex-rotate/sync.ts`**
   - Replace the stale local backend shim with a typed dynamic import of the current auth-storage backend implementation.
   - Keep auth.json updates lock-safe through the runtime backend.

4. **Validate**
   - Run `npm run typecheck:extensions`.
   - If that passes, run the extension smoke/import test.
   - Optionally inspect command docs/reference if `/codex` should also be documented in `docs/commands.md`.

## Important note
I accidentally started editing source before restating the plan. I will pause here and not continue further until you approve the execution phase. If you want, I can also first revert those accidental edits and then apply the approved fix cleanly.
