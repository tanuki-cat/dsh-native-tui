/**
 * Chrome-geometry tracer for the fake-TTY probes.
 *
 * Loaded through NODE_OPTIONS=--import by a probe that spawns the real TUI, so
 * it can record where the status block and prompt actually landed in the
 * rendered viewport. The probe asserts those rows never move between an idle
 * frame and the first streamed frame of the next step.
 */
import { appendFileSync } from 'node:fs'
import { getCapabilities, setCapabilities, TuiAltScreen, TuiMainScreen, visibleWidth } from '@earendil-works/pi-tui'

const imageProtocol = process.env.FAKE_TTY_IMAGE_PROTOCOL
if (imageProtocol === 'kitty' || imageProtocol === 'iterm2' || imageProtocol === 'none') {
  setCapabilities({ ...getCapabilities(), images: imageProtocol === 'none' ? null : imageProtocol })
}
const imageLine = line => line.includes('\x1b_G') || line.includes('\x1b]1337;File=')

const logPath = process.env.FAKE_TTY_GEOMETRY_LOG
const marks = (process.env.FAKE_TTY_GEOMETRY_MARKS ?? '').split(',').filter(Boolean)
const strip = text => text.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

if (logPath !== undefined) {
  for (const Screen of [TuiMainScreen, TuiAltScreen]) {
    const render = Screen.prototype.doRender
    let previous = ''
    Screen.prototype.doRender = function (...args) {
      render.apply(this, args)
      const state = this instanceof TuiMainScreen ? this.captureRenderState()
        : { previousLines: this.previousScreen, previousViewportTop: 0 }
      const lines = state.previousLines.map(strip)
      const statusRow = lines.findLastIndex(line => /(?:^| · )(?:Working|Ready)(?: · |\s*$)/u.test(line))
      const editorRow = lines.findLastIndex(line => line.startsWith('› '))
      const traceOverlays = process.env.FAKE_TTY_TRACE_OVERLAYS === '1'
      if ((statusRow < 0 || editorRow < 0) && !traceOverlays) return
      const record = {
        statusRow: statusRow - state.previousViewportTop,
        editorRow: editorRow - state.previousViewportTop,
        wait: lines.some(line => line.includes('• Working (') || line.includes('• Retrying ')),
        mark: marks.filter(mark => lines.some(line => line.includes(mark))).join(','),
        width: this.terminal.columns,
        status: lines[statusRow]?.trimEnd() ?? '',
        footer: lines[statusRow + 1]?.trimEnd(),
        overflow: state.previousLines.some(line => !imageLine(line) && visibleWidth(line) > this.terminal.columns),
        ...(traceOverlays ? { overlay: this.hasOverlay() } : {}),
        ...(process.env.FAKE_TTY_FRAME_SNAPSHOT === '1' ? { lines, rawLines: state.previousLines } : {}),
      }
      const key = JSON.stringify(record)
      if (key === previous) return
      previous = key
      appendFileSync(logPath, key + '\n')
    }
  }
}
