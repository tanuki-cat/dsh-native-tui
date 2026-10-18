import { describe, expect, it } from 'vitest'
import {
  isWebUrl,
  openUrlInBrowser,
  systemOpenCommand,
  systemRevealCommand,
} from '../src/runtime/open.js'

describe('systemOpenCommand', () => {
  it('resolves the default-open command per platform', () => {
    expect(systemOpenCommand('darwin', '/tmp/a.md')).toEqual({ command: 'open', args: ['/tmp/a.md'] })
    expect(systemOpenCommand('win32', 'C:\\tmp\\a.md')).toEqual({ command: 'cmd', args: ['/c', 'start', '', 'C:\\tmp\\a.md'] })
    expect(systemOpenCommand('linux', '/tmp/a.md')).toEqual({ command: 'xdg-open', args: ['/tmp/a.md'] })
    expect(systemOpenCommand('aix', '/tmp/a.md')).toBeUndefined()
  })
})

describe('systemRevealCommand', () => {
  it('resolves the reveal command per platform', () => {
    expect(systemRevealCommand('darwin', '/tmp/a.md')).toEqual({ command: 'open', args: ['-R', '/tmp/a.md'] })
    expect(systemRevealCommand('win32', 'C:\\tmp\\a.md')).toEqual({ command: 'explorer', args: ['/select,C:\\tmp\\a.md'] })
    expect(systemRevealCommand('linux', '/tmp/a.md')).toEqual({ command: 'xdg-open', args: ['/tmp'] })
    expect(systemRevealCommand('aix', '/tmp/a.md')).toBeUndefined()
  })
})

describe('isWebUrl', () => {
  it('accepts only absolute http and https URLs', () => {
    expect(isWebUrl('https://copilot.tencent.com/login?state=abc')).toBe(true)
    expect(isWebUrl('http://localhost:3000/callback')).toBe(true)
    expect(isWebUrl('file:///etc/passwd')).toBe(false)
    expect(isWebUrl('javascript:alert(1)')).toBe(false)
    expect(isWebUrl('./relative/page.md')).toBe(false)
    expect(isWebUrl('not a url')).toBe(false)
  })
})

describe('openUrlInBrowser', () => {
  it('refuses non-web targets without launching anything', () => {
    expect(openUrlInBrowser('javascript:alert(1)', 'darwin')).toBe(false)
    expect(openUrlInBrowser('/tmp/a.md', 'darwin')).toBe(false)
  })

  it('reports an unsupported platform instead of spawning', () => {
    expect(openUrlInBrowser('https://example.com/login', 'aix')).toBe(false)
  })
})
