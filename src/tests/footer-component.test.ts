import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const footerSource = readFileSync(
  join(process.cwd(), "packages", "pi-coding-agent", "src", "modes", "interactive", "components", "footer.ts"),
  "utf-8",
);

test("FooterComponent dims extension status lines to match the rest of the footer", () => {
  assert.match(
    footerSource,
    /theme\.fg\("dim", statusLine\)/,
    "extension status line should be wrapped in the dim footer color",
  );
});

test("FooterComponent keeps hotkeys and cache timer on the first line right end", () => {
  assert.match(
    footerSource,
    /hotkeysHints = \["Ctrl\+K • \/hotkeys", "\/hotkeys", "Ctrl\+K"\]/,
    "footer should choose from compact hotkeys hints",
  );
  assert.match(
    footerSource,
    /cacheTimerStatusRaw = extensionStatuses\.get\("cache-timer"\)/,
    "footer should read cache-timer status for the first line",
  );
  assert.match(
    footerSource,
    /pwdLine = truncatedPwd \+ padding \+ firstLineRight/,
    "footer should right-align first-line metadata next to the path",
  );
  assert.match(
    footerSource,
    /filter\(\(\[key\]\) => key !== "cache-timer"\)/,
    "cache-timer should be excluded from the extension status line",
  );
});
