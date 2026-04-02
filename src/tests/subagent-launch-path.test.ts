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

test('loader exports both legacy and rebranded bin path env vars', () => {
  const src = readFileSync(join(projectRoot, 'src', 'loader.ts'), 'utf-8')

  assert.ok(src.includes('process.env.GSD_BIN_PATH = process.argv[1]'), 'sets GSD_BIN_PATH')
  assert.ok(src.includes('process.env.LSD_BIN_PATH = process.argv[1]'), 'sets LSD_BIN_PATH')
  assert.ok(src.includes('process.env.GSD_BUNDLED_EXTENSION_PATHS = process.env.LSD_BUNDLED_EXTENSION_PATHS'), 'mirrors bundled extension env for legacy child processes')
})
