import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentDir } from './app-paths.js'
import { loadEffectivePreferences } from './shared-preferences.js'
import { resolveProjectStateRoot } from './shared-paths.js'

interface CodexRotateSettingsFile {
  codexRotate?: boolean
}

function readSettingsFile(path: string): CodexRotateSettingsFile | null {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as CodexRotateSettingsFile
  } catch {
    return null
  }
}

export function isCodexRotateEnabled(basePath: string = process.cwd()): boolean {
  const projectSettings = readSettingsFile(join(resolveProjectStateRoot(basePath), 'settings.json'))
  if (projectSettings?.codexRotate !== undefined) return projectSettings.codexRotate

  const globalSettings = readSettingsFile(join(agentDir, 'settings.json'))
  if (globalSettings?.codexRotate !== undefined) return globalSettings.codexRotate

  return loadEffectivePreferences(basePath)?.preferences.experimental?.codex_rotate === true
}
