/**
 * Chrome-geometry tracer for the fake-TTY probes.
 *
 * Loaded through NODE_OPTIONS=--import by a probe that spawns the real TUI, so
 * it can record where the status block and prompt actually landed in the
 * rendered viewport. The probe asserts those rows never move between an idle
 * frame and the first streamed frame of the next step.
 */
import { appendFileSync } from 'node:fs'
import { TuiMainScreen } from '@earendil-works/pi-tui'

const logPath = process.env.FAKE_TTY_GEOMETRY_LOG
const marks = (process.env.FAKE_TTY_GEOMETRY_MARKS ?? '').split(',').filter(Boolean)
const strip = text => text.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

if (logPath !== undefined) {
  const render = TuiMainScreen.prototype.doRender
  let previous = ''
  TuiMainScreen.prototype.doRender = function (...args) {
    render.apply(this, args)
    const state = this.captureRenderState()
    const lines = state.previousLines.map(strip)
    const statusRow = lines.findLastIndex(line => line.includes('● working') || line.includes('● idle'))
    const editorRow = lines.findLastIndex(line => line.startsWith('> '))
    if (statusRow < 0 || editorRow < 0) return
    const record = {
      statusRow: statusRow - state.previousViewportTop,
      editorRow: editorRow - state.previousViewportTop,
      wait: lines.some(line => line.includes('⟳ waiting for response') || line.includes('⟳ generating ')),
      mark: marks.filter(mark => lines.some(line => line.includes(mark))).join(','),
    }
    const key = JSON.stringify(record)
    if (key === previous) return
    previous = key
    appendFileSync(logPath, key + '\n')
  }
}
