/**
 * `/skill`: find a skill, invoke it, or read what it says.
 *
 * Both directions of the skill surface live here. Invocation goes through the
 * prompt editor rather than straight to the agent: the completion menu already
 * inserts a name to be sent, and staging keeps that contract — `/skill` prepares
 * the call, the user adds their own instructions, and one Enter sends it. Browsing
 * stays read-only because the two questions a reader has ("what can I call?" and
 * "what does the model see?") should not fire a request when they are answered.
 *
 * @module dsh-native-tui/ui/commands/skills
 */

import {
  skillBadge,
  skillCounts,
  skillPage,
  skillRows,
  type SkillRow,
} from '../../runtime/skill-catalog.js'
import { showMarkdownPreview, showSearchChoice, showTextPager } from '../dialogs.js'
import type { CommandContext } from './context.js'
import type { SkillsCatalog } from './services.js'
import { NL, errorMessage, terminalColumns } from './shared.js'

/** Rows per `/skill list` page; matches the density of the other paged notices. */
export const SKILLS_PER_PAGE = 15

/**
 * The skill registry for the session on screen.
 *
 * Agent presets mount their own skill plugins, so the agent-scoped service wins;
 * the composition-wide one is the fallback for profiles without a preset layer.
 * `ctx.get` is read defensively because the Cordis proxy throws for a service a
 * context did not inject.
 * @param ctx - command context.
 * @returns the registry, or undefined when no skill plugin is mounted.
 */
export function skillRegistry(ctx: CommandContext): SkillsCatalog | undefined {
  try {
    const scoped = ctx.active.agent.ctx.get('skills') as SkillsCatalog | undefined
    if (scoped !== undefined) return scoped
  }
  catch {
    // Fall through to the composition-wide registry.
  }
  return ctx.host.get('skills') as SkillsCatalog | undefined
}

/**
 * Read every skill the session can see.
 * @param ctx - command context.
 * @returns sorted rows, or an error message when discovery failed.
 */
export async function readSkillRows(ctx: CommandContext): Promise<{ readonly rows: readonly SkillRow[] } | { readonly error: string }> {
  const registry = skillRegistry(ctx)
  if (registry === undefined) return { error: 'The skill service is unavailable in this profile.' }
  try {
    const summaries = await registry.list({
      cwd: ctx.active.agent.session.header.cwd ?? ctx.config.cwd,
      scope: ctx.active.agent,
      signal: ctx.signal,
    })
    return { rows: skillRows(summaries) }
  }
  catch (error) {
    return { error: 'Could not list skills: ' + errorMessage(error) }
  }
}

/**
 * Render one page of the list as a notice body.
 *
 * The header states the invocation split before the rows, because the count is
 * what tells a reader whether paging through 120 entries is worth it, and the
 * split is the part a reviewer actually needs: how many of these can the model
 * call on its own.
 * @param rows - all rows, already sorted.
 * @param options - terminal width and 1-based page.
 * @returns the notice body.
 */
export function skillsReport(
  rows: readonly SkillRow[],
  options: { readonly width: number; readonly page?: number; readonly pageSize?: number },
): string {
  const counts = skillCounts(rows)
  const page = skillPage(rows, options)
  const summary = String(counts.total) + ' skill' + (counts.total === 1 ? '' : 's')
    + ' · ' + String(counts.user) + ' user-invocable'
    + (counts.modelOnly === 0 ? '' : ' · ' + String(counts.modelOnly) + ' model-only')
  if (page.total === 0) return 'No skills are registered for this session.'
  const paging = page.pages > 1
    ? 'page ' + String(page.page) + '/' + String(page.pages)
      + (page.page < page.pages ? ' · /skill list ' + String(page.page + 1) : '')
    : undefined
  return [
    summary + (paging === undefined ? '' : ' · ' + paging),
    ...page.lines,
    '',
    'Use /skill to pick one to invoke, or /skill read <name> to read one.',
  ].join(NL)
}

/**
 * Show one skill: its metadata, then its instruction body.
 * @param ctx - command context.
 * @param row - the skill to show.
 */
