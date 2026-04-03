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

function parseHex(hex: string): [number, number, number] | null {
  const raw = hex.trim().replace(/^#/, '')
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ]
}

function mixHex(baseHex: string, tintHex: string, tintWeight = 0.5): string {
  const base = parseHex(baseHex)
  const tint = parseHex(tintHex)
  if (!base || !tint) return baseHex

  const w = Math.min(1, Math.max(0, tintWeight))
  const mix = (a: number, b: number): number => Math.round(a * (1 - w) + b * w)
  const [r, g, b] = [mix(base[0], tint[0]), mix(base[1], tint[1]), mix(base[2], tint[2])]
  const toHex = (n: number): string => n.toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

export function printWelcomeScreen(opts: WelcomeScreenOptions): void {
  if (!process.stderr.isTTY) return

  const { version, modelName, provider } = opts
  const shortCwd = getShortCwd()
  const termWidth = Math.min((process.stderr.columns || 80) - 1, 200)

  // Narrow terminal fallback
  if (termWidth < 70) {
    process.stderr.write(`\n  Looks Sort of Done v${version}\n  ${shortCwd}\n\n`)
    return
  }

  // ── Theme-adaptive palette ───────────────────────────────────────────────
  // Keep welcome colors anchored to the active CLI theme accent so the banner
  // feels native regardless of custom themes.
  const ACCENT = accentHex()
  const LOGO_EDGE = chalk.hex(mixHex(ACCENT, '#111111', 0.55))
  const LOGO_CENTER = chalk.hex(mixHex(ACCENT, '#ffffff', 0.3))
  const TITLE_BASE = chalk.bold
  const TITLE_MARK = chalk.hex(mixHex(ACCENT, '#ffffff', 0.35)).bold
  const VERSION = chalk.dim
  const META = chalk.dim
  const TOOLS = chalk.dim

  // ── Panel widths ────────────────────────────────────────────────────────────
  // Layout: 1 leading space + LEFT_INNER logo content + 1 inner divider + RIGHT_INNER info
  // Total: 1 + LEFT_INNER + 1 + RIGHT_INNER = termWidth
  const LEFT_INNER = 34
  const RIGHT_INNER = termWidth - LEFT_INNER - 2 // 2 = leading space + inner divider

  // ── Bar/divider chars (matching GLYPH.separator + widget ui.bar() style) ────
  const H = '─'
  const DV = '│'
  const DS = '├'

  // ── Left rows: blank + 6 logo lines + blank (8 total) ───────────────────────
  const leftRows: (readonly [string, string, string] | null)[] = [null, ...GSD_LOGO_SEGMENTS, null]

  // ── Right rows (8 total, null = divider) ────────────────────────────────────
  const titleLeft = `  ${TITLE_MARK('L')}${TITLE_BASE('ooks Sort of ')}${TITLE_MARK('D')}${TITLE_BASE('one')}`
  const titleRight = VERSION(`v${version}`)
  const titleFill = RIGHT_INNER - visLen(titleLeft) - visLen(titleRight)
  const titleRow = titleLeft + ' '.repeat(Math.max(1, titleFill)) + titleRight

  const toolParts: string[] = []
  if (process.env.BRAVE_API_KEY) toolParts.push('Brave ✓')
  if (process.env.BRAVE_ANSWERS_KEY) toolParts.push('Answers ✓')
  if (process.env.JINA_API_KEY) toolParts.push('Jina ✓')
  if (process.env.TAVILY_API_KEY) toolParts.push('Tavily ✓')
  if (process.env.CONTEXT7_API_KEY) toolParts.push('Context7 ✓')

  // Tools summary row
  const toolsLeft = toolParts.length > 0 ? TOOLS('  ' + toolParts.join('  ·  ')) : ''
  const footerRow = rpad(toolsLeft, RIGHT_INNER)

  const DIVIDER = null
  const rightRows: (string | null)[] = [
    titleRow,
    DIVIDER,
    modelName ? `  Model      ${META(modelName)}` : '',
    provider ? `  Provider   ${META(provider)}` : '',
    `  Directory  ${META(shortCwd)}`,
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
          LOGO_EDGE(row[0]) + LOGO_CENTER(row[1]) + LOGO_EDGE(row[2]),
          LEFT_INNER,
        )
      : ' '.repeat(LEFT_INNER)
    const rRow = rightRows[i]

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
