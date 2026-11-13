import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { imagePathReferences, importImagePaste } from '../runtime/image-input.js'
import type { AttachmentsService } from '../runtime/attachments.js'
import type { CommandContext } from './commands/context.js'
import { warnIfModelTextOnly } from './commands/attachments.js'
import { errorMessage, sessionCwd } from './commands/shared.js'
import type { PromptEditor } from './prompt-editor.js'
import { ImagePreviews } from './image-previews.js'
import { showImageViewer } from './image-viewer.js'

/** Bind thumbnails, numbered labels and path paste to the existing session draft. */
export function wireImageInput(editor: PromptEditor, context: () => CommandContext): void {
  const previews = new ImagePreviews()
  let viewing = false
  let viewerAbort: AbortController | undefined
  let viewerCurrent: (() => boolean) | undefined
  editor.attachmentPresentation = (width, maxRows) => {
    if (viewerCurrent?.() === false) viewerAbort?.abort()
    const ctx = context()
    const images = ctx.attachments.pending.filter(item => item.kind === 'image')
    const preview = previews.render(ctx, images, width, maxRows)
    if (images.length === 0) return undefined
    const names = images.map((_, index) => '[Image #' + (index + 1) + ']')
    const labels = ctx.palette.accent(names.join(' '))
    return { labels: ctx.palette.plain ? stripTerminalSequences(labels) : labels, preview: preview.lines,
      targets: preview.targets, labelWidths: names.map(name => name.length) }
  }
  editor.onPreviewAttachment = index => {
    const ctx = context()
    if (viewing || ctx.signal.aborted || ctx.isCurrent?.() === false || ctx.tui.hasOverlay?.()) return
    const images = ctx.attachments.pending.filter(item => item.kind === 'image' && item.block.type === 'image')
    const attachments = ctx.host.get('attachments') as AttachmentsService | undefined
    if (images[index] === undefined || attachments === undefined) return
    viewing = true
    viewerAbort = new AbortController()
    viewerCurrent = () => ctx.isCurrent?.() ?? true
    void showImageViewer(ctx.tui, ctx.palette, images.map((item, number) => ({
      name: '[Image #' + (number + 1) + '] ' + item.label,
      load: async signal => {
        if (item.block.type !== 'image') throw new Error('Attachment is not an image')
        const stored = await attachments.readImage(item.block.attachment, signal)
        if (ctx.isCurrent?.() === false || !ctx.attachments.pending.includes(item)) throw new Error('Image is no longer attached')
        return { path: 'attachment://' + item.block.attachment.attachmentId, name: item.label,
          mediaType: item.block.attachment.mediaType, base64: Buffer.from(stored.data).toString('base64'), bytes: stored.data.byteLength }
      },
    })), index, AbortSignal.any([ctx.signal, viewerAbort.signal])).catch(error => {
      if (!ctx.signal.aborted && ctx.isCurrent?.() !== false) ctx.notice('error', 'Could not preview image: ' + errorMessage(error))
    }).finally(() => { viewing = false; viewerAbort = undefined; viewerCurrent = undefined })
  }
  editor.onRemoveAttachment = () => {
    const ctx = context()
    const pending = ctx.attachments.pending
    const index = pending.findLastIndex(item => item.kind === 'image')
    if (index < 0) return false
    pending.splice(index, 1)
    ctx.renderStatus()
    return true
  }
  editor.onPaste = text => {
    const draft = editor.getText(), cursor = editor.getCursor()
    if (draft.trimStart().startsWith('/')) return text
    const marker = /(?:^|\s)@$/u.test(editor.getLines()[cursor.line]?.slice(0, cursor.col) ?? '')
    const prefixed = marker && !text.startsWith('@') && !/^\s/u.test(text)
    const source = prefixed ? '@' + text : text
    if (imagePathReferences(source).length === 0) return text
    const ctx = context()
    const attachments = ctx.host.get('attachments') as AttachmentsService | undefined
    if (attachments === undefined) return text
    const isCurrent = () => (ctx.isCurrent?.() ?? true) && !ctx.signal.aborted
    const count = ctx.attachments.pending.length
    let firstImported = false
    return importImagePaste(source, {
      cwd: sessionCwd(ctx), attachments, pending: ctx.attachments.pending,
      isCurrent,
      onError: (path, error) => ctx.notice('error', 'Could not attach ' + path + ': ' + errorMessage(error)),
      onImported: ref => { if (ref.start === 0) firstImported = true },
    }).then(async result => {
      if (!isCurrent()) return text
      if (marker && firstImported) editor.consumeAttachmentPrefix(draft, cursor)
      if (ctx.attachments.pending.length > count) {
        await warnIfModelTextOnly(ctx)
        ctx.renderStatus()
      }
      return prefixed && !firstImported ? result.slice(1) : result
    })
  }
}
