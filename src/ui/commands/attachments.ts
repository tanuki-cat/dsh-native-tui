/**
 * `/attach`: stage a file or a clipboard image, and inspect what is staged.
 *
 * @module dsh-native-tui/ui/commands/attachments
 */

import { getNativeClipboard } from '@earendil-works/pi-tui'
import {
  detectImageMediaType,
  imageExtension,
  loadAttachment,
  MAX_ATTACHMENT_BYTES,
  type AttachmentsService,
} from '../../runtime/attachments.js'
import { sanitizeTerminalText } from '../../runtime/files.js'
import { showImagePreview } from '../dialogs.js'
import type { CommandContext } from './context.js'
import { NL, errorMessage } from './shared.js'

/** The attachment service, or the notice that says it is missing. */
function requireAttachments(ctx: CommandContext): AttachmentsService | undefined {
  const attachments = ctx.host.get('attachments') as AttachmentsService | undefined
  if (attachments === undefined) {
    ctx.notice('warning', 'The attachment service is unavailable in this profile.')
    return undefined
  }
  return attachments
}

/** Stage one clipboard image. */
async function attachPaste(ctx: CommandContext, attachments: AttachmentsService): Promise<void> {
  const clipboard = getNativeClipboard()
  if (clipboard === undefined) {
    ctx.notice('warning', 'Clipboard images are unavailable on this platform.')
    return
  }
  try {
    const image = await clipboard.getImage()
    if (image === undefined) {
      ctx.notice('warning', 'The system clipboard image reader is unavailable.')
      return
    }
    if (image === null) {
      ctx.notice('info', 'No image on the clipboard.')
      return
    }
    if (image.byteLength > MAX_ATTACHMENT_BYTES) {
      ctx.notice('warning', 'Clipboard image is ' + String(image.byteLength) + ' bytes; terminal attachment limit is ' + String(MAX_ATTACHMENT_BYTES) + '.')
      return
    }
    const mediaType = detectImageMediaType(image)
    if (mediaType === undefined) {
      ctx.notice('warning', 'Clipboard image is not PNG, JPEG, GIF, or WebP.')
      return
    }
    const name = 'clipboard' + imageExtension(mediaType)
    const refs = await attachments.saveImages([{ data: image, mediaType, name }])
    const ref = refs[0]
    if (ref === undefined)
      throw new Error('attachment service returned no image reference')
    ctx.attachments.pending.push({
      label: name,
      kind: 'image',
      block: { type: 'image', attachment: ref },
    })
    ctx.notice('info', 'Attached clipboard image: ' + name + ' (sent with the next prompt)')
    ctx.renderStatus()
  }
  catch (error) {
    ctx.notice('error', 'Could not read the clipboard image: ' + errorMessage(error))
  }
}

/** Page one staged attachment. */
async function attachPreview(ctx: CommandContext, attachments: AttachmentsService, args: string): Promise<void> {
  const index = Number(args.slice('preview '.length).trim())
  if (!Number.isSafeInteger(index) || index < 0 || ctx.attachments.pending[index] === undefined) {
    ctx.notice('warning', 'Usage: /attach preview <index> (see /attach list)')
    return
  }
  const pending = ctx.attachments.pending[index]
  if (pending === undefined)
    return
  try {
    if (pending.block.type === 'image') {
      const stored = await attachments.readImage(pending.block.attachment, ctx.signal)
      await showImagePreview(ctx.tui, ctx.palette, {
        path: 'attachment://' + pending.block.attachment.attachmentId,
        name: pending.label,
        mediaType: pending.block.attachment.mediaType,
        base64: Buffer.from(stored.data).toString('base64'),
        bytes: stored.data.byteLength,
      }, ctx.signal)
    }
    else if (pending.block.type === 'file') {
      const chunks: Uint8Array[] = []
      let total = 0
      for await (const chunk of attachments.readFileStream(pending.block.attachment, ctx.signal)) {
        const remaining = 65_536 - total
        if (remaining <= 0)
          break
        const part = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk
        chunks.push(part)
        total += part.byteLength
        if (total >= 65_536)
          break
      }
      const data = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
      if (data.includes(0)) {
        ctx.notice('info', 'File: ' + pending.label + ' (' + String(data.byteLength) + ' bytes, binary)')
      }
      else {
        ctx.notice('info', 'File: ' + pending.label + ' (' + String(total) + ' bytes'
          + (total >= 65_536 ? ', truncated' : '') + ')' + NL + sanitizeTerminalText(new TextDecoder().decode(data)))
      }
    }
    else {
      ctx.notice('warning', 'Attachment ' + String(index) + ' has no previewable block.')
    }
  }
  catch (error) {
    ctx.notice('error', 'Could not preview attachment ' + String(index) + ': ' + errorMessage(error))
  }
}

