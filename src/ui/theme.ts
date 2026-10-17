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
    }
  }
  return {
    plain: false,
    dim: sgr('2', '22'),
    bold: sgr('1', '22'),
    italic: sgr('3', '23'),
    underline: sgr('4', '24'),
    accent: sgr('36', '39'),
    brand: sgr('34', '39'),
    success: sgr('32', '39'),
    warning: sgr('33', '39'),
    error: sgr('31', '39'),
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

/** Editor chrome theme. */
export function editorTheme(palette: Palette): EditorTheme {
  return {
    borderColor: text => palette.dim(text),
    selectList: selectTheme(palette),
  }
}
