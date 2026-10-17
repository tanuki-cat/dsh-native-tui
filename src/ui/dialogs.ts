import {
  Container,
  Image,
  Input,
  Markdown,
  SelectList,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from '@earendil-works/pi-tui'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
  AskUserQuestionOption,
} from '@deepseek-ai/dsh-user-questions'
import type { Palette } from './theme.js'
import { markdownTheme, selectTheme } from './theme.js'
import { clip } from './transcript.js'
import type { ImagePreview } from '../runtime/images.js'

/** One selectable row in a terminal dialog. */
export interface ChoiceItem {
  readonly value: string
  readonly label: string
  readonly description?: string
}

function localeText(value: { readonly en: string; readonly [locale: string]: string } | undefined): string | undefined {
  if (value === undefined) return undefined
  return value.en ?? Object.values(value)[0]
}

/** Render a full-width, opaque dialog surface so the transcript cannot bleed through. */
function dialogFrame(lines: readonly string[], width: number, palette: Palette): string[] {
  const outer = Math.max(20, width)
  const inner = Math.max(1, outer - 4)
  const content = lines.map((line) => {
    const clipped = truncateToWidth(line, inner)
    return '│ ' + clipped + ' '.repeat(Math.max(0, inner - visibleWidth(clipped))) + ' │'
  })
  const framed = ['┌' + '─'.repeat(outer - 2) + '┐', ...content, '└' + '─'.repeat(outer - 2) + '┘']
  return framed.map((line) => {
    const clipped = truncateToWidth(line, outer)
    return palette.dialogBand(clipped + ' '.repeat(Math.max(0, outer - visibleWidth(clipped))))
  })
}

/** SelectList wrapper that owns its title and key hint. */
class ChoiceDialog implements Component {
  private readonly list: SelectList
  constructor(
    private readonly title: string,
    items: readonly ChoiceItem[],
    private readonly hint: string,
    private readonly palette: Palette,
  ) {
    this.list = new SelectList(
      items.map(item => ({ value: item.value, label: item.label, ...(item.description === undefined ? {} : { description: item.description }) })),
      Math.min(12, Math.max(1, items.length)),
      selectTheme(palette),
    )
  }

  get selectList(): SelectList { return this.list }

  render(width: number): string[] {
    const inner = Math.max(20, width - 4)
    return dialogFrame([
      ...new Text(this.title, 0, 0).render(inner),
      '',
      ...this.list.render(inner),
      '',
      ...new Text(this.palette.dim(this.hint), 0, 0).render(inner),
    ], width, this.palette)
  }

  handleInput(data: string): void { this.list.handleInput(data) }
  invalidate(): void { this.list.invalidate() }
}

/** Searchable select list with an inline filter input. */
class SearchChoiceDialog implements Component {
  private list: SelectList
  private readonly input: Input
  onSelect?: (item: { value: string; label: string; description?: string }) => void
  onCancel?: () => void
  constructor(
    private readonly title: string,
    private readonly items: readonly ChoiceItem[],
    private readonly hint: string,
    private readonly palette: Palette,
  ) {
    this.input = new Input({ prompt: 'search: ', placeholder: 'type to filter' })
    this.input.focused = true
    this.list = this.makeList('')
  }

  private makeList(filter: string): SelectList {
    const query = filter.trim().toLowerCase()
    const matches = this.items.filter(item => query === ''
      || item.value.toLowerCase().includes(query)
      || item.label.toLowerCase().includes(query)
      || (item.description ?? '').toLowerCase().includes(query))
    const list = new SelectList(
      matches.map(item => ({ value: item.value, label: item.label, ...(item.description === undefined ? {} : { description: item.description }) })),
      12,
      selectTheme(this.palette),
    )
    list.onSelect = item => { this.onSelect?.(item) }
    list.onCancel = () => { this.onCancel?.() }
    return list
  }

