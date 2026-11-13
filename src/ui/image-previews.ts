import { getCapabilities, Image, truncateToWidth } from '@earendil-works/pi-tui'
import type { AttachmentsService, PendingAttachment } from '../runtime/attachments.js'
import type { CommandContext } from './commands/context.js'
import type { AttachmentTarget } from './prompt-editor.js'

interface PreviewEntry {
  readonly abort: AbortController
  base64?: string
  height?: number
  image?: Image
}

/** Keep only the visible draft's thumbnails; late reads never restore removed images. */
export class ImagePreviews {
  private readonly entries = new Map<PendingAttachment, PreviewEntry>()

  render(ctx: CommandContext, images: readonly PendingAttachment[], width: number, maxRows: number): { lines: string[]; targets: AttachmentTarget[] } {
    const enabled = ctx.config.showImageThumbnails && getCapabilities().images !== null
      && width >= 20 && maxRows >= 3 && !ctx.signal.aborted && !ctx.tui.hasOverlay?.()
    const shown = enabled ? images.slice(0, Math.min(2, Math.floor(maxRows / 3))) : []
    const height = Math.min(4, Math.max(1, Math.floor(maxRows / Math.max(1, shown.length)) - 1))
    for (const [item, entry] of this.entries) {
      if (shown.includes(item)) continue
      entry.abort.abort()
      this.entries.delete(item)
    }
    const attachments = ctx.host.get('attachments') as AttachmentsService | undefined
    const lines: string[] = []
    const targets: AttachmentTarget[] = []
    if (attachments === undefined) return { lines, targets }
    for (const [index, item] of shown.entries()) {
      if (item.block.type !== 'image') continue
      let entry = this.entries.get(item)
      if (entry === undefined) {
        entry = { abort: new AbortController() }
        this.entries.set(item, entry)
        void this.load(ctx, attachments, item, entry)
      }
      if (entry.base64 === undefined) continue
      if (entry.image === undefined || entry.height !== height) {
        entry.height = height
        entry.image = new Image(entry.base64, item.block.attachment.mediaType, {
          fallbackColor: text => ctx.palette.dim(text),
        }, { maxWidthCells: 16, maxHeightCells: height })
      }
      const thumbnail = entry.image.render(width - 2)
      if (!thumbnail.some(line => line.includes('\x1b_G') || line.includes('\x1b]1337;File='))) continue
      targets.push({ index, row: lines.length, column: 2, width: Math.min(18, width - 2), height: thumbnail.length + 1 })
      lines.push('  ' + ctx.palette.dim(truncateToWidth('[Image #' + (index + 1) + '] · Alt+I preview', width - 2, '…')),
        ...thumbnail.map(line => '  ' + line))
    }
    return { lines, targets }
  }

  private async load(ctx: CommandContext, attachments: AttachmentsService, item: PendingAttachment, entry: PreviewEntry): Promise<void> {
    if (item.block.type !== 'image') return
    const ref = item.block.attachment
    const signal = AbortSignal.any([ctx.signal, entry.abort.signal])
    const discard = (): void => {
      if (this.entries.get(item) === entry) this.entries.delete(item)
      signal.removeEventListener('abort', discard)
    }
    signal.addEventListener('abort', discard, { once: true })
    try {
      const stored = await attachments.readImage(ref, signal)
      if (signal.aborted || this.entries.get(item) !== entry || !ctx.attachments.pending.includes(item)) return
      entry.base64 = Buffer.from(stored.data).toString('base64')
      ctx.tui.requestRender()
    } catch {
      // Preview failure leaves the original attachment available for submission and manual inspection.
    }
  }
}
