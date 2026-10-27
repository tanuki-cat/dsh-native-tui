/**
 * Skill listing vocabulary, shared by `/skill` and the `/` completion menu.
 *
 * The Host catalog (`ctx.skills`) is invocation-neutral: it reports both
 * controls and the discovery root that produced each winning skill, and leaves
 * every consumer to decide what it may offer. This module owns the terminal's
 * reading of that data — which skills a list shows, how each row states its
 * invocation flags and provenance, and how the table is paged and clipped.
 *
 * Kept free of Host and TUI dependencies so the wording is testable directly.
 *
 * @module dsh-native-tui/runtime/skill-catalog
 */

import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

/** One catalog entry as the Host reports it. */
export interface SkillSummaryLike {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  /** Absolute instruction file path; absent for virtual skills. */
  readonly path?: string
  readonly invocation?: { readonly modelInvocable?: boolean; readonly userInvocable?: boolean }
  /** Discovery root that produced this winning skill, e.g. `user-agents`. */
  readonly source?: string
  /** Provider that owns the body; a packaged provider names its package. */
  readonly provider?: string
}

/** One skill as the terminal lists it. */
export interface SkillRow {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly path?: string
  readonly userInvocable: boolean
  readonly modelInvocable: boolean
  /** Where the skill came from, already reduced to a short label. */
  readonly provenance: string
}

/**
 * Reduce a discovery root and its provider to the one label a row shows.
 *
 * `source` is the documented "which root won" answer, so it carries the list by
 * default. A packaged provider is the exception: its root is the generic
 * `bundled`, while the provider names the package that actually owns the body,
 * which is the fact a reader needs — the same distinction the Web and pi
 * surfaces draw when they label a skill with its package.
 * @param source - discovery root reported by the Host.
 * @param provider - provider that owns the skill body.
 * @returns a short, non-empty provenance label.
 */
export function skillProvenance(source: string | undefined, provider: string | undefined): string {
  const root = typeof source === 'string' && source !== '' ? source : undefined
  const owner = typeof provider === 'string' && provider !== '' ? provider : undefined
  if (root === undefined) return owner ?? 'unknown'
  // `filesystem` is the default provider for the project and user roots, so
  // naming it would only repeat what the root already said.
  if (root === 'bundled' && owner !== undefined && owner !== 'filesystem') return owner
  return root
}

/**
 * State one row's invocation controls and provenance as `[u:user-agents]`.
 *
 * Both flags are listed when both are allowed: a skill the model can also call
 * is a different thing to review than one only a human may invoke, and hiding
 * that behind a single letter would make the list read as if every row were the
 * same kind of tool.
 * @param row - the flags and provenance to state.
 * @returns the badge text, always bracketed.
 */
export function skillBadge(row: Pick<SkillRow, 'userInvocable' | 'modelInvocable' | 'provenance'>): string {
  const flags = row.userInvocable && row.modelInvocable
    ? 'u,m'
    : row.userInvocable ? 'u' : row.modelInvocable ? 'm' : '-'
  return '[' + flags + ':' + row.provenance + ']'
}

/**
 * Normalize Host summaries into list rows, sorted by name.
 * @param summaries - catalog entries from `ctx.skills.list()`.
 * @returns one row per skill, in the order the list prints them.
 */
export function skillRows(summaries: readonly SkillSummaryLike[]): readonly SkillRow[] {
  return summaries
    .map(summary => ({
      name: summary.name,
      description: summary.description,
      ...(summary.whenToUse === undefined ? {} : { whenToUse: summary.whenToUse }),
      ...(summary.path === undefined ? {} : { path: summary.path }),
      // An omitted invocation policy permits both surfaces, matching the Host's
      // `isUserInvocable`/`isModelInvocable` defaults.
      userInvocable: summary.invocation?.userInvocable !== false,
      modelInvocable: summary.invocation?.modelInvocable !== false,
      provenance: skillProvenance(summary.source, summary.provider),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

/** Header figures: how many skills exist and how they may be invoked. */
export interface SkillCounts {
  readonly total: number
  readonly user: number
  readonly modelOnly: number
}

/**
 * Count a list the way its header sentence states it.
 * @param rows - rows being listed.
 * @returns totals, with `modelOnly` excluding anything a human may invoke.
 */
export function skillCounts(rows: readonly SkillRow[]): SkillCounts {
  return {
    total: rows.length,
    user: rows.filter(row => row.userInvocable).length,
    modelOnly: rows.filter(row => !row.userInvocable && row.modelInvocable).length,
  }
}

/** One page of the rendered table plus the paging state a footer needs. */
export interface SkillPage {
  readonly lines: readonly string[]
  /** 1-based page number, clamped into range. */
  readonly page: number
  /** Total pages; at least 1 so a footer never divides by zero. */
  readonly pages: number
  readonly total: number
}

/** Narrowest description column worth printing; below this the table stacks badly. */
const MIN_DESCRIPTION_WIDTH = 16

/** Cells reserved for the gap between the name and badge columns. */
const COLUMN_GAP = '  '

/**
 * Render one page of the skill table.
 *
 * The description takes whatever the name and badge columns leave, so a wide
 * terminal shows more of it instead of leaving a ragged right edge, and a narrow
 * one sacrifices the description rather than the identity of the row. Truncation
 * goes through `truncateToWidth`, which keeps wide characters and escapes from
 * breaking the column arithmetic.
 * @param rows - rows to page, already sorted.
 * @param options - terminal width, 1-based page, and rows per page.
 * @returns that page's lines plus the paging state.
 */
export function skillPage(
  rows: readonly SkillRow[],
  options: { readonly width: number; readonly page?: number; readonly pageSize?: number },
): SkillPage {
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? 15))
  const total = rows.length
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const requested = Number.isFinite(options.page ?? 1) ? Math.floor(options.page ?? 1) : 1
  const page = Math.min(Math.max(1, requested), pages)
  const slice = rows.slice((page - 1) * pageSize, page * pageSize)
  const badges = slice.map(row => skillBadge(row))
  const nameWidth = Math.max(0, ...slice.map(row => visibleWidth(row.name)))
  const badgeWidth = Math.max(0, ...badges.map(badge => visibleWidth(badge)))
  const used = nameWidth + COLUMN_GAP.length + badgeWidth + COLUMN_GAP.length
  const descriptionWidth = Math.max(0, options.width - used)
  const lines = slice.map((row, index) => {
    const name = row.name + ' '.repeat(Math.max(0, nameWidth - visibleWidth(row.name)))
    const badge = (badges[index] ?? '') + ' '.repeat(Math.max(0, badgeWidth - visibleWidth(badges[index] ?? '')))
    // A table too narrow for a usable description keeps the identity columns and
    // drops the prose, rather than wrapping it into an unreadable column.
    if (descriptionWidth < MIN_DESCRIPTION_WIDTH) return (name + COLUMN_GAP + badge).trimEnd()
    return name + COLUMN_GAP + badge + COLUMN_GAP + truncateToWidth(row.description, descriptionWidth, '…')
  })
  return { lines, page, pages, total }
}
