/**
 * Syntax highlighting shared by cards that show source text (`write` and the
 * code-execution tools). Kept separate from the cards so the highlight theme
 * and the path/extension mapping live in one place.
 *
 * @module dsh-native-tui/ui/code-preview
 */

import { basename, extname } from 'node:path'
import { highlight, supportsLanguage } from 'cli-highlight'
import type { Palette } from './theme.js'

/** Extensions whose highlight.js name differs from the file extension. */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', tsx: 'typescript',
  zsh: 'bash', ps1: 'powershell', h: 'c', hpp: 'cpp',
}

/**
 * Map a file path to a highlight.js language id.
 * @param path - display path of the file, when the card knows it.
 * @returns the language id, or undefined without a path.
 */
export function languageForPath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  const extension = extname(path).slice(1).toLowerCase() || basename(path).toLowerCase()
  return LANGUAGE_ALIASES[extension] ?? extension
}

/**
 * Highlight source text for a language.
 *
 * Plain palettes and languages highlight.js does not know keep the source
 * unchanged, so a card never fails because of its language mapping.
 * @param source - literal source text.
 * @param language - highlight.js language id.
 * @param palette - active palette, which also decides whether to color at all.
 * @returns the source with ANSI colors, byte-for-byte when highlighting is off.
 */
export function highlightCode(source: string, language: string | undefined, palette: Palette): string {
  if (palette.plain || language === undefined) return source
  if (!supportsLanguage(language)) return source
  try {
    return highlight(source, { language, ignoreIllegals: true, theme: {
      keyword: palette.accent, built_in: palette.accent, type: palette.accent,
      string: palette.success, number: palette.warning, literal: palette.warning,
      comment: palette.dim, default: text => text,
    } })
  }
  catch { return source }
}
