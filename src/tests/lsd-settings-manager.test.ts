import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { createLsdSettingsManager } = await import('../lsd-settings-manager.ts')

test('createLsdSettingsManager reads defaults from provided LSD agent dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'lsd-settings-manager-'))
  const cwd = join(root, 'workspace')
  const lsdAgentDir = join(root, '.lsd', 'agent')

  mkdirSync(cwd, { recursive: true })
  mkdirSync(lsdAgentDir, { recursive: true })

  writeFileSync(
    join(lsdAgentDir, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'anthropic',
      defaultModel: 'claude-sonnet-4-6',
      budgetSubagentModel: 'anthropic/claude-haiku-4-5',
    }),
    'utf8',
  )

  try {
    const settingsManager = createLsdSettingsManager(cwd, lsdAgentDir)

    assert.equal(settingsManager.getDefaultProvider(), 'anthropic')
    assert.equal(settingsManager.getDefaultModel(), 'claude-sonnet-4-6')
    assert.equal(settingsManager.getBudgetSubagentModel(), 'anthropic/claude-haiku-4-5')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
