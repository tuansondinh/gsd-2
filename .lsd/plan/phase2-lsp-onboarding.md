# Phase 2: LSP Onboarding Wizard Integration — Execution Plan

## Overview

Add a `runLspStep()` function to `src/onboarding.ts` and wire it into the `runOnboarding()` flow after the budget model step. This step detects missing language servers, prompts the user to select which ones to install, runs installs with spinners, and reports results in the summary.

## Changes

### File: `src/onboarding.ts`

#### Change 1: Add import for lsp-install utilities

**Location:** After line 19 (`import { accentAnsi } from './cli-theme.js'`)

**Add:**
```ts
import { detectMissingServers, detectInstalledServers, installServer, getInstallCommand } from './lsp-install.js'
```

**Rationale:** ESM requires `.js` extension. We need `detectMissingServers` and `detectInstalledServers` for detection, `installServer` for running installs, and `getInstallCommand` for showing hints in the multiselect.

---

#### Change 2: Add `runLspStep()` function

**Location:** After the `runBudgetModelStep()` function (around line 400), before the LLM Authentication Step section.

**Add the complete function:**

```ts
async function runLspStep(
  p: ClackModule,
  pc: PicoModule,
  settingsManager: SettingsManager,
  cwd: string,
): Promise<string[] | null> {
  // Detect what's missing and what's already installed
  const missing = detectMissingServers(cwd)
  const alreadyInstalled = detectInstalledServers(cwd)

  // If nothing is missing, skip silently
  if (missing.length === 0) {
    p.log.info(`Language servers: all detected servers already installed ${pc.green('✓')}`)
    return []
  }

  // Log already-installed servers if any
  if (alreadyInstalled.length > 0) {
    p.log.info(
      `Already installed: ${alreadyInstalled.map(s => pc.green(s.label)).join(', ')}`,
    )
  }

  // Build multiselect options
  const options = missing.map(entry => ({
    value: entry.name,
    label: entry.label,
    hint: entry.installCommand,
  }))

  // Pre-select typescript-language-server if present
  const initialValues = missing
    .filter(s => s.name === 'typescript-language-server')
    .map(s => s.name)

  const selected = await p.multiselect({
    message: 'Which language servers would you like to install?',
    options,
    initialValues,
    required: false,
  })

  // User cancelled
  if (p.isCancel(selected)) return null

  // Nothing selected
  const selectedNames = selected as string[]
  if (selectedNames.length === 0) return null

  // Install each selected server
  const successfullyInstalled: string[] = []

  for (const name of selectedNames) {
    const entry = missing.find(s => s.name === name)
    const label = entry?.label ?? name
    const s = p.spinner()
    s.start(`Installing ${label}...`)

    const result = await installServer(name)

    if (result.success) {
      s.stop(`${label} ${pc.green('✓')}`)
      successfullyInstalled.push(name)
    } else {
      s.stop(`${label} ${pc.red('✗')} — ${result.error ?? 'unknown error'}`)
    }
  }

  // Save successfully installed servers to settings
  if (successfullyInstalled.length > 0) {
    const existing = settingsManager.getLspInstalledServers()
    const merged = [...new Set([...existing, ...successfullyInstalled])]
    settingsManager.setLspInstalledServers(merged)
  }

  return successfullyInstalled
}
```

**Key design decisions:**
- Returns `string[]` (installed names) on success, `[]` if all already installed, `null` if skipped/cancelled
- Pre-selects `typescript-language-server` via `initialValues`
- Uses `p.isCancel()` to detect symbol cancellation from `p.multiselect()`
- Install failures logged with error but don't throw — loop continues
- Deduplicates when merging with existing installed servers via `Set`
- `required: false` on multiselect allows empty selection

---

#### Change 3: Wire `runLspStep` into `runOnboarding()` flow

**Location:** After the budget model step try/catch block and BEFORE the `// ── Summary` section.

**Add:**
```ts
  // ── Language Server Installation ──────────────────────────────────────────
  let lspInstalled: string[] | null = null
  try {
    lspInstalled = await runLspStep(p, pc, settingsManager, process.cwd())
  } catch (err) {
    if (isCancelError(p, err)) {
      p.cancel('Setup cancelled.')
      return
    }
    p.log.warn(`Language server setup failed: ${err instanceof Error ? err.message : String(err)}`)
  }
```

**Pattern match:** Follows exact same structure as `budgetModel`, `classifierModel`, `toolKeyCount`, etc. — variable declaration, try/catch, cancel check, warn fallback.

---

#### Change 4: Add LSP status line to summary section

**Location:** In the summary section, after the budget model summary line and before `p.note(summaryLines.join('\n'), 'Setup complete')`.

**Add:**
```ts
  if (lspInstalled && lspInstalled.length > 0) {
    summaryLines.push(`${pc.green('✓')} Language servers: ${lspInstalled.join(', ')} (${lspInstalled.length} installed)`)
  } else if (lspInstalled === null) {
    summaryLines.push(`${pc.dim('↷')} Language servers: skipped — run /setup to install later`)
  } else {
    // lspInstalled is [] — all already installed
    summaryLines.push(`${pc.green('✓')} Language servers: all detected servers already installed`)
  }
```

**Logic:**
- `lspInstalled.length > 0`: Successfully installed some → show names and count
- `lspInstalled === null`: User cancelled/skipped → show skip message with hint
- `lspInstalled` is `[]`: All were already installed → show all-good message

---

## Edge Cases Handled

1. **`p.multiselect` returns symbol on cancel** → checked with `p.isCancel(selected)`, returns `null`
2. **No servers in LSP_INSTALL_MAP match cwd** → `detectMissingServers` returns `[]` → log info, return `[]`
3. **Install failure** → caught by `installServer()` returning `{ success: false }` → log with red ✗, continue loop
4. **Step throws unexpectedly** → outer try/catch in `runOnboarding()` catches, warns, continues
5. **User selects nothing** → `selectedNames.length === 0` → return `null` (skipped)

## Verification

```bash
npx tsc --noEmit
```

## Commit

```
feat: add LSP server install step to onboarding wizard
```