/** The `/attach` command. */
export async function attachCommand(ctx: CommandContext, args: string): Promise<void> {
  const attachments = requireAttachments(ctx)
  if (attachments === undefined) return
  if (args === 'paste') {
    await attachPaste(ctx, attachments)
    return
  }
  if (args.startsWith('preview ')) {
    await attachPreview(ctx, attachments, args)
    return
  }
  if (args === '' || args === 'list') {
    const pending = ctx.attachments.pending
    if (pending.length === 0) {
      ctx.notice('info', 'No staged attachments. Use /attach <path>, /attach paste, or /attach clear.')
      return
    }
    ctx.notice('info', 'Staged attachments:' + NL + pending.map((item, index) => String(index) + '. ' + item.kind + '  ' + item.label).join(NL)
      + NL + 'Use /attach preview <index> to inspect one.')
    return
  }
  if (args === 'clear') {
    const count = ctx.attachments.pending.length
    ctx.attachments.clear()
    ctx.notice('info', 'Cleared ' + String(count) + ' staged attachment(s).')
    ctx.renderStatus()
    return
  }
  try {
    const pending = await loadAttachment(args, ctx.config.cwd, attachments)
    ctx.attachments.pending.push(pending)
    ctx.notice('info', 'Attached ' + pending.kind + ': ' + pending.label + ' (sent with the next prompt)')
    ctx.renderStatus()
  }
  catch (error) {
    ctx.notice('error', 'Could not attach ' + args + ': ' + errorMessage(error))
  }
}

/** The `/attachments` manager. */
export async function attachmentsCommand(ctx: CommandContext): Promise<void> {
  const attachments = requireAttachments(ctx)
  if (attachments === undefined) return
  if (ctx.attachments.pending.length === 0) {
    ctx.notice('info', 'No staged attachments. Use /attach <path> or /attach paste to add one.')
    return
  }
  const { showChoice } = await import('../dialogs.js')
  const picked = await showChoice(ctx.tui, ctx.palette, 'Attachments', ctx.attachments.pending.map((item, index) => ({
    value: String(index),
    label: String(index) + '. ' + item.label,
    description: item.kind + (item.kind === 'image' ? ' · image preview available' : ' · text preview available'),
  })), 'Enter opens · Esc closes', ctx.signal)
  if (picked === undefined)
    return
  const index = Number(picked)
  const pending = ctx.attachments.pending[index]
  if (pending === undefined)
    return
  const action = await showChoice(ctx.tui, ctx.palette, 'Attachment · ' + pending.label, [
    { value: 'preview', label: 'Preview', description: pending.kind === 'image' ? 'Render the image' : 'Show up to 64 KiB of text' },
    { value: 'remove', label: 'Remove', description: 'Unstage this attachment' },
    { value: 'back', label: 'Back' },
  ], 'Enter selects · Esc closes', ctx.signal)
  if (action === 'preview') {
    await ctx.runCommand('/attach preview ' + String(index))
    return
  }
  if (action === 'remove') {
    const removed = ctx.attachments.pending.splice(index, 1)[0]
    if (removed !== undefined)
      ctx.notice('info', 'Removed staged attachment: ' + removed.label)
    ctx.renderStatus()
  }
}
