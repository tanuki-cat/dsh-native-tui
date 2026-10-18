/**
 * `/files`, `/changes`, and `/deliverables`.
 *
 * @module dsh-native-tui/ui/commands/artifacts
 */

import { dirname, resolve } from 'node:path'
import { formatChangesSummary, formatWorkspaceDiff } from '../../runtime/changes.js'
import { collectDeliverables, formatDeliverables, type PresentedFileView } from '../../runtime/deliverables.js'
import { listDirectory, readTextPreview } from '../../runtime/files.js'
import { revealWithSystemApp, systemRevealCommand } from '../../runtime/open.js'
import { showChoice } from '../dialogs.js'
import type { CommandContext } from './context.js'
import type { WorkspaceChangesService } from './services.js'
import { NL, errorMessage } from './shared.js'

/** The `/files` browser. */
export async function filesCommand(ctx: CommandContext, args: string): Promise<void> {
  let current = resolve(ctx.config.cwd, args === '' ? '.' : args)
  for (;;) {
    let entries: Awaited<ReturnType<typeof listDirectory>>
    try {
      entries = await listDirectory(current)
    }
    catch (error) {
      ctx.notice('error', 'Could not list ' + current + ': ' + errorMessage(error))
      return
    }
    const parent = dirname(current)
    const items = [
      ...(parent === current ? [] : [{ value: '__parent__', label: '../', description: 'parent directory' }]),
      ...entries.map(entry => ({
        value: entry.path,
        label: entry.kind === 'directory' ? entry.name + '/' : entry.name,
        description: entry.kind,
      })),
    ]
    if (items.length === 0) {
      ctx.notice('info', 'Directory is empty: ' + current)
      return
    }
    const picked = await showChoice(ctx.tui, ctx.palette, 'Files · ' + current, items, 'Enter opens · Esc exits', ctx.signal)
    if (picked === undefined)
      return
    if (picked === '__parent__') {
      current = parent
      continue
    }
    const entry = entries.find(candidate => candidate.path === picked)
    if (entry === undefined)
      return
    if (entry.kind === 'directory') {
      current = entry.path
      continue
    }
    try {
      const preview = await readTextPreview(entry.path)
      ctx.notice('info', 'File: ' + preview.path + ' (' + String(preview.bytes) + ' bytes'
        + (preview.truncated ? ', truncated' : '') + ')' + NL + preview.text)
    }
    catch (error) {
      ctx.notice('error', 'Could not open ' + entry.path + ': ' + errorMessage(error))
    }
    return
  }
}

/** The `/changes` command. */
export async function changesCommand(ctx: CommandContext, args: string): Promise<void> {
  const changes = ctx.host.get('workspaceChanges') as WorkspaceChangesService | undefined
  if (changes === undefined) {
    ctx.notice('warning', 'The workspace-changes service is unavailable in this profile.')
    return
  }
  const latest = ctx.active.agent.session.snapshotEvents()
    .filter(event => (event.type as string) === 'workspace/changes')
    .at(-1) as unknown as { readonly seq: number } | undefined
  if (latest === undefined) {
    ctx.notice('info', 'No workspace-change summary recorded for this session yet.')
    return
  }
  const seq = Number(latest.seq)
  if (args.startsWith('diff ')) {
    const index = Number(args.slice('diff '.length).trim())
    if (!Number.isSafeInteger(index) || index < 0) {
      ctx.notice('warning', 'Usage: /changes diff <file-index>')
      return
    }
    try {
      const diff = await changes.diff(ctx.active.id, seq, index, ctx.signal)
      if (diff === undefined) {
        ctx.notice('warning', 'No comparison is available for file ' + String(index) + '.')
        return
      }
      ctx.notice('info', formatWorkspaceDiff(diff))
    }
    catch (error) {
      ctx.notice('error', 'Could not read the file diff: ' + errorMessage(error))
    }
    return
  }
  const summary = changes.summary(ctx.active.id, seq)
  if (summary === undefined) {
    ctx.notice('warning', 'The latest change summary is no longer available in this process.')
    return
  }
  ctx.notice('info', formatChangesSummary(summary) + NL + 'Use /changes diff <index> for one file.')
}

