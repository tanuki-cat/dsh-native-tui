import { stripTerminalSequences, truncateToWidth } from '@earendil-works/pi-tui'
import { imagePathReferences, importImagePaste } from '../runtime/image-input.js'
import type { AttachmentsService } from '../runtime/attachments.js'
import type { CommandContext } from './commands/context.js'
import { warnIfModelTextOnly } from './commands/attachments.js'
import { errorMessage, sessionCwd } from './commands/shared.js'
import type { PromptEditor } from './prompt-editor.js'

/** Bind the attachment strip and path paste to the existing session draft. */
export function wireImageInput(editor: PromptEditor, context: () => CommandContext): void {
  editor.attachmentRow = width => {
    const ctx = context()
    const count = ctx.attachments.pending.filter(item => item.kind === 'image').length
    if (count === 0) return undefined
    const labels = Array.from({ length: count }, (_, index) => '[Image #' + (index + 1) + ']').join(' ')
    const row = truncateToWidth(ctx.palette.accent(labels) + ctx.palette.dim(' · /attachments preview/remove · backspace remove last'), width, '…')
    return ctx.palette.plain ? stripTerminalSequences(row) : row
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