async function readSkill(ctx: CommandContext, row: SkillRow): Promise<void> {
  const registry = skillRegistry(ctx)
  let content: string | undefined
  if (registry?.get !== undefined) {
    try {
      const loaded = await registry.get(row.name, {
        cwd: ctx.active.agent.session.header.cwd ?? ctx.config.cwd,
        scope: ctx.active.agent,
        signal: ctx.signal,
      })
      content = loaded?.content
    }
    catch (error) {
      ctx.notice('error', 'Could not load skill "' + row.name + '": ' + errorMessage(error))
      return
    }
  }
  const details = [
    row.name + '  ' + skillBadge(row),
    row.description,
    ...(row.whenToUse === undefined ? [] : ['When to use: ' + row.whenToUse]),
    ...(row.path === undefined ? [] : ['Path: ' + row.path]),
    ...(row.userInvocable ? ['Invoke with /skill:' + row.name] : []),
  ].join(NL)
  if (content === undefined || content.trim() === '') {
    // Without a body the metadata is still worth showing, so the command does
    // not fail just because a provider declined to load.
    await showTextPager(ctx.tui, ctx.palette, 'Skill · ' + row.name, details, ctx.signal)
    return
  }
  await showMarkdownPreview(ctx.tui, ctx.palette, row.name, details + NL + NL + content, ctx.signal)
}

/**
 * Stage an invocation and say what happened.
 *
 * The editor visibly changes, but a transcript line makes the effect explicit
 * for anyone who looked away from the prompt while the picker was open.
 * @param ctx - command context.
 * @param row - the skill to invoke.
 */
function stage(ctx: CommandContext, row: SkillRow): void {
  ctx.stageSkillInvocation(row.name)
  ctx.notice('info', 'Skill /skill:' + row.name + ' added to the prompt · Enter sends it, or add your own instructions first.')
}

/** The `/skill` command. */
export async function skillCommand(ctx: CommandContext, args: string): Promise<void> {
  const trimmed = args.trim()
  const requested = await readSkillRows(ctx)
  if ('error' in requested) {
    ctx.notice('warning', requested.error)
    return
  }
  const rows = requested.rows
  if (rows.length === 0) {
    ctx.notice('info', 'No skills are registered for this session.')
    return
  }
  if (trimmed === '') {
    // Only an invocable skill is offered here: a model-only skill cannot be
    // invoked by a human, so listing it in an invocation picker would promise
    // something the Host rejects. Reviewing those stays in `/skill list`.
    const invocable = rows.filter(row => row.userInvocable)
    if (invocable.length === 0) {
      ctx.notice('warning', 'No user-invocable skills are registered. Use /skill list to review them.')
      return
    }
    const choice = await showSearchChoice(
      ctx.tui,
      ctx.palette,
      'Invoke a skill · ' + String(invocable.length) + ' available',
      invocable.map(row => ({
        value: row.name,
        label: row.name,
        description: skillBadge(row) + '  ' + row.description,
      })),
      'Type to filter · Enter stages the call · Esc cancels',
      ctx.signal,
    )
    if (choice === undefined) return
    const chosen = invocable.find(row => row.name === choice)
    if (chosen !== undefined) stage(ctx, chosen)
    return
  }
  if (trimmed === 'list' || trimmed.startsWith('list ')) {
    const pageText = trimmed.slice('list'.length).trim()
    const page = pageText === '' ? 1 : Number(pageText)
    if (!Number.isSafeInteger(page) || page < 1) {
      ctx.notice('warning', 'Usage: /skill [list [page] | read <name> | <name>]')
      return
    }
    ctx.notice('info', skillsReport(rows, { width: terminalColumns(ctx) - 4, page, pageSize: SKILLS_PER_PAGE }))
    return
  }
  if (trimmed.startsWith('read ')) {
    const name = trimmed.slice('read'.length).trim()
    const target = rows.find(row => row.name === name)
    if (target === undefined) {
      ctx.notice('warning', 'No skill named "' + name + '". Use /skill list to browse.')
      return
    }
    await readSkill(ctx, target)
    return
  }
  const target = rows.find(row => row.name === trimmed)
  if (target === undefined) {
    ctx.notice('warning', 'No skill named "' + trimmed + '". Use /skill to search.')
    return
  }
  if (!target.userInvocable) {
    // The Host refuses a model-only skill at the injection boundary, so say why
    // here instead of staging a call that would be rejected on send.
    ctx.notice('warning', 'Skill "' + target.name + '" is model-only (no user invocation). Use /skill read ' + target.name + ' to read it.')
    return
  }
  stage(ctx, target)
}
