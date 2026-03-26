/**
 * Regression tests for #2684: preferences.md must be included in both
 * ROOT_STATE_FILES (sync) and copyPlanningArtifacts (initial seed).
 *
 * Without this, post_unit_hooks and all preference-driven config silently
 * stop working inside auto-mode worktrees.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("#2684: ROOT_STATE_FILES includes preferences.md", () => {
  const srcPath = join(import.meta.dirname, "..", "auto-worktree.ts");
  const src = readFileSync(srcPath, "utf-8");

  const constIdx = src.indexOf("ROOT_STATE_FILES");
  assert.ok(constIdx !== -1, "ROOT_STATE_FILES constant exists");

  const arrayStart = src.indexOf("[", constIdx);
  const arrayEnd = src.indexOf("]", arrayStart);
  const block = src.slice(arrayStart, arrayEnd);

  assert.ok(
    block.includes("preferences.md"),
    "preferences.md should be in ROOT_STATE_FILES list",
  );
});

test("#2684: copyPlanningArtifacts file list includes preferences.md", () => {
  const srcPath = join(import.meta.dirname, "..", "auto-worktree.ts");
  const src = readFileSync(srcPath, "utf-8");

  // Find the copyPlanningArtifacts function body
  const fnIdx = src.indexOf("function copyPlanningArtifacts");
  assert.ok(fnIdx !== -1, "copyPlanningArtifacts function exists");

  // Extract function body (up to the next top-level function)
  const fnBody = src.slice(fnIdx, fnIdx + 1500);

  assert.ok(
    fnBody.includes('"preferences.md"'),
    "preferences.md should be in copyPlanningArtifacts file list",
  );
});

test("#2684: syncGsdStateToWorktree copies preferences.md", async () => {
  // Functional test: create a mock source and destination, call the sync
  const srcBase = mkdtempSync(join(tmpdir(), "gsd-wt-prefs-src-"));
  const dstBase = mkdtempSync(join(tmpdir(), "gsd-wt-prefs-dst-"));
  const srcGsd = join(srcBase, ".gsd");
  const dstGsd = join(dstBase, ".gsd");
  mkdirSync(srcGsd, { recursive: true });
  mkdirSync(dstGsd, { recursive: true });

  try {
    // Write a preferences.md in source
    writeFileSync(
      join(srcGsd, "preferences.md"),
      "---\nversion: 1\n---\n\npost_unit_hooks:\n  - name: notify\n    command: echo done\n",
    );

    // Import and call syncGsdStateToWorktree
    const { syncGsdStateToWorktree } = await import("../auto-worktree.ts");
    syncGsdStateToWorktree(srcBase, dstBase);

    // Verify preferences.md was copied
    assert.ok(
      existsSync(join(dstGsd, "preferences.md")),
      "preferences.md should be copied to worktree",
    );

    const content = readFileSync(join(dstGsd, "preferences.md"), "utf-8");
    assert.ok(
      content.includes("post_unit_hooks"),
      "copied preferences.md should contain the hooks config",
    );
  } finally {
    rmSync(srcBase, { recursive: true, force: true });
    rmSync(dstBase, { recursive: true, force: true });
  }
});