/** The `/deliverables` command. */
export async function deliverablesCommand(ctx: CommandContext, args: string): Promise<void> {
  const events = ctx.active.agent.session.snapshotEvents()
    .filter(event => (event.type as string) === 'deliverables/presented')
    .map(event => event.data as { readonly turn: number; readonly files: readonly PresentedFileView[] })
  if (events.length === 0) {
    ctx.notice('info', 'No presented deliverables in this session yet.')
    return
  }
  if (args === 'panel') {
    const rows = collectDeliverables(events)
    const picked = await showChoice(ctx.tui, ctx.palette, 'Deliverables', rows.map((row, index) => ({
      value: String(index),
      label: String(index) + '. ' + row.path,
      description: (row.description ?? 'turn ' + String(row.turn)),
    })), 'Enter selects · Esc closes', ctx.signal)
    if (picked === undefined)
      return
    const index = Number(picked)
    const target = rows[index]
    if (target === undefined)
      return
    const action = await showChoice(ctx.tui, ctx.palette, 'Deliverable · ' + target.path, [
      { value: 'open', label: 'Preview', description: 'Render text or Markdown in the transcript/overlay' },
      { value: 'reveal', label: 'Reveal', description: 'Open the system file manager at this file' },
      { value: 'back', label: 'Back' },
    ], 'Enter selects · Esc closes', ctx.signal)
    if (action === 'open') {
      await ctx.runCommand('/deliverables open ' + String(index))
    }
    else if (action === 'reveal') {
      await ctx.runCommand('/deliverables reveal ' + String(index))
    }
    return
  }
  if (args.startsWith('reveal ')) {
    const index = Number(args.slice('reveal '.length).trim())
    if (!Number.isSafeInteger(index) || index < 0) {
      ctx.notice('warning', 'Usage: /deliverables reveal <index>')
      return
    }
    const target = collectDeliverables(events)[index]
    if (target === undefined) {
      ctx.notice('warning', 'No presented deliverable at index ' + String(index) + '.')
      return
    }
    if (systemRevealCommand(process.platform, target.path) === undefined) {
      ctx.notice('warning', 'Revealing files is unsupported on this platform.')
      return
    }
    const confirmed = await showChoice(ctx.tui, ctx.palette, 'Reveal ' + target.path + '?', [
      { value: 'yes', label: 'Continue', description: 'Open the system file manager at this path' },
      { value: 'no', label: 'Cancel' },
    ], 'Enter selects · Esc cancels', ctx.signal)
    if (confirmed !== 'yes')
      return
    if (revealWithSystemApp(target.path))
      ctx.notice('info', 'Revealed ' + target.path + ' in the system file manager.')
    else
      ctx.notice('error', 'Could not launch the system file manager for ' + target.path + '.')
    return
  }
  if (args.startsWith('open ')) {
    const index = Number(args.slice('open '.length).trim())
    if (!Number.isSafeInteger(index) || index < 0) {
      ctx.notice('warning', 'Usage: /deliverables open <index>')
      return
    }
    const target = collectDeliverables(events)[index]
    if (target === undefined) {
      ctx.notice('warning', 'No presented deliverable at index ' + String(index) + '.')
      return
    }
    try {
      const preview = await readTextPreview(target.path)
      ctx.notice('info', 'File: ' + preview.path + ' (' + String(preview.bytes) + ' bytes'
        + (preview.truncated ? ', truncated' : '') + ')' + NL + preview.text)
    }
    catch (error) {
      ctx.notice('error', 'Could not open ' + target.path + ': ' + errorMessage(error))
    }
    return
  }
  ctx.notice('info', formatDeliverables(events))
}
