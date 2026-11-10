import { getCapabilities, Image } from '@earendil-works/pi-tui'
import type { AttachmentsService, PendingAttachment } from '../runtime/attachments.js'
import type { CommandContext } from './commands/context.js'

interface PreviewEntry {
  readonly abort: AbortController
  image?: Image
}

/** Keep only the visible draft's thumbnails; late reads never restore removed images. */
export class ImagePreviews {
  private readonly entries = new Map<PendingAttachment, PreviewEntry>()

  render(ctx: CommandContext, images: readonly PendingAttachment[], width: number, maxRows: number): string[] {
    const enabled = getCapabilities().images !== null && width >= 20 && maxRows >= 3 && !ctx.signal.aborted
    const shown = enabled ? images.slice(0, Math.min(2, Math.floor(maxRows / 3))) : []
    for (const [item, entry] of this.entries) {
      if (shown.includes(item)) continue
      entry.abort.abort()
      this.entries.delete(item)
    }
    const attachments = ctx.host.get('attachments') as AttachmentsService | undefined
    if (attachments === undefined) return []
    const lines: string[] = []
    for (const [index, item] of shown.entries()) {
      if (item.block.type !== 'image') continue
      let entry = this.entries.get(item)
      if (entry === undefined) {
        entry = { abort: new AbortController() }
        this.entries.set(item, entry)
        void this.load(ctx, attachments, item, entry)
      }
      if (entry.image === undefined) continue
      const thumbnail = entry.image.render(width - 2)
      if (!thumbnail.some(line => line.includes('\x1b_G') || line.includes('\x1b]1337;File='))) continue
      lines.push('  ' + ctx.palette.dim('[Image #' + (index + 1) + ']'), ...thumbnail.map(line => '  ' + line))
    }
    return lines
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
      entry.image = new Image(Buffer.from(stored.data).toString('base64'), ref.mediaType, {
        fallbackColor: text => ctx.palette.dim(text),
      }, { maxWidthCells: 12, maxHeightCells: 2 })
      ctx.tui.requestRender()
    } catch {
      // Preview failure leaves the original attachment available for submission and manual inspection.
    }
  }
}
