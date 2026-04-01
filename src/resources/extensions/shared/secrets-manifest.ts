import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveProjectStateRoot } from './paths.js'

export type SecretsManifestEntryStatus = 'pending' | 'collected' | 'skipped'

export interface SecretsManifestEntry {
  key: string
  service: string
  dashboardUrl: string
  guidance: string[]
  formatHint: string
  status: SecretsManifestEntryStatus
  destination: string
}

export interface SecretsManifest {
  milestone: string
  generatedAt: string
  entries: SecretsManifestEntry[]
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractBoldField(text: string, key: string): string | null {
  const regex = new RegExp(`^\\*\\*${escapeRegex(key)}:\\*\\*\\s*(.+)$`, 'm')
  const match = regex.exec(text)
  return match ? match[1].trim() : null
}

function extractAllSections(body: string, level = 3): Map<string, string> {
  const prefix = '#'.repeat(level) + ' '
  const regex = new RegExp(`^${prefix}(.+)$`, 'gm')
  const sections = new Map<string, string>()
  const matches = [...body.matchAll(regex)]
  for (let i = 0; i < matches.length; i++) {
    const heading = matches[i][1].trim()
    const start = matches[i].index! + matches[i][0].length
    const end = i + 1 < matches.length ? matches[i + 1].index! : body.length
    sections.set(heading, body.slice(start, end).trim())
  }
  return sections
}

const VALID_STATUSES = new Set<SecretsManifestEntryStatus>(['pending', 'collected', 'skipped'])

export function parseSecretsManifest(content: string): SecretsManifest {
  const milestone = extractBoldField(content, 'Milestone') || ''
  const generatedAt = extractBoldField(content, 'Generated') || ''
  const h3Sections = extractAllSections(content, 3)
  const entries: SecretsManifestEntry[] = []
  for (const [heading, sectionContent] of h3Sections) {
    const key = heading.trim()
    if (!key) continue
    const service = extractBoldField(sectionContent, 'Service') || ''
    const dashboardUrl = extractBoldField(sectionContent, 'Dashboard') || ''
    const formatHint = extractBoldField(sectionContent, 'Format hint') || ''
    const rawStatus = (extractBoldField(sectionContent, 'Status') || 'pending').toLowerCase().trim() as SecretsManifestEntryStatus
    const status = VALID_STATUSES.has(rawStatus) ? rawStatus : 'pending'
    const destination = extractBoldField(sectionContent, 'Destination') || 'dotenv'
    const guidance: string[] = []
    for (const line of sectionContent.split('\n')) {
      const numMatch = line.match(/^\s*\d+\.\s+(.+)/)
      if (numMatch) guidance.push(numMatch[1].trim())
    }
    entries.push({ key, service, dashboardUrl, guidance, formatHint, status, destination })
  }
  return { milestone, generatedAt, entries }
}

export function formatSecretsManifest(manifest: SecretsManifest): string {
  const lines: string[] = []
  lines.push('# Secrets Manifest')
  lines.push('')
  lines.push(`**Milestone:** ${manifest.milestone}`)
  lines.push(`**Generated:** ${manifest.generatedAt}`)
  for (const entry of manifest.entries) {
    lines.push('')
    lines.push(`### ${entry.key}`)
    lines.push('')
    lines.push(`**Service:** ${entry.service}`)
    if (entry.dashboardUrl) lines.push(`**Dashboard:** ${entry.dashboardUrl}`)
    if (entry.formatHint) lines.push(`**Format hint:** ${entry.formatHint}`)
    lines.push(`**Status:** ${entry.status}`)
    lines.push(`**Destination:** ${entry.destination}`)
    lines.push('')
    for (let i = 0; i < entry.guidance.length; i++) lines.push(`${i + 1}. ${entry.guidance[i]}`)
  }
  return lines.join('\n') + '\n'
}

export function resolveMilestoneFile(basePath: string, milestoneId: string, suffix: string): string | null {
  const root = resolveProjectStateRoot(basePath)
  const milestonesDir = join(root, 'milestones')
  if (!existsSync(milestonesDir)) return null
  const directDir = join(milestonesDir, milestoneId)
  const candidateDirs = existsSync(directDir) ? [milestoneId] : []
  if (candidateDirs.length === 0) {
    try {
      for (const name of readdirSync(milestonesDir, { withFileTypes: true })) {
        if (name.isDirectory() && name.name.startsWith(milestoneId)) candidateDirs.push(name.name)
      }
    } catch {}
  }
  const dirName = candidateDirs[0]
  if (!dirName) return null
  const dir = join(milestonesDir, dirName)
  const directFile = join(dir, `${milestoneId}-${suffix}.md`)
  if (existsSync(directFile)) return directFile
  try {
    const file = readdirSync(dir).find((name: string) => name.startsWith(`${milestoneId}-`) && name.endsWith(`-${suffix}.md`))
    return file ? join(dir, file) : null
  } catch {
    return null
  }
}

export async function loadSecretsManifestFile(basePath: string, milestoneId: string): Promise<{ path: string; manifest: SecretsManifest } | null> {
  const path = resolveMilestoneFile(basePath, milestoneId, 'SECRETS')
  if (!path) return null
  const content = await readFile(path, 'utf8')
  return { path, manifest: parseSecretsManifest(content) }
}

export async function saveSecretsManifestFile(path: string, manifest: SecretsManifest): Promise<void> {
  await writeFile(path, formatSecretsManifest(manifest), 'utf8')
}
