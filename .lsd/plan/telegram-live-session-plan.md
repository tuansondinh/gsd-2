# Telegram live-session relay plan

Date: 2026-04-01
Status: planned
Mode: plan-only

## User goal
Build **agentic Telegram session relay** so a live LSD session can be bound to a Telegram chat and used bidirectionally, rather than only for one-off remote questions.

## Scope decisions confirmed
- Relay scope: **Chat + tools**
  - Telegram user messages should enter the active LSD session
  - Assistant replies should be sent back to Telegram
  - Tool/progress updates should also be visible in Telegram
- Binding mode: **Both**
  - Support **manual bind** to the current session first
  - Design for future **auto resume / wake** behavior
- Auth mode: **Bound chat only**
  - Only the configured/bound Telegram chat may control the session

## Findings from investigation

### Existing capabilities
1. There is already a bundled **remote-questions** extension with Telegram support:
   - `src/resources/extensions/remote-questions/telegram-adapter.ts`
   - `src/resources/extensions/remote-questions/manager.ts`
   - `src/resources/extensions/remote-questions/store.ts`
2. Current Telegram support is **prompt/response polling only**:
   - sends a prompt via `sendMessage`
   - polls `getUpdates`
   - parses only replies to a specific prompt or inline-button callbacks
3. The extension runtime **can inject live user messages into the active session** via:
   - `ExtensionAPI.sendUserMessage(...)`
4. The extension runtime can observe live session events for relay using:
   - `message_end`
   - `tool_execution_start`
   - `tool_execution_update`
   - `tool_execution_end`
   - `turn_start` / `turn_end`
5. Existing `/gsd remote ...` plumbing already routes through GSD command handling in the bundled GSD command dispatcher.

### Constraints / risks
1. The existing Telegram adapter stores only a simple `lastUpdateId` in-memory and is prompt-centric.
   - Live session relay needs a **separate update-consumption loop** and more durable state.
2. Telegram `getUpdates` is global per bot token.
   - Running both remote-questions polling and live-relay polling simultaneously could conflict unless updates are coordinated.
3. Tool output can be verbose.
   - Telegram relay needs truncation, chunking, coalescing, and rate limiting.
4. Auto-resume/wake should likely be a **phase 2** feature.
   - Manual bind for the current session is lower risk and matches current runtime architecture.

## Proposed architecture

### Phase 1: manual live bind for the current session
Add a session-scoped Telegram relay manager inside the `remote-questions` extension (or a sibling extension if separation becomes clearer during implementation).

#### Commands
Proposed commands:
- `/lsd telegram connect`
- `/lsd telegram disconnect`
- `/lsd telegram status`
- `/lsd telegram send <message>` (optional convenience)

Alias / compatibility options:
- `/lsd remote telegram` remains setup/config only
- `/lsd telegram ...` becomes live-session relay control

#### Runtime behavior
When connected:
1. Start a background poll loop using Telegram `getUpdates`
2. Accept only messages from the bound chat ID
3. Ignore stale backlog before connect (capture baseline update ID)
4. Forward inbound Telegram text to the active LSD session using `pi.sendUserMessage(...)`
5. Observe live session events and post outbound updates to Telegram:
   - assistant final messages
   - tool start/end summaries
   - selected progress notifications
6. Persist minimal runtime state under `~/.lsd/runtime/telegram-relay/`:
   - bound chat ID
   - current session identifier/path if available
   - last processed update ID
   - message correlation metadata / dedupe window

### Telegram message policy
Inbound from Telegram:
- Plain text => send as user message to current session
- Slash commands handled locally by relay:
  - `/status`
  - `/disconnect`
  - `/pause` or `/stop` (optional later)

Outbound to Telegram:
- Assistant replies: final message text, chunked if needed
- Tool events: compact summaries, e.g.
  - `🔧 bash started`
  - `✅ read finished`
  - `❌ browser_click failed`
- Optional verbose mode for partial updates/tool details

### Update coordination strategy
Because Telegram bot updates are shared, use one of these patterns:
1. **Preferred**: centralize Telegram update polling in a shared relay/update manager used by both remote-questions and live relay
2. **Fallback**: disable prompt polling while live relay is active for the same bot/chat

Recommendation: start with fallback behavior if centralization is too invasive, but structure code toward a shared update source.

## Implementation plan

### Milestone 1 — session relay foundations
- Add a relay state/store module
- Add Telegram live-relay manager with:
  - connect/disconnect lifecycle
  - poll loop
  - baseline `update_id` capture
  - inbound dedupe
- Add local formatting helpers for compact Telegram-safe output

### Milestone 2 — command surface
- Add `/lsd telegram connect|disconnect|status`
- Optionally expose equivalent `/remote live` variant if desired later
- Show helpful status/errors in the TUI

### Milestone 3 — outbound event relay
- Subscribe to session events:
  - `message_end`
  - `tool_execution_start`
  - `tool_execution_end`
- Relay assistant final responses and concise tool summaries to Telegram
- Add throttling / coalescing to prevent message spam

### Milestone 4 — inbound message relay
- Forward Telegram text into the active session via `pi.sendUserMessage(...)`
- Guard against echo loops (ignore bot-authored messages)
- Guard against stale updates and duplicate delivery

### Milestone 5 — hardening
- Handle reconnect on session reload
- Clean shutdown on session end/reload
- Persist and recover `lastUpdateId`
- Add tests for parsing, gating, relay state, and formatting

## Files likely involved

### Existing files to extend
- `src/resources/extensions/remote-questions/telegram-adapter.ts`
- `src/resources/extensions/remote-questions/remote-command.ts`
- `src/resources/extensions/remote-questions/mod.ts`
- `src/resources/extensions/remote-questions/extension-manifest.json`

### Likely new files
- `src/resources/extensions/remote-questions/telegram-live-relay.ts`
- `src/resources/extensions/remote-questions/telegram-live-store.ts`
- `src/resources/extensions/remote-questions/telegram-live-format.ts`
- `src/resources/extensions/remote-questions/telegram-live-types.ts`

### Possibly impacted command routing
- bundled GSD/LSD command routing for nested subcommands if `/lsd telegram ...` needs central help/completion integration

## Acceptance criteria
1. In a live LSD session, `/lsd telegram connect` succeeds for a configured bot/chat
2. A Telegram message sent from the bound chat appears as a user message in the current session
3. The assistant response is posted back to Telegram
4. Tool progress/result summaries appear in Telegram without flooding
5. Only the bound chat can control the session
6. Disconnect cleanly stops polling and relay output
7. Reload/restart behavior is documented and safe

## Explicit non-goals for first implementation
- multi-chat / multi-session multiplexing
- attachments/images/files from Telegram
- voice messages
- rich inline keyboards for full session control
- arbitrary auto-resume of historical sessions from Telegram without an explicit bind handshake

## Recommended execution order
1. Manual bind + status
2. Inbound text relay
3. Assistant outbound relay
4. Tool/progress relay
5. Persistence and reconnect
6. Optional auto-resume follow-up

## Open design note
The biggest architectural decision is whether to:
- retrofit the current Telegram adapter into a shared update consumer, or
- keep live relay as a separate poller and temporarily gate remote-questions polling while connected.

Recommendation for implementation: **start with separate live relay manager plus gating**, then refactor to a shared update source once behavior is validated.
