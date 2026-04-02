/**
 * GSD Welcome Screen
 *
 * Two-panel bar layout: full-width accent bars at top/bottom (matching the
 * auto-mode progress widget style), logo left (fixed width), info right.
 * Falls back to simple text on narrow terminals (<70 cols) or non-TTY.
 */

import os from 'node:os'
import chalk from 'chalk'
import { GSD_LOGO_SEGMENTS } from './logo.js'
import { brandNameChalk, LSD_BLUE, LSD_PINK, LSD_YELLOW } from './lsd-brand.js'
import { accentHex } from './cli-theme.js'


export interface WelcomeScreenOptions {
  version: string
  modelName?: string
  provider?: string
}

function getShortCwd(): string {
  const cwd = process.cwd()
  const home = os.homedir()
  return cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd
}

/** Visible length — strips ANSI escape codes before measuring. */
function visLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length
}

/** Right-pad a string to the given visible width. */
function rpad(s: string, w: number): string {
  return s + ' '.repeat(Math.max(0, w - visLen(s)))
}

export function printWelcomeScreen(opts: WelcomeScreenOptions): void {
  if (!process.stderr.isTTY) return

  const { version, modelName, provider } = opts
  const shortCwd = getShortCwd()
  const termWidth = Math.min((process.stderr.columns || 80) - 1, 200)

  // Narrow terminal fallback
  if (termWidth < 70) {
    process.stderr.write(`\n  Lucent Software Developer v${version}\n  ${shortCwd}\n\n`)
    return
  }

  // ── LSD vibrant colors ───────────────────────────────────────────────────
  const YELLOW = LSD_YELLOW
  const BLUE = LSD_BLUE
  const PINK = LSD_PINK
  const ACCENT = accentHex()

  // ── Panel widths ────────────────────────────────────────────────────────────
  // Layout: 1 leading space + LEFT_INNER logo content + 1 inner divider + RIGHT_INNER info
  // Total: 1 + LEFT_INNER + 1 + RIGHT_INNER = termWidth
  const LEFT_INNER = 34
  const RIGHT_INNER = termWidth - LEFT_INNER - 2  // 2 = leading space + inner divider

  // ── Bar/divider chars (matching GLYPH.separator + widget ui.bar() style) ────
  const H = '─', DV = '│', DS = '├'

  // ── Left rows: blank + 6 logo lines + blank (8 total) ───────────────────────
  const leftRows: (readonly [string, string, string] | null)[] = [null, ...GSD_LOGO_SEGMENTS, null]

  // ── Right rows (8 total, null = divider) ────────────────────────────────────
  const titleLeft  = `  ${brandNameChalk()}`
  const titleRight = chalk.hex(YELLOW)(`v${version}`)
  const titleFill  = RIGHT_INNER - visLen(titleLeft) - visLen(titleRight)
  const titleRow   = titleLeft + ' '.repeat(Math.max(1, titleFill)) + titleRight

  const toolParts: string[] = []
  if (process.env.BRAVE_API_KEY)      toolParts.push('Brave ✓')
  if (process.env.BRAVE_ANSWERS_KEY)  toolParts.push('Answers ✓')
  if (process.env.JINA_API_KEY)       toolParts.push('Jina ✓')
  if (process.env.TAVILY_API_KEY)     toolParts.push('Tavily ✓')
  if (process.env.CONTEXT7_API_KEY)   toolParts.push('Context7 ✓')

  // Tools summary row
  const toolsLeft  = toolParts.length > 0 ? chalk.hex(PINK)('  ' + toolParts.join('  ·  ')) : ''
  const footerRow  = rpad(toolsLeft, RIGHT_INNER)

  const DIVIDER = null
  const rightRows: (string | null)[] = [
    titleRow,
    DIVIDER,
    modelName ? `  Model      ${chalk.hex(ACCENT)(modelName)}`  : '',
    provider  ? `  Provider   ${chalk.hex(ACCENT)(provider)}`   : '',
    `  Directory  ${chalk.hex(ACCENT)(shortCwd)}`,
    DIVIDER,
    footerRow,
    '',
  ]

  // ── Render ──────────────────────────────────────────────────────────────────
  const out: string[] = ['']

  // Top bar — full-width accent separator
  out.push(chalk.hex(ACCENT)(H.repeat(termWidth)))

  for (let i = 0; i < 8; i++) {
    const row = leftRows[i]
    const lContent = row
      ? rpad(
          chalk.hex(YELLOW)(row[0]) + chalk.hex(BLUE)(row[1]) + chalk.hex(PINK)(row[2]),
          LEFT_INNER,
        )
      : ' '.repeat(LEFT_INNER)
    const rRow     = rightRows[i]

    if (rRow === null) {
      // Section divider: left logo area + accent ├────... extending right
      out.push(' ' + lContent + chalk.hex(ACCENT)(DS + H.repeat(RIGHT_INNER)))
    } else {
      // Content row: 1 space + logo │ info (no outer vertical borders)
      out.push(' ' + lContent + chalk.hex(ACCENT)(DV) + rpad(rRow, RIGHT_INNER))
    }
  }

  // Bottom bar — full-width accent separator
  out.push(chalk.hex(ACCENT)(H.repeat(termWidth)))
  out.push('')

  process.stderr.write(out.join('\n') + '\n')
}
