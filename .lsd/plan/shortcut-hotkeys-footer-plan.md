# Plan: shortcut discoverability in interactive TUI

## User request
- Add a keyboard shortcut to show shortcut commands.
- Always display the command for showing shortcuts in the footer.

## Clarified scope
- User chose `Ctrl+K` as the new shortcut.
- `Ctrl+K` currently conflicts with the editor action `deleteToLineEnd`.
- User chose to keep `Ctrl+K` for opening shortcuts, which means the existing delete-to-end-of-line binding must be reassigned.

## Findings
- `/hotkeys` already exists and renders the keyboard-shortcuts help panel.
  - `packages/pi-coding-agent/src/core/slash-commands.ts`
  - `packages/pi-coding-agent/src/modes/interactive/slash-command-handlers.ts`
- App-level shortcuts are handled before editor-level shortcuts in `CustomEditor.handleInput()`, so a new app action can intercept `Ctrl+K` cleanly.
  - `packages/pi-coding-agent/src/modes/interactive/components/custom-editor.ts`
- Current app keybindings live in:
  - `packages/pi-coding-agent/src/core/keybindings.ts`
- Current editor default `deleteToLineEnd` is `ctrl+k` in:
  - `packages/pi-tui/src/keybindings.ts`
- The footer is rendered in:
  - `packages/pi-coding-agent/src/modes/interactive/components/footer.ts`
- Existing footer test is source-text based:
  - `src/tests/footer-component.test.ts`

## Proposed implementation

### 1) Add a dedicated app action for showing shortcuts
- Extend `AppAction` with a new action such as `showHotkeys`.
- Add it to:
  - the `AppAction` union
  - `DEFAULT_APP_KEYBINDINGS`
  - `APP_ACTIONS`
- Default bind it to `ctrl+k`.

### 2) Wire the new action in interactive mode
- Register a handler in `InteractiveMode.setupKeyHandlers()`.
- Reuse existing slash-command behavior instead of duplicating UI logic.
  - Preferred approach: route to the same `/hotkeys` handler path, either by:
    - calling `dispatchSlashCommand("/hotkeys", this.getSlashCommandContext())`, or
    - extracting a reusable `showHotkeys(...)` helper and using it from both places.
- Keep behavior consistent with the slash command output.

### 3) Reassign the conflicting editor binding
- Change editor default `deleteToLineEnd` away from `ctrl+k`.
- Proposed replacement: `ctrl+shift+k`.
- Update any displayed shortcut text that comes from the editor keybinding registry so `/hotkeys` and startup hints remain accurate automatically.

### 4) Always show the shortcut-help command in the footer
- Update `FooterComponent.render()` to always append a persistent footer hint containing the command to open the shortcut list.
- Proposed displayed hint: `/hotkeys for shortcuts`.
- Preserve existing dim styling and truncation behavior.
- Likely implementation options:
  - append as a dedicated extra footer line, or
  - append to the extension-status line when present and otherwise render a standalone hint line.
- Preferred approach: dedicated extra dim line so it is always visible and not coupled to extension statuses.

## Validation plan
- Add/update tests for:
  1. footer source expectations to verify the persistent `/hotkeys` hint is rendered
  2. keybinding defaults so `showHotkeys` is bound to `ctrl+k`
  3. editor defaults so `deleteToLineEnd` is no longer `ctrl+k`
- Run targeted tests after implementation:
  - `src/tests/footer-component.test.ts`
  - relevant keybinding/unit tests in `packages/pi-coding-agent` and `packages/pi-tui` if present

## Risks / notes
- Rebinding `Ctrl+K` changes an existing editor shortcut, so this is a behavior change for current users.
- User-custom keybindings in config should still override defaults.
- If the footer becomes too tall in small terminals, we may need to ensure truncation or conditional rendering still behaves well.

## Files likely to change
- `packages/pi-coding-agent/src/core/keybindings.ts`
- `packages/pi-tui/src/keybindings.ts`
- `packages/pi-coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/pi-coding-agent/src/modes/interactive/slash-command-handlers.ts` (if helper extraction is used)
- `packages/pi-coding-agent/src/modes/interactive/components/footer.ts`
- `src/tests/footer-component.test.ts`
- possibly new or existing keybinding tests