  render(width: number): string[] {
    const inner = Math.max(20, width - 4)
    return dialogFrame([
      ...new Text(this.title, 0, 0).render(inner),
      ...this.input.render(inner),
      '',
      ...this.list.render(inner),
      '',
      ...new Text(this.palette.dim(this.hint), 0, 0).render(inner),
    ], width, this.palette)
  }

  handleInput(data: string): void {
    if (data === '\r' || data === '\n' || data === '\x1b' || data.startsWith('\x1b[')) {
      this.list.handleInput(data)
      return
    }
    this.input.handleInput(data)
    this.list = this.makeList(this.input.getValue())
  }

  invalidate(): void {
    this.input.invalidate()
    this.list.invalidate()
  }
}

/** Single-line input wrapper that owns its title and key hint. */
class TextInputDialog implements Component {
  readonly input: Input
  constructor(
    private readonly title: string,
    placeholder: string,
    private readonly hint: string,
    private readonly palette: Palette,
    initialValue?: string,
  ) {
    this.input = new Input({ prompt: '> ', placeholder })
    if (initialValue !== undefined) this.input.setValue(initialValue)
    this.input.focused = true
  }

  render(width: number): string[] {
    const inner = Math.max(20, width - 4)
    return dialogFrame([
      ...new Text(this.title, 0, 0).render(inner),
      '',
      ...this.input.render(inner),
      '',
      ...new Text(this.palette.dim(this.hint), 0, 0).render(inner),
    ], width, this.palette)
  }

  handleInput(data: string): void { this.input.handleInput(data) }
  invalidate(): void { this.input.invalidate() }
}

/** Frame an arbitrary overlay component with the shared opaque dialog surface. */
class FramedOverlay implements Component {
  constructor(
    private readonly child: Component,
    private readonly palette: Palette,
  ) {}

  render(width: number): string[] {
    return dialogFrame(this.child.render(Math.max(1, width - 4)), width, this.palette)
  }

  invalidate(): void { this.child.invalidate?.() }
}

