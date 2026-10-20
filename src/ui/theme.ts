import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@earendil-works/pi-tui'
import type { Config } from '../config.js'

/** Semantic ANSI roles owned by the terminal front door. */
export interface Palette {
  readonly plain: boolean
  readonly dim: (text: string) => string
  readonly bold: (text: string) => string
  readonly italic: (text: string) => string
  readonly underline: (text: string) => string
  readonly accent: (text: string) => string
  readonly brand: (text: string) => string
  readonly success: (text: string) => string
  readonly warning: (text: string) => string
  readonly error: (text: string) => string
  readonly userBand: (text: string) => string
  readonly toolBand: (text: string) => string
  readonly thinkingBand: (text: string) => string
  readonly dialogBand: (text: string) => string
  readonly dialogBorder: (text: string) => string
  /** Color one reasoning-effort label and the matching divider lines. */
  readonly reasoning: (effort: string | undefined) => (text: string) => string
  /** Color one preset id. */
  readonly preset: (text: string) => string
  /** Color the context-meter head by occupancy and the compaction trigger. */
  readonly context: (percent: number | undefined, triggerPercent?: number) => (text: string) => string
}

const identity = (text: string): string => text

function sgr(open: string, close: string): (text: string) => string {
  return (text) => `\u001B[${open}m${text}\u001B[${close}m`
}

/**
 * Build the 16-color palette. The terminal owns the actual colors, so the
 * same roles stay readable on light and dark backgrounds.
 * @param theme - configured palette mode.
 * @returns semantic styling functions.
 */
export function createPalette(theme: Config['theme']): Palette {
  if (theme === 'plain') {
    return {
      plain: true,
      dim: identity,
      bold: identity,
      italic: identity,
      underline: identity,
      accent: identity,
      brand: identity,
      success: identity,
      warning: identity,
      error: identity,
      userBand: identity,
      toolBand: identity,
      thinkingBand: identity,
      dialogBand: identity,
      dialogBorder: identity,
      reasoning: () => identity,
      preset: identity,
      context: () => identity,
    }
  }
  // Tool cards use a neutral surface instead of a saturated state color: the
  // card already carries success/error in its label, and a full-width green
  // band dominates the transcript (dark) or washes it out (light).
  const bands = theme === 'light'
    ? { user: '48;5;195', tool: '48;5;253', thinking: '48;5;254' }
    : { user: '48;5;23', tool: '48;5;237', thinking: '48;5;235' }
  const dim = sgr('2', '22')
  // 256-color values stay readable on both surfaces: the light palette uses
  // deeper blue/pink/red where the dark palette can afford brighter hues.
  const reasoningCodes: Record<string, string> = theme === 'light'
    ? { low: '38;5;28', medium: '38;5;25', high: '38;5;162', max: '38;5;160' }
    : { low: '38;5;28', medium: '38;5;117', high: '38;5;211', max: '38;5;196' }
  const reasoning = (effort: string | undefined): ((text: string) => string) => {
    const code = reasoningCodes[String(effort ?? '').toLowerCase()]
    return code === undefined ? dim : sgr(code, '39')
  }
  const warning = sgr('33', '39')
  const error = sgr('31', '39')
  // A calm footer until the context meter approaches the automatic compaction
  // point: normal occupancy stays dim, the last 20 points before the trigger
  // turn to warning, and the trigger itself turns to error. The meter owns the
  // numbers; the default trigger only covers a composition that omits it.
  const context = (percent: number | undefined, triggerPercent?: number): ((text: string) => string) => {
    if (percent === undefined) return dim
    const trigger = triggerPercent !== undefined && Number.isFinite(triggerPercent) && triggerPercent > 0
      ? triggerPercent
      : 80
    if (percent >= trigger) return error
    if (percent >= Math.max(0, trigger - 20)) return warning
    return dim
  }
  return {
    plain: false,
    dim,
    bold: sgr('1', '22'),
    italic: sgr('3', '23'),
    underline: sgr('4', '24'),
    accent: sgr('36', '39'),
    brand: sgr('34', '39'),
    success: sgr('32', '39'),
    warning,
    error,
    userBand: sgr(bands.user, '49'),
    toolBand: sgr(bands.tool, '49'),
    thinkingBand: sgr(bands.thinking, '49'),
    dialogBand: sgr(theme === 'light' ? '48;5;255' : '48;5;236', '49'),
    dialogBorder: sgr(theme === 'light' ? '38;5;24' : '38;5;39', '39'),
    reasoning,
    preset: sgr(theme === 'light' ? '38;5;91' : '38;5;141', '39'),
    context,
  }
}

/** Markdown theme backed by the terminal palette. */
export function markdownTheme(palette: Palette): MarkdownTheme {
  return {
    heading: text => palette.bold(palette.accent(text)),
    link: text => palette.underline(palette.accent(text)),
    linkUrl: text => palette.dim(text),
    code: text => palette.accent(text),
    codeBlock: text => palette.dim(text),
    codeBlockBorder: text => palette.dim(text),
    quote: text => palette.dim(text),
    quoteBorder: text => palette.dim(text),
    hr: text => palette.dim(text),
    listBullet: text => palette.accent(text),
    bold: text => palette.bold(text),
    italic: text => palette.italic(text),
    strikethrough: text => palette.dim(text),
    underline: text => palette.underline(text),
  }
}

/** Selection-list theme for modal pickers. */
export function selectTheme(palette: Palette): SelectListTheme {
  return {
    selectedPrefix: text => palette.accent(text),
    selectedText: text => palette.bold(palette.accent(text)),
    description: text => palette.dim(text),
    scrollInfo: text => palette.dim(text),
    noMatch: text => palette.dim(text),
  }
}

/**
 * Editor chrome theme. The border color follows the current reasoning effort;
 * the caller passes a getter so a model/effort change repaints the same editor.
 * @param palette - colours.
 * @param reasoningEffort - current effort, read at border-paint time.
 * @returns the pi-tui editor theme.
 */
export function editorTheme(palette: Palette, reasoningEffort: () => string | undefined = () => undefined): EditorTheme {
  return {
    borderColor: text => palette.reasoning(reasoningEffort())(text),
    selectList: selectTheme(palette),
  }
}
