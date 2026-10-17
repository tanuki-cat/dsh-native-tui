import { describe, expect, it } from 'vitest'
import {
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
