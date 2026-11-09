import { SelectList, Text, stripTerminalSequences, truncateToWidth, visibleWidth, type TUI } from '@earendil-works/pi-tui'
import type { ChoiceItem } from './dialogs.js'
import { literalToolText } from './tool-output.js'
import { selectTheme, type Palette } from './theme.js'

export interface ApprovalSummary {
  readonly heading: string
  readonly action?: string
  readonly detail?: string
  readonly cwd?: string
}

/** Numbered approval actions; number keys focus an action and Enter confirms it. */
export function showApprovalChoice(
  tui: TUI, palette: Palette, summary: ApprovalSummary, items: readonly ChoiceItem[], signal?: AbortSignal,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { resolve(undefined); return }
    let handle: ReturnType<TUI['showOverlay']> | undefined
    let settled = false
    const finish = (value?: string): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      handle?.hide()
      resolve(value)
    }
    const abort = (): void => { finish() }
    const list = new SelectList(items.map((item, index) => ({
      value: item.value, label: (index + 1) + '. ' + literalToolText(item.label),
    })), items.length, selectTheme(palette))
    list.onSelect = item => { finish(item.value) }
    list.onCancel = abort
    const fields = [
      { text: summary.heading, style: (text: string) => palette.bold(palette.warning(text)) },
      ...(summary.action === undefined ? [] : [{ text: summary.action, style: palette.accent }]),
      ...(summary.detail === undefined ? [] : [{ text: 'Reason: ' + summary.detail, style: palette.dim }]),
      ...(summary.cwd === undefined ? [] : [{ text: 'cwd ' + summary.cwd, style: palette.dim }]),
    ]
    const component = {
      render(width: number): string[] {
        const inset = Math.min(2, Math.max(0, width - 1))
        const inner = Math.max(1, width - inset * 2)
        const budget = Math.max(1, Math.floor((tui.terminal?.rows ?? 30) * 0.8) - items.length - 5)
        const title = fields.flatMap((field, index) => {
          const lines = new Text(field.style(literalToolText(field.text)), 0, 0).render(inner)
          const limit = index === 0 ? 1 : 2
          return lines.length <= limit ? lines : [...lines.slice(0, limit - 1), truncateToWidth(lines[limit - 1] ?? '', inner - 1) + '…']
        })
        const shown = title.length > budget && budget > 2
          ? [...title.slice(0, budget - 1), palette.dim('… View full request details')]
          : title.slice(0, budget)
        const lines = [palette.dim('─'.repeat(inner)), ...shown, '', ...list.render(inner),
          palette.dim('↑↓ / number selects · Enter confirms · Esc cancels'), palette.dim('─'.repeat(inner))]
        return lines.map(line => {
          const clipped = truncateToWidth(line, inner, '…')
          const padded = ' '.repeat(inset) + clipped + ' '.repeat(Math.max(0, width - inset - visibleWidth(clipped)))
          const styled = palette.dialogBand(truncateToWidth(padded, width, '…'))
          return palette.plain ? stripTerminalSequences(styled) : styled
        })
      },
      handleInput(data: string): void {
        const number = /^[1-9]$/u.test(data) ? Number(data) : 0
        if (number > 0 && number <= items.length) {
          list.setSelectedIndex(number - 1)
          tui.requestRender()
        } else list.handleInput(data)
      },
      invalidate(): void { list.invalidate() },
    }
    try {
      handle = tui.showOverlay(component, { width: 88, maxHeight: '80%', anchor: 'bottom-center' })
      signal?.addEventListener('abort', abort, { once: true })
      if (Boolean(signal?.aborted)) abort()
    } catch (error) { signal?.removeEventListener('abort', abort); handle?.hide(); reject(error) }
  })
}
