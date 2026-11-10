import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { imagePathReferences, importImagePaste } from '../runtime/image-input.js'
import type { AttachmentsService } from '../runtime/attachments.js'
import type { CommandContext } from './commands/context.js'
import { warnIfModelTextOnly } from './commands/attachments.js'
import { errorMessage, sessionCwd } from './commands/shared.js'
import type { PromptEditor } from './prompt-editor.js'
import { ImagePreviews } from './image-previews.js'

/** Bind thumbnails, numbered labels and path paste to the existing session draft. */
export function wireImageInput(editor: PromptEditor, context: () => CommandContext): void {
  const previews = new ImagePreviews()
  editor.attachmentPresentation = (width, maxRows) => {
    const ctx = context()
    const images = ctx.attachments.pending.filter(item => item.kind === 'image')
    const preview = previews.render(ctx, images, width, maxRows)
    if (images.length === 0) return undefined
    const labels = ctx.palette.accent(images.map((_, index) => '[Image #' + (index + 1) + ']').join(' '))
    return { labels: ctx.palette.plain ? stripTerminalSequences(labels) : labels, preview }
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
    if (editor.getText().trimStart().startsWith('/') || imagePathReferences(text).length === 0) return text
    const ctx = context()
    const attachments = ctx.host.get('attachments') as AttachmentsService | undefined
    if (attachments === undefined) return text
    const isCurrent = () => (ctx.isCurrent?.() ?? true) && !ctx.signal.aborted
    const count = ctx.attachments.pending.length
    return importImagePaste(text, {
      cwd: sessionCwd(ctx), attachments, pending: ctx.attachments.pending,
      isCurrent,
      onError: (path, error) => ctx.notice('error', 'Could not attach ' + path + ': ' + errorMessage(error)),
    }).then(async result => {
      if (isCurrent() && ctx.attachments.pending.length > count) {
        await warnIfModelTextOnly(ctx)
        ctx.renderStatus()
      }
      return result
    })
  }
}
