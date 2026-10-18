/**
 * `/preset`, `/export`, `/open`, and `/preview`.
 *
 * @module dsh-native-tui/ui/commands/workspace-files
 */

import { resolve } from 'node:path'
import { exportSessionBundle } from '../../runtime/bundle.js'
import { exportSessionHtml } from '../../runtime/html.js'
import { exportSessionLog } from '../../runtime/export.js'
import { isMarkdownPath, readTextPreview } from '../../runtime/files.js'
import { readImagePreview } from '../../runtime/images.js'
import type { AttachmentsService } from '../../runtime/attachments.js'
import type { AgentPresetService } from '../../runtime/agent.js'
import { showChoice, showImagePreview, showMarkdownPreview } from '../dialogs.js'
import type { CommandContext } from './context.js'
import type { SettingsService } from './services.js'
import { NL, errorMessage } from './shared.js'

/**
 * The `/preset` command.
 * @param ctx - command context.
 * @param args - the text after the command name.
 * @param selected - the preset new sessions inherit.
 * @param remember - record the preset the application should reuse.
 */
export async function presetCommand(
  ctx: CommandContext,
  args: string,
  selected: () => string | undefined,
  remember: (id: string) => void,
): Promise<void> {
  const presetService = ctx.host.get('agentPresets') as AgentPresetService | undefined
  if (presetService === undefined) {
    ctx.notice('warning', 'The agent-preset registry is unavailable.')
    return
  }
  try {
    const rows = await presetService.list()
    const currentPreset = presetService.composedPreset(ctx.active.agent.ctx)
    const applyPreset = async (id: string): Promise<void> => {
      remember(id)
      try {
        const applied = await presetService.select(ctx.active.agent, id)
        remember(applied)
        ctx.notice('info', 'Agent preset for current session: ' + applied)
        ctx.renderStatus()
      }
      catch (error) {
        ctx.notice('warning', 'Current session cannot switch preset: ' + errorMessage(error)
          + ' — next /new will use ' + id + '.')
      }
      const settings = ctx.host.get('settings') as unknown as SettingsService | undefined
      if (settings === undefined) {
        ctx.notice('warning', 'Preset applies now, but the settings service is unavailable; default preset was not saved.')
        return
      }
      try {
        const descriptor = settings.describe({ redactSecrets: true }).find(row => row.ns === 'agent-preset-registry')
        await settings.update('agent-preset-registry', { selectedDefault: id }, descriptor?.revision)
        ctx.notice('info', 'Default preset saved: ' + id)
      }
      catch (error) {
        ctx.notice('warning', 'Preset applies now, but the default could not be saved: ' + errorMessage(error))
      }
    }
    if (args === '') {
      const choice = await showChoice(ctx.tui, ctx.palette, 'Agent preset (current: ' + (currentPreset ?? 'none') + ')', rows.map((row: { id: string; name?: string; description?: string }) => ({
        value: row.id,
        label: (row.id === currentPreset ? '* ' : row.id === selected() ? '+ ' : '  ') + row.id,
        description: (row.name ?? '') + (row.description === undefined ? '' : ' — ' + row.description),
      })), 'Enter applies to a blank current session; started sessions use next /new · Esc cancels', ctx.signal)
      if (choice !== undefined) {
        await applyPreset(choice)
      }
      return
    }
    if (!rows.some((row: { id: string }) => row.id === args)) {
      ctx.notice('warning', 'Unknown preset "' + args + '". Available: ' + rows.map((row: { id: string }) => row.id).join(', '))
      return
    }
    await applyPreset(args)
  }
  catch (error) {
    ctx.notice('error', 'Could not read presets: ' + errorMessage(error))
  }
}

/** The `/export` command. */
export async function exportCommand(ctx: CommandContext, args: string): Promise<void> {
  if (args === 'html' || args.startsWith('html ')) {
    const target = args === 'html'
      ? 'dsh-session-' + ctx.active.id + '.html'
      : args.slice('html '.length).trim()
    if (target === '') {
      ctx.notice('warning', 'Usage: /export html [path]')
      return
    }
    try {
      const result = await exportSessionHtml(ctx.active.agent, target, ctx.config.cwd)
      ctx.notice('info', 'Exported HTML: ' + result.path + ' (' + String(result.bytes) + ' bytes, ' + String(result.eventCount) + ' events)')
    }
    catch (error) {
      ctx.notice('error', 'HTML export failed: ' + errorMessage(error))
    }
    return
  }
  if (args === 'zip' || args.startsWith('zip ')) {
    const target = args === 'zip'
      ? 'dsh-session-' + ctx.active.id + '.zip'
      : args.slice('zip '.length).trim()
    if (target === '') {
      ctx.notice('warning', 'Usage: /export zip [path]')
      return
    }
    const attachments = ctx.host.get('attachments') as AttachmentsService | undefined
    if (attachments === undefined) {
      ctx.notice('warning', 'The attachment service is unavailable; cannot build a ZIP bundle.')
      return
    }
    try {
      const result = await exportSessionBundle(ctx.active.agent, target, ctx.config.cwd, attachments, ctx.signal)
      ctx.notice('info', 'Exported ZIP bundle: ' + result.path + ' (' + String(result.bytes) + ' bytes, '
        + String(result.attachments.length) + ' attachment(s), '
        + String(result.deliverables.length) + ' deliverable(s)'
        + (result.skipped.length === 0 ? '' : ', ' + String(result.skipped.length) + ' skipped') + ')')
    }
    catch (error) {
      ctx.notice('error', 'ZIP export failed: ' + errorMessage(error))
    }
    return
  }
  const target = args === '' ? 'dsh-session-' + ctx.active.id + '.jsonl' : args
  try {
    const result = await exportSessionLog(ctx.active.agent, target, ctx.config.cwd)
    ctx.notice('info', 'Exported ' + String(result.eventCount) + ' events to ' + result.path)
  }
  catch (error) {
    ctx.notice('error', 'Export failed: ' + errorMessage(error))
  }
}

/** The `/open` command: page one text file, rendering Markdown when it is one. */
export async function openCommand(ctx: CommandContext, args: string): Promise<void> {
  if (args === '') {
    ctx.notice('warning', 'Usage: /open <path>')
    return
  }
  try {
    const target = resolve(ctx.config.cwd, args)
    const preview = await readTextPreview(target)
    if (isMarkdownPath(target)) {
      await showMarkdownPreview(ctx.tui, ctx.palette, preview.path, preview.text, ctx.signal)
      return
    }
    ctx.notice('info', 'File: ' + preview.path + ' (' + String(preview.bytes) + ' bytes'
      + (preview.truncated ? ', truncated' : '') + ')' + NL + preview.text)
  }
  catch (error) {
    ctx.notice('error', 'Could not open ' + args + ': ' + errorMessage(error))
  }
}

/** The `/preview` command: render one image file. */
export async function previewCommand(ctx: CommandContext, args: string): Promise<void> {
  if (args === '') {
    ctx.notice('warning', 'Usage: /preview <image-path>')
    return
  }
  try {
    const image = await readImagePreview(resolve(ctx.config.cwd, args))
    await showImagePreview(ctx.tui, ctx.palette, image, ctx.signal)
  }
  catch (error) {
    ctx.notice('error', 'Could not preview ' + args + ': ' + errorMessage(error))
  }
}
