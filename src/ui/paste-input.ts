const START = '\u001B[200~'
const END = '\u001B[201~'

/** Serialize asynchronous image imports with subsequent native editor input. */
export class PasteInput {
  private queue: Array<string | (() => void)> = []
  private buffer: string | undefined
  private task: Promise<void> | undefined
  private generation = 0

  constructor(
    private readonly paste: (text: string) => string | Promise<string>,
    private readonly input: (data: string) => void,
    private readonly render: () => void,
  ) {}

  handleInput(data: string): void {
    this.queue.push(data)
    this.drain()
  }

  get busy(): boolean { return this.task !== undefined }

  defer(action: () => void): void {
    this.queue.push(action)
    this.drain()
  }

  async whenIdle(): Promise<void> {
    while (this.task !== undefined) await this.task
  }

  cancel(): void {
    this.generation += 1
    this.queue = []
    this.buffer = undefined
  }

  private drain(): void {
    if (this.task !== undefined) return
    while (this.queue.length > 0) {
      let data = this.queue.shift()!
      if (typeof data === 'function') { data(); continue }
      if (this.buffer === undefined) {
        const start = data.indexOf(START)
        if (start < 0) { this.input(data); continue }
        if (start > 0) this.input(data.slice(0, start))
        this.buffer = ''
        data = data.slice(start + START.length)
      }
      this.buffer += data
      const end = this.buffer.indexOf(END)
      if (end < 0) continue
      const text = this.buffer.slice(0, end)
      const rest = this.buffer.slice(end + END.length)
      this.buffer = undefined
      if (rest !== '') this.queue.unshift(rest)
      const generation = this.generation
      let prepared: string | Promise<string>
      try { prepared = this.paste(text) }
      catch { prepared = text }
      if (typeof prepared === 'string') {
        if (prepared !== '') this.input(START + prepared + END)
        continue
      }
      this.task = prepared.catch(() => text).then(result => {
        if (generation === this.generation && result !== '') this.input(START + result + END)
      }).finally(() => {
        this.task = undefined
        this.drain()
        if (generation === this.generation) this.render()
      })
      return
    }
  }
}
