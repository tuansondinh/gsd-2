/**
 * Worktree CLI — standalone subcommand and -w flag handling.
 *
 * Maintains lightweight git-worktree support without relying on the removed
 * bundled legacy planning extension runtime.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import chalk from 'chalk'
import { accentHex } from './cli-theme.js'
import { generateWorktreeName } from './worktree-name-gen.js'
import { resolveProjectStateRoot } from './shared-paths.js'

interface WorktreeInfo {
  name: string
  path: string
  branch: string
}

interface DiffSummary {
  added: string[]
  modified: string[]
  removed: string[]
}

interface NumstatSummary {
  added: number
  removed: number
}

interface WorktreeStatus {
  name: string
  path: string
  branch: string
  exists: boolean
  filesChanged: number
  linesAdded: number
  linesRemoved: number
  uncommitted: boolean
  commits: number
}

function git(basePath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: basePath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function gitSafe(basePath: string, args: string[]): string {
  try {
    return git(basePath, args)
  } catch {
    return ''
  }
}

function worktreeRoot(basePath: string): string {
  return join(resolveProjectStateRoot(basePath), 'worktrees')
}

function worktreeBranchName(name: string): string {
  return `wt/${name}`
}

function worktreePath(basePath: string, name: string): string {
  return join(worktreeRoot(basePath), name)
}

function ensureWorktreeRoot(basePath: string): void {
  mkdirSync(worktreeRoot(basePath), { recursive: true })
}

function nativeDetectMainBranch(basePath: string): string {
  for (const branch of ['main', 'master']) {
    try {
      git(basePath, ['rev-parse', '--verify', branch])
      return branch
    } catch { /* continue */ }
  }

  const remoteHead = gitSafe(basePath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (remoteHead.startsWith('origin/')) {
    return remoteHead.slice('origin/'.length)
  }

  const current = gitSafe(basePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return current || 'main'
}

function inferCommitType(name: string): string {
  const lower = name.toLowerCase()
  if (/(fix|bug|hotfix|patch)/.test(lower)) return 'fix'
  if (/(docs|readme)/.test(lower)) return 'docs'
  if (/(refactor|cleanup)/.test(lower)) return 'refactor'
  if (/(test|spec)/.test(lower)) return 'test'
  if (/(chore|deps|bump|infra)/.test(lower)) return 'chore'
  return 'feat'
}

function createWorktree(basePath: string, name: string): { path: string; branch: string } {
  ensureWorktreeRoot(basePath)
  const path = worktreePath(basePath, name)
  const branch = worktreeBranchName(name)

  if (existsSync(path)) {
    return { path, branch }
  }

  const mainBranch = nativeDetectMainBranch(basePath)
  git(basePath, ['worktree', 'add', '-b', branch, path, mainBranch])
  return { path, branch }
}

function listWorktrees(basePath: string): WorktreeInfo[] {
  const root = worktreeRoot(basePath)
  if (!existsSync(root)) return []

  return readdirSync(root)
    .map((name) => ({ name, path: join(root, name) }))
    .filter((entry) => {
      try {
        return statSync(entry.path).isDirectory()
      } catch {
        return false
      }
    })
    .map((entry) => ({
      name: entry.name,
      path: entry.path,
      branch: gitSafe(entry.path, ['rev-parse', '--abbrev-ref', 'HEAD']) || worktreeBranchName(entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function removeWorktree(basePath: string, name: string, opts?: { deleteBranch?: boolean }): void {
  const path = worktreePath(basePath, name)
  git(basePath, ['worktree', 'remove', '--force', path])
  if (opts?.deleteBranch) {
    try {
      git(basePath, ['branch', '-D', worktreeBranchName(name)])
    } catch { /* ignore */ }
  }
}

function diffWorktreeAll(basePath: string, name: string): DiffSummary {
  const branch = worktreeBranchName(name)
  const mainBranch = nativeDetectMainBranch(basePath)
  const output = gitSafe(basePath, ['diff', '--name-status', `${mainBranch}...${branch}`])
  const summary: DiffSummary = { added: [], modified: [], removed: [] }

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [status, ...rest] = line.split(/\t+/)
    const file = rest[rest.length - 1]
    if (!file) continue
    if (status.startsWith('A')) summary.added.push(file)
    else if (status.startsWith('D')) summary.removed.push(file)
    else summary.modified.push(file)
  }

  return summary
}

function diffWorktreeNumstat(basePath: string, name: string): NumstatSummary[] {
  const branch = worktreeBranchName(name)
  const mainBranch = nativeDetectMainBranch(basePath)
  const output = gitSafe(basePath, ['diff', '--numstat', `${mainBranch}...${branch}`])

  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [added, removed] = line.split(/\t+/)
      return {
        added: Number.parseInt(added, 10) || 0,
        removed: Number.parseInt(removed, 10) || 0,
      }
    })
}

function nativeHasChanges(path: string): boolean {
  return gitSafe(path, ['status', '--porcelain']).trim().length > 0
}

function nativeCommitCountBetween(basePath: string, from: string, to: string): number {
  return Number.parseInt(gitSafe(basePath, ['rev-list', '--count', `${from}..${to}`]), 10) || 0
}

function runWorktreePostCreateHook(_basePath: string, _wtPath: string): string | null {
  return null
}

function autoCommitCurrentBranch(wtPath: string, _reason: string, name: string): void {
  if (!nativeHasChanges(wtPath)) return
  git(wtPath, ['add', '-A'])
  git(wtPath, ['commit', '-m', `chore: checkpoint worktree ${name}`])
}

function mergeWorktreeToMain(basePath: string, name: string, commitMessage: string): void {
  const branch = worktreeBranchName(name)
  git(basePath, ['merge', '--squash', branch])
  git(basePath, ['commit', '-m', commitMessage])
}

function getWorktreeStatus(basePath: string, name: string, wtPath: string): WorktreeStatus {
  const diff = diffWorktreeAll(basePath, name)
  const numstat = diffWorktreeNumstat(basePath, name)
  const filesChanged = diff.added.length + diff.modified.length + diff.removed.length
  let linesAdded = 0
  let linesRemoved = 0
  for (const s of numstat) {
    linesAdded += s.added
    linesRemoved += s.removed
  }

  let uncommitted = false
  try { uncommitted = existsSync(wtPath) && nativeHasChanges(wtPath) } catch { /* */ }

  let commits = 0
  try {
    const mainBranch = nativeDetectMainBranch(basePath)
    commits = nativeCommitCountBetween(basePath, mainBranch, worktreeBranchName(name))
  } catch { /* */ }

  return {
    name,
    path: wtPath,
    branch: worktreeBranchName(name),
    exists: existsSync(wtPath),
    filesChanged,
    linesAdded,
    linesRemoved,
    uncommitted,
    commits,
  }
}

function formatStatus(s: WorktreeStatus): string {
  const lines: string[] = []
  const badge = s.uncommitted
    ? chalk.yellow(' (uncommitted)')
    : s.filesChanged > 0
      ? chalk.hex(accentHex())(' (unmerged)')
      : chalk.green(' (clean)')

  lines.push(`  ${chalk.bold.hex(accentHex())(s.name)}${badge}`)
  lines.push(`    ${chalk.dim('branch')}  ${chalk.magenta(s.branch)}`)
  lines.push(`    ${chalk.dim('path')}    ${chalk.dim(s.path)}`)

  if (s.filesChanged > 0) {
    lines.push(`    ${chalk.dim('diff')}    ${s.filesChanged} files, ${chalk.green(`+${s.linesAdded}`)} ${chalk.red(`-${s.linesRemoved}`)}, ${s.commits} commit${s.commits === 1 ? '' : 's'}`)
  }

  return lines.join('\n')
}

async function handleList(basePath: string): Promise<void> {
  const worktrees = listWorktrees(basePath)

  if (worktrees.length === 0) {
    process.stderr.write(chalk.dim('No worktrees. Create one with: lsd -w <name>\n'))
    return
  }

  process.stderr.write(chalk.bold('\nWorktrees\n\n'))
  for (const wt of worktrees) {
    const status = getWorktreeStatus(basePath, wt.name, wt.path)
    process.stderr.write(formatStatus(status) + '\n\n')
  }
}

async function handleMerge(basePath: string, args: string[]): Promise<void> {
  const name = args[0]
  if (!name) {
    const worktrees = listWorktrees(basePath)
    if (worktrees.length === 1) {
      await doMerge(basePath, worktrees[0].name)
      return
    }
    process.stderr.write(chalk.red('Usage: lsd worktree merge <name>\n'))
    process.stderr.write(chalk.dim('Run lsd worktree list to see worktrees.\n'))
    process.exit(1)
  }
  await doMerge(basePath, name)
}

async function doMerge(basePath: string, name: string): Promise<void> {
  const worktrees = listWorktrees(basePath)
  const wt = worktrees.find(w => w.name === name)
  if (!wt) {
    process.stderr.write(chalk.red(`Worktree "${name}" not found.\n`))
    process.exit(1)
  }

  const status = getWorktreeStatus(basePath, name, wt.path)
  if (status.filesChanged === 0 && !status.uncommitted) {
    process.stderr.write(chalk.dim(`Worktree "${name}" has no changes to merge.\n`))
    removeWorktree(basePath, name, { deleteBranch: true })
    process.stderr.write(chalk.green(`Removed empty worktree ${chalk.bold(name)}.\n`))
    return
  }

  if (status.uncommitted) {
    try {
      autoCommitCurrentBranch(wt.path, 'worktree-merge', name)
      process.stderr.write(chalk.dim('  Auto-committed dirty work before merge.\n'))
    } catch { /* best-effort */ }
  }

  const commitType = inferCommitType(name)
  const commitMessage = `${commitType}: merge worktree ${name}\n\nLSD-Worktree: ${name}`

  process.stderr.write(`\nMerging ${chalk.bold.cyan(name)} → ${chalk.magenta(nativeDetectMainBranch(basePath))}\n`)
  process.stderr.write(chalk.dim(`  ${status.filesChanged} files, ${chalk.green(`+${status.linesAdded}`)} ${chalk.red(`-${status.linesRemoved}`)}\n\n`))

  try {
    mergeWorktreeToMain(basePath, name, commitMessage)
    removeWorktree(basePath, name, { deleteBranch: true })
    process.stderr.write(chalk.green(`✓ Merged and cleaned up ${chalk.bold(name)}\n`))
    process.stderr.write(chalk.dim(`  commit: ${commitMessage}\n`))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(chalk.red(`✗ Merge failed: ${msg}\n`))
    process.stderr.write(chalk.dim('  Resolve conflicts manually, then run lsd worktree merge again.\n'))
    process.exit(1)
  }
}

async function handleClean(basePath: string): Promise<void> {
  const worktrees = listWorktrees(basePath)
  if (worktrees.length === 0) {
    process.stderr.write(chalk.dim('No worktrees to clean.\n'))
    return
  }

  let cleaned = 0
  for (const wt of worktrees) {
    const status = getWorktreeStatus(basePath, wt.name, wt.path)
    if (status.filesChanged === 0 && !status.uncommitted) {
      try {
        removeWorktree(basePath, wt.name, { deleteBranch: true })
        process.stderr.write(chalk.green(`  ✓ Removed ${chalk.bold(wt.name)} (clean)\n`))
        cleaned++
      } catch {
        process.stderr.write(chalk.yellow(`  ✗ Failed to remove ${wt.name}\n`))
      }
    } else {
      process.stderr.write(chalk.dim(`  ─ Kept ${chalk.bold(wt.name)} (${status.filesChanged} changed files)\n`))
    }
  }

  process.stderr.write(chalk.dim(`\nCleaned ${cleaned} worktree${cleaned === 1 ? '' : 's'}.\n`))
}

async function handleRemove(basePath: string, args: string[]): Promise<void> {
  const name = args[0]
  if (!name) {
    process.stderr.write(chalk.red('Usage: lsd worktree remove <name>\n'))
    process.exit(1)
  }

  const worktrees = listWorktrees(basePath)
  const wt = worktrees.find(w => w.name === name)
  if (!wt) {
    process.stderr.write(chalk.red(`Worktree "${name}" not found.\n`))
    process.exit(1)
  }

  const status = getWorktreeStatus(basePath, name, wt.path)
  if (status.filesChanged > 0 || status.uncommitted) {
    process.stderr.write(chalk.yellow(`⚠ Worktree "${name}" has unmerged changes (${status.filesChanged} files).\n`))
    process.stderr.write(chalk.yellow('  Use --force to remove anyway, or merge first: lsd worktree merge ' + name + '\n'))
    if (!process.argv.includes('--force')) {
      process.exit(1)
    }
  }

  removeWorktree(basePath, name, { deleteBranch: true })
  process.stderr.write(chalk.green(`✓ Removed worktree ${chalk.bold(name)}\n`))
}

async function handleStatusBanner(basePath: string): Promise<void> {
  const worktrees = listWorktrees(basePath)
  if (worktrees.length === 0) return

  const withChanges = worktrees.filter(wt => {
    try {
      const diff = diffWorktreeAll(basePath, wt.name)
      return diff.added.length + diff.modified.length + diff.removed.length > 0
    } catch {
      return false
    }
  })

  if (withChanges.length === 0) return

  const names = withChanges.map(w => chalk.hex(accentHex())(w.name)).join(', ')
  process.stderr.write(
    chalk.dim('[lsd] ') +
    chalk.yellow(`${withChanges.length} worktree${withChanges.length === 1 ? '' : 's'} with unmerged changes: `) +
    names + '\n' +
    chalk.dim('[lsd] ') +
    chalk.dim('Resume: lsd -w <name>  |  Merge: lsd worktree merge <name>  |  List: lsd worktree list\n\n'),
  )
}

async function handleWorktreeFlag(worktreeFlag: boolean | string): Promise<void> {
  const basePath = process.cwd()

  if (worktreeFlag === true) {
    const existing = listWorktrees(basePath)
    const withChanges = existing.filter(wt => {
      try {
        const diff = diffWorktreeAll(basePath, wt.name)
        return diff.added.length + diff.modified.length + diff.removed.length > 0
      } catch {
        return false
      }
    })

    if (withChanges.length === 1) {
      const wt = withChanges[0]
      process.chdir(wt.path)
      process.env.GSD_CLI_WORKTREE = wt.name
      process.env.GSD_CLI_WORKTREE_BASE = basePath
      process.stderr.write(chalk.green(`✓ Resumed worktree ${chalk.bold(wt.name)}\n`))
      process.stderr.write(chalk.dim(`  path   ${wt.path}\n`))
      process.stderr.write(chalk.dim(`  branch ${wt.branch}\n\n`))
      return
    }

    if (withChanges.length > 1) {
      process.stderr.write(chalk.yellow(`${withChanges.length} worktrees have unmerged changes:\n\n`))
      for (const wt of withChanges) {
        const status = getWorktreeStatus(basePath, wt.name, wt.path)
        process.stderr.write(formatStatus(status) + '\n\n')
      }
      process.stderr.write(chalk.dim('Specify which one: lsd -w <name>\n'))
      process.exit(0)
    }

    await createAndEnter(basePath, generateWorktreeName())
    return
  }

  const name = worktreeFlag as string
  const existing = listWorktrees(basePath)
  const found = existing.find(wt => wt.name === name)

  if (found) {
    process.chdir(found.path)
    process.env.GSD_CLI_WORKTREE = name
    process.env.GSD_CLI_WORKTREE_BASE = basePath
    process.stderr.write(chalk.green(`✓ Resumed worktree ${chalk.bold(name)}\n`))
    process.stderr.write(chalk.dim(`  path   ${found.path}\n`))
    process.stderr.write(chalk.dim(`  branch ${found.branch}\n\n`))
  } else {
    await createAndEnter(basePath, name)
  }
}

async function createAndEnter(basePath: string, name: string): Promise<void> {
  try {
    const info = createWorktree(basePath, name)
    const hookError = runWorktreePostCreateHook(basePath, info.path)
    if (hookError) {
      process.stderr.write(chalk.yellow(`[lsd] ${hookError}\n`))
    }

    process.chdir(info.path)
    process.env.GSD_CLI_WORKTREE = name
    process.env.GSD_CLI_WORKTREE_BASE = basePath
    process.stderr.write(chalk.green(`✓ Created worktree ${chalk.bold(name)}\n`))
    process.stderr.write(chalk.dim(`  path   ${info.path}\n`))
    process.stderr.write(chalk.dim(`  branch ${info.branch}\n\n`))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(chalk.red(`[lsd] Failed to create worktree: ${msg}\n`))
    process.exit(1)
  }
}

export {
  handleList,
  handleMerge,
  handleClean,
  handleRemove,
  handleStatusBanner,
  handleWorktreeFlag,
  getWorktreeStatus,
}