/** Show one keyboard-selected choice. */
export function showChoice(
  tui: TUI,
  palette: Palette,
  title: string,
  items: readonly ChoiceItem[],
  hint: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      resolve(undefined)
      return
    }
    let handle: ReturnType<TUI['showOverlay']> | undefined
    let settled = false
    const finish = (value: string | undefined): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      handle?.hide()
      resolve(value)
    }
    const onAbort = (): void => { finish(undefined) }
    try {
      const dialog = new ChoiceDialog(title, items, hint, palette)
      handle = tui.showOverlay(dialog, { width: 76, maxHeight: '80%', anchor: 'center' })
      dialog.selectList.onSelect = item => { finish(item.value) }
      dialog.selectList.onCancel = () => { finish(undefined) }
    } catch (error) {
      reject(error)
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Show a searchable choice list. The filter is matched by SelectList against labels and descriptions. */
export function showSearchChoice(
  tui: TUI,
  palette: Palette,
  title: string,
  items: readonly ChoiceItem[],
  hint: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      resolve(undefined)
      return
    }
    let handle: ReturnType<TUI['showOverlay']> | undefined
    let settled = false
    const finish = (value: string | undefined): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      handle?.hide()
      resolve(value)
    }
    const onAbort = (): void => { finish(undefined) }
    try {
      const dialog = new SearchChoiceDialog(title, items, hint, palette)
      handle = tui.showOverlay(dialog, { width: 84, maxHeight: '85%', anchor: 'center' })
      dialog.onSelect = item => { finish(item.value) }
      dialog.onCancel = () => { finish(undefined) }
    }
    catch (error) {
      reject(error)
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Show one free-text input. */
export function showTextInput(
  tui: TUI,
  palette: Palette,
  title: string,
  placeholder: string,
  hint: string,
  signal?: AbortSignal,
  initialValue?: string,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      resolve(undefined)
      return
    }
    let handle: ReturnType<TUI['showOverlay']> | undefined
    let settled = false
    const finish = (value: string | undefined): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      handle?.hide()
      resolve(value)
    }
    const onAbort = (): void => { finish(undefined) }
    try {
      const dialog = new TextInputDialog(title, placeholder, hint, palette, initialValue)
      handle = tui.showOverlay(dialog, { width: 76, maxHeight: '80%', anchor: 'center' })
      dialog.input.onSubmit = value => {
        const trimmed = value.trim()
        finish(trimmed === '' ? undefined : trimmed)
      }
      dialog.input.onEscape = () => { finish(undefined) }
    } catch (error) {
      reject(error)
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Render Markdown at a fixed overlay width and page the styled lines. */
export function showMarkdownPreview(
  tui: TUI,
  palette: Palette,
  title: string,
  markdown: string,
  signal?: AbortSignal,
): Promise<void> {
  const rendered = new Markdown(markdown, 0, 0, markdownTheme(palette)).render(96).join('\n')
  return showTextPager(tui, palette, 'Markdown · ' + title, rendered, signal)
}

/** Show a paged read-only text overlay; Escape closes it. */
export function showTextPager(
  tui: TUI,
  palette: Palette,
  title: string,
  text: string,
  signal?: AbortSignal,
  pageSize = 22,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const lines = text.split('\n')
    let offset = 0
    let handle: ReturnType<TUI['showOverlay']> | undefined
    let off: (() => void) | undefined
    let settled = false
    const body = new Text('', 0, 0)
    const hint = new Text('', 0, 0)
    const render = (): void => {
      const max = Math.max(0, lines.length - pageSize)
      offset = Math.min(Math.max(0, offset), max)
      const slice = lines.slice(offset, offset + pageSize)
      body.setText(slice.length === 0 ? '(empty)' : slice.join('\n'))
      hint.setText(palette.dim('lines ' + String(offset + 1) + '–' + String(Math.min(lines.length, offset + pageSize))
        + ' / ' + String(lines.length) + ' · ↑/↓ PgUp/PgDn · Esc closes'))
      tui.requestRender()
    }
    const finish = (): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      off?.()
      handle?.hide()
      resolve()
    }
    const onAbort = (): void => { finish() }
    try {
      const container = new Container()
      container.addChild(new Text(palette.bold(title), 0, 0))
      container.addChild(body)
      container.addChild(hint)
      off = tui.addInputListener((data) => {
        if (data === String.fromCharCode(27)) {
          finish()
          return { consume: true }
        }
        if (data === '\x1b[A') {
          offset -= 1
          render()
          return { consume: true }
        }
        if (data === '\x1b[B') {
          offset += 1
          render()
          return { consume: true }
        }
        if (data === '\x1b[5~') {
          offset -= pageSize
          render()
          return { consume: true }
        }
        if (data === '\x1b[6~') {
          offset += pageSize
          render()
          return { consume: true }
        }
        return undefined
      })
      handle = tui.showOverlay(new FramedOverlay(container, palette), { width: 100, maxHeight: '85%', anchor: 'center' })
      handle.focus()
      render()
    } catch (error) {
      off?.()
      reject(error)
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Show an image overlay; Enter or Escape closes it. */
export function showImagePreview(
  tui: TUI,
  palette: Palette,
  image: ImagePreview,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    let handle: ReturnType<TUI['showOverlay']> | undefined
    let off: (() => void) | undefined
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      off?.()
      handle?.hide()
      resolve()
    }
    const onAbort = (): void => { finish() }
    try {
      const container = new Container()
      container.addChild(new Text(
        palette.bold('Image · ' + image.name + ' · ' + image.mediaType + ' · ' + String(image.bytes) + ' bytes'),
        0,
        0,
      ))
      container.addChild(new Image(image.base64, image.mediaType, {
        fallbackColor: text => palette.dim(text),
      }, {
        filename: image.name,
        maxWidthCells: 76,
        maxHeightCells: 30,
      }))
      container.addChild(new Text(palette.dim('Enter/Esc closes'), 0, 0))
      off = tui.addInputListener((data) => {
        if (data === String.fromCharCode(27) || data === '\r' || data === '\n') {
          finish()
          return { consume: true }
        }
        return undefined
      })
      handle = tui.showOverlay(new FramedOverlay(container, palette), { width: 80, maxHeight: '85%', anchor: 'center' })
      handle.focus()
    } catch (error) {
      off?.()
      reject(error)
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Present one approval request and map the terminal choice to an approval outcome. */
export async function showApproval(
  tui: TUI,
  palette: Palette,
  request: Pick<ApprovalRequest, 'toolName' | 'callId' | 'reason' | 'displayReason' | 'signal'>,
  signal?: AbortSignal,
): Promise<ApprovalOutcome> {
  const reason = localeText(request.displayReason) ?? request.reason
  const title = [
    `Approval required · ${request.toolName}`,
    ...(reason === undefined ? [] : [palette.dim(clip(reason, 800))]),
    ...(request.callId === undefined ? [] : [palette.dim(`call ${request.callId}`)]),
  ].join('\n')
  const choice = await showChoice(
    tui,
    palette,
    title,
    [
      { value: 'allow', label: 'Allow once', description: 'Approve this exact request only' },
      { value: 'reject', label: 'Reject', description: 'Fail the request closed' },
    ],
    'Enter selects · Esc cancels',
    signal,
  )
  if (choice === 'allow') return 'allowed-once'
  if (choice === 'reject') return 'rejected'
  return 'cancelled'
}

function questionTitle(question: AskUserQuestionItem, index: number, total: number): string {
  const parts = [
    question.header === undefined ? `Question ${String(index + 1)}/${String(total)}` : `${question.header} · ${String(index + 1)}/${String(total)}`,
    question.question,
  ]
  if (question.detail !== undefined && question.detail.trim() !== '') {
    parts.push('', clip(question.detail, 1600))
  }
  if (question.multiSelect === true) parts.push('', 'multi-select: this build accepts one option per question')
  return parts.join('\n')
}

async function answerOne(
  tui: TUI,
  palette: Palette,
  question: AskUserQuestionItem,
  index: number,
  total: number,
  signal?: AbortSignal,
): Promise<AskUserQuestionAnswer['answers'][number]> {
  const options: readonly AskUserQuestionOption[] = question.options ?? []
  if (options.length === 0) {
    const custom = await showTextInput(
      tui,
      palette,
      questionTitle(question, index, total),
      'type an answer',
      'Enter submits · Esc cancels',
      signal,
    )
    if (custom === undefined) throw new Error('ask_user_question was aborted before the user answered')
    return { id: question.id, selected: [], custom }
  }
  const choice = await showChoice(
    tui,
    palette,
    questionTitle(question, index, total),
    [
      ...options.map((option, optionIndex) => ({
        value: option.label,
        label: option.label,
        description: option.description ?? `option ${String(optionIndex + 1)}`,
      })),
      { value: '__custom__', label: 'Other…', description: 'Type a free-text answer' },
    ],
    'Enter selects · Esc cancels',
    signal,
  )
  if (choice === undefined) throw new Error('ask_user_question was aborted before the user answered')
  if (choice === '__custom__') {
    const custom = await showTextInput(
      tui,
      palette,
      questionTitle(question, index, total),
      'type an answer',
      'Enter submits · Esc cancels',
      signal,
    )
    if (custom === undefined) throw new Error('ask_user_question was aborted before the user answered')
    return { id: question.id, selected: [], custom }
  }
  return { id: question.id, selected: [choice] }
}

/** Present every question in one batch, sequentially. */
export async function showQuestionBatch(
  tui: TUI,
  palette: Palette,
  questions: readonly AskUserQuestionItem[],
  signal?: AbortSignal,
): Promise<AskUserQuestionAnswer> {
  const answers: AskUserQuestionAnswer['answers'] = []
  for (const [index, question] of questions.entries()) {
    answers.push(await answerOne(tui, palette, question, index, questions.length, signal))
  }
  return { answers }
}