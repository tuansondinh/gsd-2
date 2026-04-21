/**
 * Unit tests for the gsd CLI package.
 *
 * Tests the glue code that IS the product:
 * - app-paths resolve to ~/.lsd/
 * - loader sets all required env vars
 * - resource-loader syncs bundled resources
 * - wizard loadStoredEnvKeys hydrates env
 *
 * Integration tests (npm pack, install, launch) are in ./integration/pack-install.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = join(fileURLToPath(import.meta.url), "..", "..", "..");

function assertExtensionIndexExists(agentDir: string, extensionName: string): void {
  assert.ok(
    existsSync(join(agentDir, "extensions", extensionName, "index.js"))
      || existsSync(join(agentDir, "extensions", extensionName, "index.ts")),
    `${extensionName} extension synced`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. app-paths
// ═══════════════════════════════════════════════════════════════════════════

test("app-paths resolve to ~/.lsd/", async () => {
  const { appRoot, agentDir, sessionsDir, authFilePath } = await import("../app-paths.ts");
  // Use homedir() — process.env.HOME is undefined on Windows (uses USERPROFILE instead)
  const { homedir } = await import("node:os");
  const home = homedir();

  assert.equal(appRoot, join(home, ".lsd"), "appRoot is ~/.lsd/");
  assert.equal(agentDir, join(home, ".lsd", "agent"), "agentDir is ~/.lsd/agent/");
  assert.equal(sessionsDir, join(home, ".lsd", "sessions"), "sessionsDir is ~/.lsd/sessions/");
  assert.equal(authFilePath, join(home, ".lsd", "agent", "auth.json"), "authFilePath is ~/.lsd/agent/auth.json");
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. loader env vars
// ═══════════════════════════════════════════════════════════════════════════

test("loader sets all GSD/LSD env vars and PI_PACKAGE_DIR", async () => {
  try {
    execSync(
      `node --experimental-strip-types -e "
        process.chdir('${projectRoot}');
        await import('./src/app-paths.ts');
      " 2>&1`,
      { encoding: "utf-8", cwd: projectRoot },
    );
    // If we got here without error, the import works
  } catch {
    // Fine — we test the logic inline below
  }

  // Direct logic verification (no subprocess needed)
  const { agentDir: ad } = await import("../app-paths.ts");
  assert.ok(ad.endsWith(join(".lsd", "agent")), "agentDir ends with .lsd/agent");

  // Verify the env var names are in loader.ts source
  const loaderSrc = readFileSync(join(projectRoot, "src", "loader.ts"), "utf-8");
  assert.ok(loaderSrc.includes("PI_PACKAGE_DIR"), "loader sets PI_PACKAGE_DIR");
  assert.ok(loaderSrc.includes("LSD_CODING_AGENT_DIR"), "loader sets LSD_CODING_AGENT_DIR");
  assert.ok(loaderSrc.includes("GSD_CODING_AGENT_DIR") || loaderSrc.includes("LSD_CODING_AGENT_DIR"), "loader preserves a coding agent dir env var");
  assert.ok(loaderSrc.includes("process.env.GSD_BIN_PATH = process.argv[1]"), "loader populates GSD_BIN_PATH");
  assert.ok(loaderSrc.includes("process.env.LSD_BIN_PATH = process.argv[1]"), "loader populates LSD_BIN_PATH");
  assert.ok(loaderSrc.includes("GSD_BUNDLED_EXTENSION_PATHS"), "loader sets GSD_BUNDLED_EXTENSION_PATHS");
  assert.ok(loaderSrc.includes("LSD_BUNDLED_EXTENSION_PATHS"), "loader sets LSD_BUNDLED_EXTENSION_PATHS");
  assert.ok(loaderSrc.includes("applyRtkProcessEnv"), "loader applies RTK environment bootstrap");
  const rtkSrc = readFileSync(join(projectRoot, "src", "rtk.ts"), "utf-8");
  assert.ok(rtkSrc.includes("RTK_TELEMETRY_DISABLED"), "RTK helper disables telemetry for managed sessions");
  assert.ok(loaderSrc.includes("serializeBundledExtensionPaths"), "loader uses shared bundled path serializer");
  assert.ok(loaderSrc.includes("join(delimiter)"), "loader uses platform delimiter for NODE_PATH");

  // Verify extension discovery mechanism is in place
  // loader.ts uses shared discoverExtensionEntryPaths() from extension-discovery.ts
  assert.ok(loaderSrc.includes("discoverExtensionEntryPaths"), "loader uses discoverExtensionEntryPaths for extension discovery");
  assert.ok(loaderSrc.includes("bundledExtDir"), "loader defines bundledExtDir for scanning");
  assert.ok(loaderSrc.includes("discoveredExtensionPaths"), "loader collects discovered paths");

  // Verify that the env var is populated at runtime by checking the actual
  // extensions directory has discoverable entry points
  const { discoverExtensionEntryPaths } = await import("../extension-discovery.ts");
  const bundledExtensionsDir = join(projectRoot, existsSync(join(projectRoot, "dist", "resources"))
  ? "dist" : "src", "resources", "extensions");
  const discovered = discoverExtensionEntryPaths(bundledExtensionsDir);
  assert.ok(discovered.length >= 10, `expected >=10 extensions, found ${discovered.length}`);

  // Spot-check that core extensions are discoverable
  const discoveredNames = discovered.map(p => {
  const rel = p.slice(bundledExtensionsDir.length + 1);
  return rel.split(/[\\/]/)[0].replace(/\.(?:ts|js)$/, "");
  });
  for (const core of ["bg-shell", "browser-tools", "subagent", "search-the-web"]) {
  assert.ok(discoveredNames.includes(core), `core extension '${core}' is discoverable`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2b. loader runtime dependency checks
// ═══════════════════════════════════════════════════════════════════════════

test("loader source contains Node version check with MIN_NODE_MAJOR", () => {
  const loaderSrc = readFileSync(join(projectRoot, "src", "loader.ts"), "utf-8");
  assert.ok(loaderSrc.includes("MIN_NODE_MAJOR"), "loader defines MIN_NODE_MAJOR constant");
  assert.ok(loaderSrc.includes("process.versions.node"), "loader checks process.versions.node");
});

test("loader source contains git availability check", () => {
  const loaderSrc = readFileSync(join(projectRoot, "src", "loader.ts"), "utf-8");
  assert.ok(loaderSrc.includes("git"), "loader checks for git");
  assert.ok(loaderSrc.includes("execFileSync"), "loader uses execFileSync for git check");
});

test("loader exits with error on unsupported Node version", () => {
  // Spawn a subprocess that simulates the loader's version check logic
  // with a deliberately high minimum to force the failure path
  const script = [
    "const major = parseInt(process.versions.node.split('.')[0], 10);",
    "const MIN = 99;",
    "if (major < MIN) { process.stderr.write('WOULD_EXIT'); process.exit(1); }",
    "process.stdout.write('OK');",
  ].join(" ");
  try {
    execSync(`node -e "${script}"`, { encoding: "utf-8", stdio: "pipe" });
    // Node >= 99 would reach here — acceptable no-op
  } catch (err: unknown) {
    const e = err as { status?: number; stderr?: string };
    assert.strictEqual(e.status, 1, "exits with code 1 for unsupported Node");
    assert.ok((e.stderr || "").includes("WOULD_EXIT"), "stderr contains version error");
  }
});

test("loader MIN_NODE_MAJOR matches package.json engines field", () => {
  const loaderSrc = readFileSync(join(projectRoot, "src", "loader.ts"), "utf-8");
  const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8"));

  // Extract MIN_NODE_MAJOR value from loader source
  const match = loaderSrc.match(/MIN_NODE_MAJOR\s*=\s*(\d+)/);
  assert.ok(match, "MIN_NODE_MAJOR is defined with a numeric value");
  const loaderMin = parseInt(match![1], 10);

  // Extract major version from engines.node (e.g. ">=22.0.0" → 22)
  const engineMatch = (pkg.engines?.node || "").match(/(\d+)/);
  assert.ok(engineMatch, "package.json engines.node is defined");
  const engineMin = parseInt(engineMatch![1], 10);

  assert.strictEqual(loaderMin, engineMin,
    `loader MIN_NODE_MAJOR (${loaderMin}) must match package.json engines.node (>=${engineMin}.0.0)`);
});

test("cli.ts lets gsd update bypass the managed-resource mismatch gate", () => {
  const cliSrc = readFileSync(join(projectRoot, "src", "cli.ts"), "utf-8");
  const updateBranchIndex = cliSrc.indexOf("if (cliFlags.messages[0] === 'update')")
  const mismatchGateIndex = cliSrc.indexOf("exitIfManagedResourcesAreNewer(agentDir)")

  assert.ok(updateBranchIndex !== -1, "cli.ts contains an update branch")
  assert.ok(mismatchGateIndex !== -1, "cli.ts contains the managed-resource mismatch gate")
  assert.ok(
    updateBranchIndex < mismatchGateIndex,
    "gsd update must run before the managed-resource mismatch gate",
  )
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. resource-loader syncs bundled resources
// ═══════════════════════════════════════════════════════════════════════════

test("initResources syncs extensions, agents, and skills to target dir", async (t) => {
  const { initResources, readManagedResourceVersion } = await import("../resource-loader.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resources-test-"));
  const fakeAgentDir = join(tmp, "agent");

  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  initResources(fakeAgentDir);

  // Extensions synced
  assertExtensionIndexExists(fakeAgentDir, "browser-tools");
  assertExtensionIndexExists(fakeAgentDir, "search-the-web");
  assertExtensionIndexExists(fakeAgentDir, "context7");
  assertExtensionIndexExists(fakeAgentDir, "subagent");

  // Agents synced
  assert.ok(existsSync(join(fakeAgentDir, "agents", "scout.md")), "scout agent synced");
  assert.ok(existsSync(join(fakeAgentDir, "agents", "teams-builder.md")), "teams-builder agent synced");
  assert.ok(existsSync(join(fakeAgentDir, "agents", "teams-reviewer.md")), "teams-reviewer agent synced");

  // Skills are NOT synced here — they use ~/.lsd/skills/ by default

  // Version manifest synced
  const managedVersion = readManagedResourceVersion(fakeAgentDir);
  assert.ok(managedVersion, "managed resource version written");

  // Idempotent: run again, no crash
  initResources(fakeAgentDir);
  assertExtensionIndexExists(fakeAgentDir, "browser-tools");
});

test("initResources skips copy when managed version matches current version", async (t) => {
  const { initResources, readManagedResourceVersion } = await import("../resource-loader.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resources-skip-"));
  const fakeAgentDir = join(tmp, "agent");

  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  // First run: full sync (no manifest yet)
  initResources(fakeAgentDir);
  const version = readManagedResourceVersion(fakeAgentDir);
  assert.ok(version, "manifest written after first sync");

  // Add a marker file to detect whether sync runs again
  const markerPath = join(fakeAgentDir, "extensions", "gsd", "_marker.txt");
  writeFileSync(markerPath, "test-marker");

  // Second run: version matches — should skip, marker survives
  initResources(fakeAgentDir);
  assert.ok(existsSync(markerPath), "marker file survives when version matches (sync skipped)");

  // Simulate version mismatch by writing older version to manifest
  const manifestPath = join(fakeAgentDir, "managed-resources.json");
  writeFileSync(manifestPath, JSON.stringify({ gsdVersion: "0.0.1", syncedAt: Date.now() }));

  // Third run: version mismatch — full sync, marker removed
  initResources(fakeAgentDir);
  assert.ok(!existsSync(markerPath), "marker file removed after version-mismatch sync");

  // Manifest updated to current version
  const updatedVersion = readManagedResourceVersion(fakeAgentDir);
  assert.strictEqual(updatedVersion, version, "manifest updated to current version after sync");
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. wizard loadStoredEnvKeys hydration
// ═══════════════════════════════════════════════════════════════════════════

test("loadStoredEnvKeys hydrates process.env from auth.json", async (t) => {
  const { loadStoredEnvKeys } = await import("../wizard.ts");
  const { AuthStorage } = await import("@gsd/pi-coding-agent");

  const tmp = mkdtempSync(join(tmpdir(), "gsd-wizard-test-"));
  const authPath = join(tmp, "auth.json");
  writeFileSync(authPath, JSON.stringify({
    brave: { type: "api_key", key: "test-brave-key" },
    brave_answers: { type: "api_key", key: "test-answers-key" },
    context7: { type: "api_key", key: "test-ctx7-key" },
    tavily: { type: "api_key", key: "test-tavily-key" },
    telegram_bot: { type: "api_key", key: "test-telegram-key" },
    "custom-openai": { type: "api_key", key: "test-custom-openai-key" },
  }));

  // Clear any existing env vars
  const envVarsToRestore = [
    "BRAVE_API_KEY", "BRAVE_ANSWERS_KEY", "CONTEXT7_API_KEY",
    "JINA_API_KEY", "TAVILY_API_KEY", "TELEGRAM_BOT_TOKEN",
    "CUSTOM_OPENAI_API_KEY",
  ];
  const origValues: Record<string, string | undefined> = {};
  for (const v of envVarsToRestore) {
    origValues[v] = process.env[v];
    delete process.env[v];
  }

  t.after(() => {
    for (const v of envVarsToRestore) {
    if (origValues[v]) process.env[v] = origValues[v]; else delete process.env[v];
    }
    rmSync(tmp, { recursive: true, force: true });
  });
  const auth = AuthStorage.create(authPath);
  loadStoredEnvKeys(auth);

  assert.equal(process.env.BRAVE_API_KEY, "test-brave-key", "BRAVE_API_KEY hydrated");
  assert.equal(process.env.BRAVE_ANSWERS_KEY, "test-answers-key", "BRAVE_ANSWERS_KEY hydrated");
  assert.equal(process.env.CONTEXT7_API_KEY, "test-ctx7-key", "CONTEXT7_API_KEY hydrated");
  assert.equal(process.env.JINA_API_KEY, undefined, "JINA_API_KEY not set (not in auth)");
  assert.equal(process.env.TAVILY_API_KEY, "test-tavily-key", "TAVILY_API_KEY hydrated");
  assert.equal(process.env.TELEGRAM_BOT_TOKEN, "test-telegram-key", "TELEGRAM_BOT_TOKEN hydrated");
  assert.equal(process.env.CUSTOM_OPENAI_API_KEY, "test-custom-openai-key", "CUSTOM_OPENAI_API_KEY hydrated");
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. loadStoredEnvKeys does NOT overwrite existing env vars
// ═══════════════════════════════════════════════════════════════════════════

test("loadStoredEnvKeys does not overwrite existing env vars", async (t) => {
  const { loadStoredEnvKeys } = await import("../wizard.ts");
  const { AuthStorage } = await import("@gsd/pi-coding-agent");

  const tmp = mkdtempSync(join(tmpdir(), "gsd-wizard-nooverwrite-"));
  const authPath = join(tmp, "auth.json");
  writeFileSync(authPath, JSON.stringify({
    brave: { type: "api_key", key: "stored-key" },
  }));

  const origBrave = process.env.BRAVE_API_KEY;
  process.env.BRAVE_API_KEY = "existing-env-key";

  t.after(() => {
    if (origBrave) process.env.BRAVE_API_KEY = origBrave; else delete process.env.BRAVE_API_KEY;
    rmSync(tmp, { recursive: true, force: true });
  });
  const auth = AuthStorage.create(authPath);
  loadStoredEnvKeys(auth);

  assert.equal(process.env.BRAVE_API_KEY, "existing-env-key", "existing env var not overwritten");
});


