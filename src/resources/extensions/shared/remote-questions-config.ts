import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { getGlobalPreferencesPath } from './preferences.js'

export function saveRemoteQuestionsConfig(channel: 'slack' | 'discord' | 'telegram', channelId: string): void {
  const prefsPath = getGlobalPreferencesPath()
  const block = [
    'remote_questions:',
    `  channel: ${channel}`,
    `  channel_id: "${channelId}"`,
    '  timeout_minutes: 5',
    '  poll_interval_seconds: 5',
  ].join('\n')

  const content = existsSync(prefsPath) ? readFileSync(prefsPath, 'utf-8') : ''
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  let next = content

  if (fmMatch) {
    let frontmatter = fmMatch[1]
    const regex = /remote_questions:[\s\S]*?(?=\n[a-zA-Z_]|\n---|$)/
    frontmatter = regex.test(frontmatter) ? frontmatter.replace(regex, block) : `${frontmatter.trimEnd()}\n${block}`
    next = `---\n${frontmatter}\n---${content.slice(fmMatch[0].length)}`
  } else {
    next = `---\n${block}\n---\n\n${content}`
  }

  mkdirSync(dirname(prefsPath), { recursive: true })
  writeFileSync(prefsPath, next, 'utf-8')
}
