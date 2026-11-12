import { TuiAltScreen } from '@earendil-works/pi-tui'
import { TranscriptMainScreen } from './transcript-main-screen.js'

/** Reports the complete synchronous paint, including layout and terminal writes. */
export class TimedAltScreen extends TuiAltScreen {
  onPaint: ((durationMs: number) => void) | undefined

  protected override doRender(): void {
    const start = performance.now()
    super.doRender()
    this.onPaint?.(performance.now() - start)
  }
}

/** Keeps the main-screen scrollback policy while measuring the complete paint. */
export class TimedMainScreen extends TranscriptMainScreen {
  onPaint: ((durationMs: number) => void) | undefined

  protected override doRender(): void {
    const start = performance.now()
    super.doRender()
    this.onPaint?.(performance.now() - start)
  }
}
