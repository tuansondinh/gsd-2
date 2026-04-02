# Plan: configurable main accent in settings

## Request
Add a user-facing settings option to configure the **main accent** color, instead of hardcoding a golden-yellow accent in selected theme files.

## User scope decision
- Settings UI mode: **Preset palette**
- Reason: fits the current select-list based settings UX and avoids adding free-text validation/input complexity in the first iteration.

## Important note
A previous partial change hardcoded `#F59E0B` into built-in theme source values (`packages/pi-coding-agent/src/modes/interactive/theme/themes.ts`). That does **not** satisfy the actual request because:
- it only touches some theme values,
- it does not provide a user setting,
- it changes defaults globally rather than making accent user-configurable.

Implementation should treat that hardcoded edit as temporary/incorrect and replace it with a proper override path.

---

## Findings from investigation

### Theme system
- Built-in themes live in:
  - `packages/pi-coding-agent/src/modes/interactive/theme/themes.ts`
- Theme loading / resolution / global theme switching live in:
  - `packages/pi-coding-agent/src/modes/interactive/theme/theme.ts`
- `createTheme()` resolves vars/colors into the runtime `Theme` instance.
- `setTheme()` / `initTheme()` load a theme by name and apply it globally.

### Settings persistence
- Settings schema and getters/setters live in:
  - `packages/pi-coding-agent/src/core/settings-manager.ts`
- Current settings already persist `theme?: string`.
- Adding a new top-level setting is straightforward via existing `setGlobalSetting()` patterns.

### Interactive settings UI
- Settings menu component:
  - `packages/pi-coding-agent/src/modes/interactive/components/settings-selector.ts`
- Settings menu wiring / callback handling:
  - `packages/pi-coding-agent/src/modes/interactive/interactive-mode.ts`
- Current UI already supports submenu-based selection and live preview for theme changes.

### Current limitation
- Users can choose a theme, but cannot override just the main accent.
- Accent-related visuals are distributed via theme color roles such as:
  - `accent`
  - `borderAccent`
  - `mdCode`
  - `mdListBullet`
  - and any vars/roles that currently point to accent-like values
- A proper fix should centralize the override in theme creation/loading, not hand-edit every consumer.

---

## Recommended implementation

### 1) Add a persisted accent setting
Update `Settings` in `packages/pi-coding-agent/src/core/settings-manager.ts` with a new field, likely one of:
- `accent?: string`
- or `themeAccent?: string`

Recommended name: **`themeAccent`**
- Clear meaning
- Avoids collision with other potential accent concepts later

Add matching getter/setter:
- `getThemeAccent(): string | undefined`
- `setThemeAccent(accent: string | undefined): void`

### 2) Use a preset palette, not free-form input
Define a small palette of named accent presets, for example:
- `default` (no override; use theme’s built-in accent)
- `golden-yellow`
- `blue`
- `green`
- `violet`
- `red`

Implementation detail:
- Store the preset key in settings, not only the raw hex.
- Maintain a central mapping from preset key -> hex.
- `default` should mean “do not override theme accent”.

This makes future UI labels and behavior cleaner than storing raw hex now.

### 3) Centralize accent override in the theme engine
Modify theme creation/loading in `packages/pi-coding-agent/src/modes/interactive/theme/theme.ts` so an accent override can be applied *before* the runtime `Theme` instance is created.

Best approach:
- Introduce a helper like `applyAccentOverride(themeJson, accentPreset)`.
- Clone the theme JSON and override the relevant accent-bearing slots in a controlled way.

Minimum override targets:
- `vars.accent` if present
- `colors.accent`
- `colors.mdCode` when it points at the old accent alias
- `colors.mdListBullet` when it is intended to follow accent
- `colors.borderAccent` if the desired UX is that the “main accent” drives accent borders too

Do **not** blindly rewrite unrelated colors like:
- warning
- success
- error
- syntax colors
- background colors

Goal:
- Preserve theme personality
- Make the main accent consistent across the places that semantically use the accent role

### 4) Ensure theme switching respects accent override
When the user changes themes, the selected accent override should still apply.

That means:
- `initTheme(...)` and `setTheme(...)` should load theme + apply current accent override
- Previewing a theme from settings should also preview it under the current accent override

Potential implementation pattern:
- theme loader reads the active override from a lightweight provider / injected function / settings-aware wrapper
- OR interactive-mode passes both theme name and accent preset when applying theme

Recommended for minimal blast radius:
- keep theme loading pure where possible,
- add a small wrapper/helper used by interactive mode for applying theme with current settings.

### 5) Add settings UI for accent selection
Update `packages/pi-coding-agent/src/modes/interactive/components/settings-selector.ts`:
- extend `SettingsConfig` with current accent + available accent presets
- extend `SettingsCallbacks` with:
  - `onThemeAccentChange(accent: string)`
  - optional preview callback if needed
- add a new settings item, likely near `Theme`
  - label: `Main accent`
  - description: `Primary accent color used by the interface`

Use the existing submenu/select-list pattern.

Recommended option list:
- `default`
- `golden-yellow`
- `blue`
- `green`
- `violet`
- `red`

### 6) Wire accent setting into interactive mode
Update `packages/pi-coding-agent/src/modes/interactive/interactive-mode.ts`:
- pass current accent + available presets into `SettingsSelectorComponent`
- handle `onThemeAccentChange`
- persist via `settingsManager.setThemeAccent(...)`
- re-apply current theme immediately after changing accent
- invalidate/request render so preview is visible right away

Behavior expectations:
- changing accent should update the live UI instantly
- changing theme afterward should preserve chosen accent
- canceling out of settings should not lose already-applied saved changes

### 7) Reconcile built-in theme defaults
Update `packages/pi-coding-agent/src/modes/interactive/theme/themes.ts` so built-in themes return to sensible defaults.

Specifically:
- revert the temporary hardcoded `#F59E0B` edits unless product explicitly wants golden-yellow as the new default for all users
- let the new settings override provide golden yellow when the user selects it

This keeps built-in theme defaults stable and avoids changing all users’ visuals unexpectedly.

---

## Files likely to change
- `packages/pi-coding-agent/src/core/settings-manager.ts`
- `packages/pi-coding-agent/src/modes/interactive/components/settings-selector.ts`
- `packages/pi-coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/pi-coding-agent/src/modes/interactive/theme/theme.ts`
- `packages/pi-coding-agent/src/modes/interactive/theme/themes.ts`

Possibly also:
- tests covering settings manager or theme loading
- docs/help text if settings are documented somewhere visible

---

## Acceptance criteria
- User can open settings and choose a **Main accent** preset.
- Accent choice is persisted in settings.json.
- Current theme updates immediately after changing accent.
- Switching between themes preserves the chosen accent override.
- `default` accent uses each theme’s built-in accent.
- Built-in theme files are not manually hardcoded to golden yellow just to simulate configurability.
- No regressions in theme preview/cancel flow.

---

## Validation plan after implementation
1. Build the project.
2. Launch interactive mode.
3. Open settings.
4. Change `Main accent` from `default` to `golden-yellow`.
5. Verify visible accent-bearing UI updates immediately.
6. Switch theme from dark -> light and confirm golden-yellow remains applied.
7. Switch `Main accent` back to `default` and confirm each theme returns to its native accent.
8. Restart app and verify persisted setting reloads correctly.

---

## Out of scope for first pass
- Arbitrary hex input
- Per-theme accent overrides
- Export-specific accent customization separate from terminal theme
- Editing custom theme JSON files from within settings
