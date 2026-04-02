import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const appKeybindingsSource = readFileSync(
  join(process.cwd(), "packages", "pi-coding-agent", "src", "core", "keybindings.ts"),
  "utf-8",
);

const editorKeybindingsSource = readFileSync(
  join(process.cwd(), "packages", "pi-tui", "src", "keybindings.ts"),
  "utf-8",
);

const interactiveModeSource = readFileSync(
  join(process.cwd(), "packages", "pi-coding-agent", "src", "modes", "interactive", "interactive-mode.ts"),
  "utf-8",
);

test("app keybindings declare showHotkeys bound to ctrl+k", () => {
  assert.match(appKeybindingsSource, /\| "showHotkeys";/, "AppAction should include showHotkeys");
  assert.match(appKeybindingsSource, /showHotkeys: "ctrl\+k"/, "showHotkeys should default to ctrl+k");
});

test("editor deleteToLineEnd is no longer bound to ctrl+k", () => {
  assert.match(
    editorKeybindingsSource,
    /deleteToLineEnd: "ctrl\+shift\+k"/,
    "deleteToLineEnd should move to ctrl+shift+k",
  );
  assert.doesNotMatch(
    editorKeybindingsSource,
    /deleteToLineEnd: "ctrl\+k"/,
    "deleteToLineEnd should not remain on ctrl+k",
  );
});

test("interactive mode wires showHotkeys action to hotkeys UI", () => {
  assert.match(
    interactiveModeSource,
    /onAction\("showHotkeys", \(\) => showHotkeys\(this\.getSlashCommandContext\(\)\)\)/,
    "interactive mode should bind showHotkeys to the hotkeys renderer",
  );
});
