import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { appRoot } from './app-paths.js'
import { resolveProjectStateRoot } from './shared-paths.js'

export type SearchProviderPreference = 'tavily' | 'brave' | 'ollama' | 'native' | 'auto'

export interface RemoteQuestionsConfig {
  channel?: 'slack' | 'discord' | 'telegram'
  channel_id?: string | number
  timeout_minutes?: number
  poll_interval_seconds?: number
}

export interface CmuxPreferences {
  enabled?: boolean
  notifications?: boolean
  sidebar?: boolean
  splits?: boolean
  browser?: boolean
}

export interface SharedPreferences {
  experimental?: {
    rtk?: boolean
  }
  remote_questions?: RemoteQuestionsConfig
  search_provider?: SearchProviderPreference
  cmux?: CmuxPreferences
}

export interface LoadedSharedPreferences {
  path: string
  scope: 'global' | 'project'
  preferences: SharedPreferences
}

function gsdCompatRoot(basePath: string): string {
  return resolveProjectStateRoot(basePath)
}

export function getGlobalPreferencesPath(): string {
  return join(appRoot, 'PREFERENCES.md')
}

export function getProjectPreferencesPath(basePath: string = process.cwd()): string {
  return join(gsdCompatRoot(basePath), 'PREFERENCES.md')
}

function getGlobalPreferenceCandidates(): string[] {
  return [
    join(appRoot, 'preferences.md'),
    join(appRoot, 'PREFERENCES.md'),
  ]
}

function getProjectPreferenceCandidates(basePath: string = process.cwd()): string[] {
  const root = gsdCompatRoot(basePath)
  return [
    join(root, 'preferences.md'),
    join(root, 'PREFERENCES.md'),
  ]
}

function parsePreferencesMarkdown(content: string): SharedPreferences | null {
  const startMarker = content.startsWith('---\r\n') ? '---\r\n' : '---\n'
  if (!content.startsWith(startMarker)) return null
  const endIdx = content.indexOf('\n---', startMarker.length)
  if (endIdx === -1) return null
  const block = content.slice(startMarker.length, endIdx).replace(/\r/g, '')
  try {
    const parsed = parseYaml(block)
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as SharedPreferences
  } catch {
    return {}
  }
}

function deepMerge<T>(base: T, override: T): T {
  if (Array.isArray(base) || Array.isArray(override)) return override
  if (!base || typeof base !== 'object') return override
  if (!override || typeof override !== 'object') return override
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    const current = result[key]
    if (
      current && value &&
      typeof current === 'object' && typeof value === 'object' &&
      !Array.isArray(current) && !Array.isArray(value)
    ) {
      result[key] = deepMerge(current as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      result[key] = value
    }
  }
  return result as T
}

function loadFromCandidates(candidates: string[], scope: 'global' | 'project'): LoadedSharedPreferences | null {
  for (const path of candidates) {
    if (!existsSync(path)) continue
    const raw = readFileSync(path, 'utf-8')
    const preferences = parsePreferencesMarkdown(raw)
    if (!preferences) continue
    return { path, scope, preferences }
  }
  return null
}

export function loadGlobalPreferences(): LoadedSharedPreferences | null {
  return loadFromCandidates(getGlobalPreferenceCandidates(), 'global')
}

export function loadProjectPreferences(basePath: string = process.cwd()): LoadedSharedPreferences | null {
  return loadFromCandidates(getProjectPreferenceCandidates(basePath), 'project')
}

export function loadEffectivePreferences(basePath: string = process.cwd()): LoadedSharedPreferences | null {
  const globalPrefs = loadGlobalPreferences()
  const projectPrefs = loadProjectPreferences(basePath)
  if (!globalPrefs && !projectPrefs) return null
  if (!globalPrefs) return projectPrefs
  if (!projectPrefs) return globalPrefs
  return {
    path: projectPrefs.path,
    scope: 'project',
    preferences: deepMerge(globalPrefs.preferences, projectPrefs.preferences),
  }
}

export function resolveSearchProviderFromPreferences(basePath: string = process.cwd()): SearchProviderPreference | undefined {
  return loadEffectivePreferences(basePath)?.preferences.search_provider
}
