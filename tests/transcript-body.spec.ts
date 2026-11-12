import { Box, Container, Spacer, Text, type Component, type TuiMouseEvent } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import { TranscriptBody } from '../src/ui/transcript-body.js'

describe('TranscriptBody', () => {
  it.each([1, 20, 120])('preserves visible rows and vertical padding at width %s', width => {
    const content = new Container()
    content.addChild(new Text('中文内容 👩‍💻\n\u001b[32mcolored body\u001b[39m', 0, 0))
    content.addChild(new Spacer(1))
    content.addChild(new Text('tail', 0, 0))
    const previous = new Box(0, 1)
    previous.addChild(content)
    expect(new TranscriptBody(content).render(width).map(line => line.trimEnd()))
      .toEqual(previous.render(width).map(line => line.trimEnd()))
  })

  it('keeps an empty transcript at zero height and updates after it becomes nonempty', () => {
    const content = new Container()
    const body = new TranscriptBody(content)
    expect(body.render(80)).toEqual([])
    content.addChild(new Text('body', 0, 0))
    expect(body.render(80)).toHaveLength(3)
    content.clear()
    expect(body.render(80)).toEqual([])
  })

  it('passes child rows through without padding or interpreting image payloads', () => {
    const image = '\u001b_Ga=T,f=100;payload\u001b\\'
    const content: Component = { render: () => ['\u001b[32mshort\u001b[39m', '', image], invalidate: () => {} }
    expect(new TranscriptBody(content).render(80).slice(1, -1))
      .toEqual(content.render(80))
  })

  it('maps mouse events past the top padding and leaves padding unhandled', () => {
    const handleMouse = vi.fn(() => ({ handled: true }))
    const body = new TranscriptBody({ render: () => ['first', 'second'], invalidate: () => {}, handleMouse })
    body.render(80)
    const click = (y: number): TuiMouseEvent => ({ type: 'click', button: 'left', x: 2, y, screenX: 2,
      screenY: y + 5, width: 80, height: 4, shift: false, alt: false, ctrl: false })
    expect(body.handleMouse(click(0))).toBeUndefined()
    expect(body.handleMouse(click(3))).toBeUndefined()
    expect(handleMouse).not.toHaveBeenCalled()
    expect(body.handleMouse(click(1))).toMatchObject({ handled: true })
    expect(handleMouse).toHaveBeenCalledWith(expect.objectContaining({ y: 0, x: 2, height: 2, screenY: 6 }))
  })
})
