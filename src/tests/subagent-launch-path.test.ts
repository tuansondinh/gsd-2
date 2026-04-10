import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(fileURLToPath(import.meta.url), '..', '..', '..')

test('subagent launch resolves CLI path via env, argv, cwd fallbacks, and PATH', () => {
  const src = readFileSync(join(projectRoot, 'src', 'resources', 'extensions', 'subagent', 'index.ts'), 'utf-8')

  assert.ok(src.includes('function resolveSubagentCliPath'), 'has explicit CLI path resolver')
  assert.ok(src.includes('process.env.GSD_BIN_PATH'), 'checks GSD_BIN_PATH')
  assert.ok(src.includes('process.env.LSD_BIN_PATH'), 'checks LSD_BIN_PATH')
  assert.ok(src.includes('process.argv[1]'), 'checks argv[1] fallback')
  assert.ok(src.includes('path.join(defaultCwd, "dist", "loader.js")'), 'checks built local loader fallback')
  assert.ok(src.includes('path.join(defaultCwd, "scripts", "dev-cli.js")'), 'checks local dev CLI fallback')
  assert.ok(src.includes('execFileSync("which", [binName]'), 'checks PATH fallback via which')
})

test('subagent launch keeps stdin open for approval proxy responses', () => {
  const src = readFileSync(join(projectRoot, 'src', 'resources', 'extensions', 'subagent', 'index.ts'), 'utf-8')

  assert.ok(src.includes('stdio: ["pipe", "pipe", "pipe"]'), 'launches child with piped stdin/stdout/stderr')
  assert.ok(!src.includes('proc.stdin.end()'), 'does not close child stdin before approval responses can be written')
})

test('subagent print-mode sessions use project session directory so /agent can switch to them', () => {
  const src = readFileSync(join(projectRoot, 'src', 'cli.ts'), 'utf-8')

  assert.ok(src.includes('const printSessionsDir = getProjectSessionsDir(printCwd)'), 'print mode derives project session directory')
  assert.ok(src.includes('SessionManager.create(printCwd, printSessionsDir)'), 'print mode persists sessions into the project session dir')
})

test('subagent launch passes parent session metadata to attachable child sessions', () => {
  const launchSrc = readFileSync(join(projectRoot, 'src', 'resources', 'extensions', 'subagent', 'launch-helpers.ts'), 'utf-8')
  const cliSrc = readFileSync(join(projectRoot, 'src', 'cli.ts'), 'utf-8')

  assert.ok(launchSrc.includes('args.push("--parent-session", options.parentSessionFile)'), 'launch args include --parent-session when provided')
  assert.ok(launchSrc.includes('args.push("--subagent-name", agent.name)'), 'launch args include subagent name metadata')
  assert.ok(launchSrc.includes('args.push("--subagent-task", task)'), 'launch args include subagent task metadata')
  assert.ok(launchSrc.includes('args.push("--subagent-system-prompt-file", tmpPromptPath)'), 'launch args include persistent subagent prompt metadata')
  assert.ok(launchSrc.includes('const mode = options?.mode ?? "json"'), 'launch helper supports selectable process mode')
  assert.ok(launchSrc.includes('if (mode === "json") args.push("-p")'), 'print prompt flag is only used in json mode')
  assert.ok(cliSrc.includes("} else if (arg === '--parent-session' && i + 1 < args.length) {"), 'cli parses --parent-session')
  assert.ok(cliSrc.includes("} else if (arg === '--subagent-name' && i + 1 < args.length) {"), 'cli parses --subagent-name')
  assert.ok(cliSrc.includes("} else if (arg === '--subagent-system-prompt-file' && i + 1 < args.length) {"), 'cli parses --subagent-system-prompt-file')
  assert.ok(cliSrc.includes('subagentName: cliFlags.subagentName,'), 'print mode persists subagent name in child session header')
  assert.ok(cliSrc.includes('subagentSystemPrompt,'), 'print mode persists subagent system prompt in child session header')
})

test('loader exports both legacy and rebranded bin path env vars', () => {
  const src = readFileSync(join(projectRoot, 'src', 'loader.ts'), 'utf-8')

  assert.ok(src.includes('process.env.GSD_BIN_PATH = process.argv[1]'), 'sets GSD_BIN_PATH')
  assert.ok(src.includes('process.env.LSD_BIN_PATH = process.argv[1]'), 'sets LSD_BIN_PATH')
  assert.ok(src.includes('process.env.GSD_BUNDLED_EXTENSION_PATHS = process.env.LSD_BUNDLED_EXTENSION_PATHS'), 'mirrors bundled extension env for legacy child processes')
})
