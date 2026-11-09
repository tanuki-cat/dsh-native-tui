import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@earendil-works/pi-tui'
import type { Config } from '../config.js'
import type { ProviderReasoningLevel } from '../runtime/providers.js'

/**
 * Colours for every selectable reasoning level.
 *
 * Typed as a full record rather than a partial map so adding a level to
 * {@link ProviderReasoningLevel} without giving it a colour fails to compile
 * instead of silently rendering in the dim default.
 */
type ReasoningCodes = Record<ProviderReasoningLevel, string>

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
  readonly diffAddBand: (text: string) => string
  readonly diffRemoveBand: (text: string) => string
  readonly dialogBand: (text: string) => string
  readonly dialogBorder: (text: string) => string
  /** Color one reasoning-effort label and the matching divider lines. */
  readonly reasoning: (effort: string | undefined) => (text: string) => string
  /** Color one preset id. */
  readonly preset: (text: string) => string
  /** Color the context-meter head by occupancy and the compaction trigger. */
  readonly context: (percent: number | undefined, triggerPercent?: number) => (text: string) => string
  /**
   * Color one composition bucket, keyed by the same names the Web meter's panel
   * uses: system prompt grey, tool definitions purple, messages blue. Keeping the
   * three distinct matters more than the exact hues, because the bar and its
   * legend pair by color in the terminal as they do on the Web.
   */
  readonly contextBucket: (bucket: 'system' | 'tools' | 'messages') => (text: string) => string
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
      diffAddBand: identity,
      diffRemoveBand: identity,
      dialogBand: identity,
      dialogBorder: identity,
      reasoning: () => identity,
      preset: identity,
      context: () => identity,
      contextBucket: () => identity,
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
  // Every level in PROVIDER_REASONING_LEVELS needs an entry: a missing one
  // silently falls back to dim, which reads as "this level has no colour".
  const reasoningCodes: ReasoningCodes = theme === 'light'
    ? {
        off: '38;5;243',
        minimal: '38;5;30',
        low: '38;5;28',
        medium: '38;5;25',
        high: '38;5;162',
        xhigh: '38;5;161',
        max: '38;5;160',
      }
    : {
        off: '38;5;245',
        minimal: '38;5;37',
        low: '38;5;28',
        medium: '38;5;117',
        high: '38;5;211',
        xhigh: '38;5;212',
        max: '38;5;196',
      }
  const reasoning = (effort: string | undefined): ((text: string) => string) => {
    // The effort arrives as a wire label, so look it up as a plain string and
    // fall back to dim for anything the ladder does not define.
    const key = String(effort ?? '').toLowerCase() as ProviderReasoningLevel
    const code = Object.hasOwn(reasoningCodes, key) ? reasoningCodes[key] : undefined
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
  // The Web meter tints its three legend rows with grey-blue, #a78bfa, and
  // blue-450. The terminal has no static brand palette, so these are the closest
  // 256-colour sits: a neutral grey, the same violet family as /preset, and the
  // accent blue. All three stay separable on light and dark backgrounds.
  const bucketCodes: Record<'system' | 'tools' | 'messages', string> = theme === 'light'
    ? { system: '38;5;243', tools: '38;5;98', messages: '38;5;25' }
    : { system: '38;5;245', tools: '38;5;141', messages: '38;5;39' }
  const contextBucket = (bucket: 'system' | 'tools' | 'messages'): ((text: string) => string) =>
    sgr(bucketCodes[bucket], '39')
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
    diffAddBand: sgr(theme === 'light' ? '48;5;194' : '48;5;22', '49'),
    diffRemoveBand: sgr(theme === 'light' ? '48;5;224' : '48;5;52', '49'),
    dialogBand: sgr(theme === 'light' ? '48;5;255' : '48;5;236', '49'),
    dialogBorder: sgr(theme === 'light' ? '38;5;24' : '38;5;39', '39'),
    reasoning,
    preset: sgr(theme === 'light' ? '38;5;91' : '38;5;141', '39'),
    context,
    contextBucket,
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
