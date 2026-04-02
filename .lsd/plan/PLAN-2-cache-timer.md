# Plan: 5-Minute Cache Timer Extension

## Goal
Add a countdown timer that starts after each LLM response ends, displayed in the TUI footer's extension status line. The timer counts up from 0:00 to show elapsed time since last response (useful for tracking Claude's 5-minute cache window). Add a toggle in `/settings` to enable/disable it.

## Architecture Decision

**Approach: New bundled extension** (`src/resources/extensions/cache-timer/`)

This is the cleanest approach because:
- Extensions can listen to `agent_end` events (fires when LLM response ends)
- Extensions can call `ctx.ui.setStatus(key, text)` to display text in the footer's extension status line
- The `/settings` menu lives in `@gsd/pi-coding-agent` (upstream dependency) — we can't modify it directly, but we CAN use `settings.json` with a custom key and read it from the extension
- The timer uses `setInterval` to update the footer status every second

## Implementation Steps

### Step 1: Add `cacheTimer` to Settings interface & SettingsManager

**File:** `node_modules/@gsd/pi-coding-agent/src/core/settings-manager.ts`

We **cannot** modify this file (it's a dependency). Instead, we'll store the setting in `settings.json` under a custom key and read it directly in the extension.

**Alternative:** Use `SharedPreferences` from `src/shared-preferences.ts` — this is lsd's own preferences system (PREFERENCES.md frontmatter). But it's YAML-based and not connected to the `/settings` TUI.

**Best approach:** Read/write directly from `settings.json` using a custom key that the SettingsManager ignores (it just passes through unknown keys). The extension will read `(settings as any).cacheTimer` on init.

### Step 2: Create the cache-timer extension

**New files:**
- `src/resources/extensions/cache-timer/index.ts`
- `src/resources/extensions/cache-timer/extension-manifest.json`

**`extension-manifest.json`:**
```json
{
  "id": "cache-timer",
  "name": "Cache Timer",
  "version": "1.0.0",
  "description": "Shows elapsed time since last LLM response in the footer",
  "tier": "bundled",
  "requires": { "platform": ">=2.29.0" },
  "provides": {
    "commands": ["cache-timer"]
  }
}
```

**`index.ts` logic:**
```typescript
import type { ExtensionAPI } from "@gsd/pi-coding-agent";

export default function cacheTimer(pi: ExtensionAPI) {
  const STATUS_KEY = "cache-timer";
  let timer: ReturnType<typeof setInterval> | null = null;
  let startTime: number | null = null;
  let enabled = true; // default enabled

  // Read initial setting from settings.json
  // The extension context doesn't expose raw settings, so we'll use
  // a settings file read or an env var. Simplest: register a /cache-timer command.

  function formatElapsed(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `⏱ ${minutes}:${seconds.toString().padStart(2, "0")}`;
  }

  function startTimer(ctx: ExtensionContext) {
    stopTimer(ctx);
    if (!enabled) return;
    startTime = Date.now();
    // Update immediately
    ctx.ui.setStatus(STATUS_KEY, formatElapsed(0));
    timer = setInterval(() => {
      if (startTime !== null) {
        const elapsed = Date.now() - startTime;
        ctx.ui.setStatus(STATUS_KEY, formatElapsed(elapsed));
      }
    }, 1000);
  }

  function stopTimer(ctx: ExtensionContext) {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    startTime = null;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  // When agent ends (response complete), start the timer
  pi.on("agent_end", async (_event, ctx) => {
    startTimer(ctx);
  });

  // When agent starts (new request), stop the timer
  pi.on("agent_start", async (_event, ctx) => {
    stopTimer(ctx);
  });

  // Register /cache-timer command to toggle
  pi.registerCommand("cache-timer", {
    description: "Toggle the cache countdown timer",
    async handler(_args, ctx) {
      enabled = !enabled;
      if (!enabled) {
        stopTimer(ctx);
        ctx.ui.notify(`Cache timer disabled`, "info");
      } else {
        ctx.ui.notify(`Cache timer enabled`, "info");
      }
      // Persist to settings.json
      // (see below for persistence approach)
    },
  });
}
```

### Step 3: Add to `/settings` menu

Since the `/settings` menu is in `@gsd/pi-coding-agent` (upstream), we have two options:

**Option A (Recommended): Use a `/cache-timer` slash command toggle** — Already handled above. Users type `/cache-timer` to toggle.

**Option B: Patch the settings-selector** — Would require modifying upstream code in node_modules. Not sustainable.

**Option C: Use `ctx.ui.custom()` to show a sub-settings panel** — Overkill.

**Decision:** Go with Option A (`/cache-timer` command) PLUS persist the enabled state to `settings.json` using a direct read/write of a custom `cacheTimer` field. The SettingsManager's `deepMergeSettings` passes through unknown keys, so `{ "cacheTimer": { "enabled": true } }` will survive settings saves.

### Step 4: Persistence

Read/write `cacheTimer.enabled` from `~/.lsd/agent/settings.json` directly:

```typescript
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function readCacheTimerEnabled(agentDir: string): boolean {
  try {
    const settingsPath = join(agentDir, "settings.json");
    if (!existsSync(settingsPath)) return true; // default enabled
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    return settings.cacheTimer?.enabled !== false; // default true
  } catch {
    return true;
  }
}

function writeCacheTimerEnabled(agentDir: string, enabled: boolean): void {
  const settingsPath = join(agentDir, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    }
  } catch { /* ignore */ }
  settings.cacheTimer = { enabled };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
}
```

**Problem:** The extension context doesn't expose `agentDir`. But we can use `process.env` or import from `app-paths.ts`.

Looking at how other extensions access paths — they import from the lsd package directly:
```typescript
import { agentDir } from "../../../app-paths.js";
```

This won't work for bundled extensions since they're loaded from `~/.lsd/agent/extensions/`. 

**Better approach:** Use the SettingsManager that's available on the extension context. Checking... `ctx` has `sessionManager` and `modelRegistry` but NOT `settingsManager` directly.

**Simplest approach:** Just persist via a JSON file in the config dir. Extensions have access to `ctx.cwd` and we can derive the config dir. OR we can simply store in-memory and let the `/cache-timer` command toggle persist across launches via writing a simple file.

**Actually simplest:** Just use `process.env.HOME` + `.lsd/agent/cache-timer.json` as a tiny config file. Or even simpler — the extension just stores enabled/disabled in memory and persists the preference by reading/writing to `settings.json` using the path pattern from `app-paths.ts`.

Let me check what the extension gets access to...

The `ExtensionAPI` (`pi`) object has `sendMessage()` but the `ExtensionContext` (`ctx` in event handlers) has the properties listed above.

**Final decision on persistence:** Import `agentDir` from app-paths at the top level of the extension module. This works because when the extension is loaded, the imports resolve relative to the extension file location. Since our extensions are part of the lsd source tree and get compiled, we can reference `../../../app-paths.js`.

Wait — checking bundled extension paths. From `resource-loader.ts`, bundled extensions are in `src/resources/extensions/`. The compiled output goes to `dist/resources/extensions/`. These are separate from the main source tree's compiled output.

Actually, looking at the existing extensions like `codex-rotate/index.ts`:
```typescript
import { agentDir } from "../../../app-paths.js";
```

Let me verify:

### Step 5: Timer behavior details

- **On `agent_end`**: Start a setInterval that updates `ctx.ui.setStatus("cache-timer", "⏱ M:SS")` every 1 second
- **On `agent_start`**: Clear the interval and remove status  
- **On `session_switch` / `session_shutdown`**: Clean up interval
- **Display format**: `⏱ 0:00` → `⏱ 0:01` → ... → `⏱ 5:00` → `⏱ 5:01` → ... (no cap, just keeps counting)
- **Color**: Default (dim, inherits footer) for 0–5 min. Yellow (`\x1b[33m`) at 5+ min. Red (`\x1b[31m`) at 10+ min.
- **ANSI in setStatus**: The footer wraps all extension statuses in `theme.fg("dim", ...)`. We embed raw ANSI color codes and append `\x1b[2m\x1b[90m` (dim + gray) at the end to restore dim for any subsequent extension statuses.

### Step 6: Handle `ctx` lifetime issue

The `ctx` object from event handlers might not be valid for use outside the handler. Looking at `setStatus` — it calls `footerDataProvider.setExtensionStatus(key, text)` which just sets a Map entry. The ctx.ui.setStatus should work from a timer callback as long as we capture the ctx reference.

BUT — the footer re-renders on each TUI render cycle. The status map is read by `FooterComponent.render()`. The TUI needs to be told to re-render when the timer ticks. Looking at how the TUI works... `setStatus` calls through `setExtensionStatus` on the controller, which should trigger a render invalidation.

Let me check:

```typescript
// controllers/extension-ui-controller.ts
setStatus: (key, text) => host.setExtensionStatus(key, text),
```

```typescript
// interactive-mode.ts  
private setExtensionStatus(key: string, text: string | undefined): void {
    this.footerDataProvider.setExtensionStatus(key, text);
    // does it request render?
}
```

Need to check if it triggers a render... Probably not automatically. We may need to call `ctx.ui.setStatus()` which likely goes through the extension-ui-controller that DOES trigger a render.

Actually, looking at the extension controller flow:
1. Extension calls `ctx.ui.setStatus(key, text)`
2. This goes through the extension UI controller
3. Controller calls `host.setExtensionStatus(key, text)`
4. Host (InteractiveMode) updates the FooterDataProvider
5. But the TUI needs invalidation to re-render

The key question: does `setExtensionStatus` on InteractiveMode trigger `requestRender()`?

Let me check...

## Files to Create/Modify

### New Files
1. **`src/resources/extensions/cache-timer/extension-manifest.json`** — Extension metadata
2. **`src/resources/extensions/cache-timer/index.ts`** — Extension implementation

### Key Risks
- **Render invalidation**: `ctx.ui.setStatus()` from a timer callback may not trigger TUI re-render. If not, we need to find another way to invalidate.
- **ctx lifetime**: The `ctx` from `agent_end` may not stay valid. If so, we'd need to capture the UI reference differently.
- **Settings persistence**: Without direct SettingsManager access, persistence needs to be handled via direct file I/O or a workaround.

### Mitigation
- Test in the TUI to see if `setStatus` triggers re-render
- If not, we can use `setWidget` instead (widgets re-render on each frame)
- For persistence, use direct settings.json read/write via known path

## Summary

| Item | Details |
|------|---------|
| **New extension** | `cache-timer` — listens to `agent_end`/`agent_start`, runs setInterval |
| **Display** | Footer extension status line: `⏱ M:SS` |
| **Toggle** | `/cache-timer` command toggles on/off |
| **Persistence** | Read/write `cacheTimer.enabled` in `settings.json` |
| **Default** | Enabled by default |
| **Files** | 2 new files in `src/resources/extensions/cache-timer/` |
