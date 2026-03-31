/**
 * CLI theme — single source of truth for accent colors used across all CLI
 * output (welcome screen, sessions list, worktree CLI, update prompt, onboarding).
 *
 * Colors are read lazily from active theme via getResolvedThemeColors() so
 * that custom user themes propagate to CLI output automatically.
 * Falls back to built-in dark-theme defaults if the theme cannot be loaded.
 */

import { getResolvedThemeColors } from '@gsd/pi-coding-agent'

// ── Lazy theme cache ─────────────────────────────────────────────────────────

let _colors: Record<string, string> | null = null

function colors(): Record<string, string> {
  if (!_colors) {
    try {
      const resolved = getResolvedThemeColors()
      _colors = resolved ?? { accent: '#c85520', borderAccent: '#c85520', borderMuted: '#502810' }
    } catch {
      // Theme not yet on disk (first run) — use built-in dark defaults
      _colors = { accent: '#c85520', borderAccent: '#c85520', borderMuted: '#502810' }
    }
  }
  return _colors
}

// ── Hex accessor (for chalk.hex()) ───────────────────────────────────────────

/** Returns a accent hex color from the active theme (e.g. `'#c85520'`). */
export function accentHex(): string {
  return colors().accent ?? '#c85520'
}

// ── ANSI helpers (for non-chalk contexts: picocolors, renderLogo) ────────────

/** Wrap text in the theme's accent color using raw ANSI 24-bit escapes. */
export const accentAnsi = (s: string): string => {
  const hex = accentHex().replace('#', '')
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`
}
