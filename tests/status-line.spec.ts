import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { stripVTControlCharacters } from 'node:util'
import { createPalette } from '../src/ui/theme.js'
import { StatusBar } from '../src/ui/status-bar.js'
import { renderStatusRows, splitContextLine, splitSessionMetrics, terminalWindowTitle, workspacePath, type StatusInput } from '../src/ui/status-line.js'

const palette = createPalette('plain')

function rows() {
  const state = { header: '' }
  const status = new StatusBar(' · ')
  const footer = new StatusBar(' · ')
  return {
    state, status, footer,
    rows: {
      header: { setText: (text: string) => { state.header = text } },
      status, footer,
    },
  }
}

function inputOf(overrides: Partial<StatusInput> = {}): StatusInput {
  return {
    title: 'Test TUI', sessionId: 'session-1', cwd: '/tmp/work', running: false,
    provider: 'provider', model: 'model', reasoningEffort: 'max', preset: 'ptc', attachmentCount: 0,
    contextWindow: 1_000_000, contextMeter: { tokens: 400_000 },
    stats: { turns: 2, steps: 3, decodeMs: 2000, decodeTokens: 100 }, events: [], ...overrides,
  }
}

function painted(overrides: Partial<StatusInput> = {}, theme: 'plain' | 'dark' | 'light' = 'plain') {
  const result = rows()
  renderStatusRows(result.rows, createPalette(theme), inputOf(overrides))
  return result
}

const full = (bar: StatusBar): string => bar.render(1000)[0]!

describe('renderStatusRows', () => {
  it('keeps the title and session in the header and moves cwd to the status bar', () => {
    const { state, status } = painted()
    expect(state.header).toBe('Test TUI\nsession-1')
    expect(full(status)).toContain('/tmp/work')
  })

  it('groups model and effort, workspace, state, context and metrics with dots', () => {
    const { status, footer } = painted({ attachmentCount: 2 })
    expect(full(status)).toBe('provider/model max · /tmp/work · Ready · Context 40% used · attached 2 · preset ptc · 2 turns · 3 steps · 50 tok/s')
    expect(full(footer)).toBe('enter send · shift+tab think · /help · ctrl+d exit')
  })

  it.each([['manual', 'manual mode'], ['accept-edits', 'accept edits'], ['plan', 'plan mode'], ['auto', 'auto mode · EXP'], ['custom', 'custom mode'], ['off', 'off']] as const)('keeps %s visible beside the shortcuts', (interactionMode, label) => {
    const { footer } = painted({ interactionMode })
    expect(full(footer)).toBe(label + ' · enter send · shift+tab think · /help · ctrl+d exit')
  })

  it.each(['read-only', 'workspace-write', 'danger-full-access', 'custom', 'profile-native'])('preserves native %s permission at normal and narrow widths', permissionPreset => {
    const { footer } = painted({ interactionMode: 'off', permissionPreset })
    expect(full(footer)).toContain('off · permission ' + permissionPreset)
    expect(footer.render(32)[0]).toContain(permissionPreset)
  })

  it('refreshes permissions without retaining the previous selection', () => {
    const result = painted({ interactionMode: 'off', permissionPreset: 'workspace-write' })
    renderStatusRows(result.rows, palette, inputOf({ interactionMode: 'off', permissionPreset: 'read-only' }))
    expect(full(result.footer)).toContain('permission read-only')
    expect(full(result.footer)).not.toContain('workspace-write')
  })

  it('shows native permissions when the mode service is absent and omits missing values', () => {
    expect(full(painted({ permissionPreset: 'workspace-write' }).footer)).toContain('permission workspace-write')
    const footer = full(painted({ interactionMode: 'off' }).footer)
    expect(footer).not.toContain('permission ')
    expect(footer).not.toContain('undefined')
  })

  it('does not repeat a TUI mode as a native permission', () => {
    const { footer } = painted({ interactionMode: 'manual', permissionPreset: 'manual' })
    expect(full(footer)).toContain('manual mode')
    expect(full(footer)).not.toContain('permission ')
  })

  it('shows Working and running shortcuts while omitting an unset reasoning level', () => {
    const { status, footer } = painted({ running: true, reasoningEffort: undefined })
    expect(full(status)).toContain('provider/model · /tmp/work · Working')
    expect(full(status)).not.toContain('default')
    expect(full(footer)).toBe('enter steer · esc cancel · ctrl+c cancel · ctrl+d exit')
  })

  it('distinguishes the warm model, green workspace and violet idle state', () => {
    const { status } = painted({ attachmentCount: 2, contextMeter: { tokens: 700_000 } }, 'dark')
    const line = full(status)
    expect(line).toContain('\u001B[2mprovider')
    const palette = createPalette('dark')
    expect(line).toContain(palette.bold(palette.model('model max')))
    expect(line).toContain(palette.workspace('/tmp/work'))
    expect(line).toContain(palette.ready('Ready'))
    expect(line).not.toContain(palette.error('max'))
    expect(line).toContain('\u001B[38;5;141mptc')
    expect(line).toContain('\u001B[38;5;117mattached 2')
    expect(line).toContain('\u001B[33mContext 70% used')
    expect(full(painted({ interactionMode: 'off', permissionPreset: 'danger-full-access' }, 'dark').footer))
      .toContain('\u001B[33mdanger-full-access')
  })

  it('omits empty usage statistics before a model has run without inventing context', () => {
    const { status } = painted({ stats: undefined, events: [], contextMeter: {} })
    expect(full(status)).toContain('Context —')
    expect(full(status)).not.toMatch(/0 turns|0 steps|0 tok|— tok\/s|cache —/u)
  })

  it('uses the actual compaction trigger for the context warning color', () => {
    expect(full(painted({ contextMeter: { tokens: 800_000 } }, 'dark').status)).toContain('\u001B[31mContext 80% used')
    const { status } = painted({ contextMeter: { tokens: 400_000, reservedTokens: 600_000 } }, 'dark')
    expect(full(status)).toContain('\u001B[31mContext 40% used')
  })

  it('distinguishes unknown context from a measured zero', () => {
    expect(full(painted({ contextMeter: {} }).status)).toContain('Context —')
    expect(full(painted({ contextWindow: undefined, contextMeter: undefined }).status)).toContain('Context —')
    expect(full(painted({ contextMeter: { tokens: 0 } }).status)).toContain('Context 0% used')
  })

  it('cleans terminal instructions and flattens multiline labels before adding styling', () => {
    const label = 'safe\u001B]52;c;UFJPT0Y=\u0007\u001B[2Jend\nnext\tline'
    const { state, status, footer } = painted({ title: label, sessionId: label, cwd: label, provider: label,
      model: label, preset: label, reasoningEffort: label, permissionPreset: label })
    for (const text of [state.header, full(status), full(footer)]) {
      expect(text).not.toContain('\u001B')
      expect(text).toContain('safeend next line')
    }
    expect(full(status)).not.toMatch(/[\n\r\t]/u)
    expect(full(footer)).not.toMatch(/[\n\r\t]/u)
    expect(state.header.split('\n')).toHaveLength(2)
  })
})

describe('status layout', () => {
  it.each([1, 16, 32, 60, 100, 160, 240])('stays exactly two rows at %i columns and restores fields on expansion', width => {
    for (const theme of ['plain', 'dark', 'light'] as const) {
      for (const interactionMode of ['auto', 'off'] as const) {
        const { status, footer } = painted({ interactionMode, permissionPreset: 'danger-full-access',
          provider: '路由', model: '长模型🧑‍💻-' + 'x'.repeat(70), cwd: '/tmp/中文目录/项目', attachmentCount: 2 }, theme)
        for (const bar of [status, footer]) {
          const before = full(bar)
          const rendered = bar.render(width)
          expect(rendered).toHaveLength(1)
          expect(visibleWidth(rendered[0]!)).toBeLessThanOrEqual(width)
          if (theme === 'plain') expect(rendered[0]).not.toContain('\u001B')
          expect(full(bar)).toBe(before)
        }
      }
    }
  })

  it('reserves narrow-screen space for state, context and attachments beside a long model', () => {
    const { status } = painted({ model: 'long-model-' + 'x'.repeat(70), attachmentCount: 2 })
    const line = status.render(60)[0]!
    expect(line).toContain('Ready')
    expect(line).toContain('ctx 40%')
    expect(line).toContain('attached 2')
    expect(line).not.toContain('turns')
    expect(line).not.toContain('/tmp/work')
    expect(line).toContain('…')
  })

  it('keeps steer and cancel shortcuts ahead of exit shortcuts in a narrow running footer', () => {
    const { footer } = painted({ running: true, interactionMode: 'off', permissionPreset: 'workspace-write' })
    const text = footer.render(60)[0]!
    expect(text).toContain('workspace-write')
    expect(text).toContain('enter steer')
    expect(text).toContain('esc cancel')
    expect(text).not.toContain('ctrl+d exit')
  })

  it('does not leave separators for absent fields', () => {
    const { status, footer } = painted({ preset: undefined })
    for (const bar of [status, footer]) {
      for (const width of [32, 60, 100, 240]) {
        const text = stripVTControlCharacters(bar.render(width)[0]!)
        expect(text).not.toMatch(/^\s*·|·\s*$|·\s*·/u)
      }
    }
    expect(full(status)).not.toContain('preset')
  })
})

describe('workspacePath', () => {
  it('abbreviates the home directory only at a full path boundary', () => {
    expect(workspacePath('/Users/me/work/repo', '/Users/me')).toBe('~/work/repo')
    expect(workspacePath('/Users/me', '/Users/me')).toBe('~')
    expect(workspacePath('/Users/me-other/repo', '/Users/me')).toBe('/Users/me-other/repo')
    expect(workspacePath('/tmp/repo', '/Users/me')).toBe('/tmp/repo')
  })
})

describe('terminalWindowTitle', () => {
  it('pairs the product with the workspace directory name', () => {
    expect(terminalWindowTitle('DeepSeek Harness', '/Users/me/work/dsh-native-tui'))
      .toBe('DeepSeek Harness · dsh-native-tui')
  })

  it('ignores a trailing separator and handles a bare root', () => {
    expect(terminalWindowTitle('dsh', '/Users/me/work/repo/')).toBe('dsh · repo')
    expect(terminalWindowTitle('dsh', '/')).toBe('dsh')
    expect(terminalWindowTitle('dsh', '')).toBe('dsh')
  })

  it('keeps the last segment of a Windows path', () => {
    expect(terminalWindowTitle('dsh', 'C:\\Users\\me\\repo')).toBe('dsh · repo')
  })

  it('flattens control characters that would truncate the OSC sequence', () => {
    // BEL terminates OSC 0, so a raw one would cut the title short.
    expect(terminalWindowTitle('dsh', '/tmp/a\u0007b')).toBe('dsh · a b')
    expect(terminalWindowTitle('d\nsh', '/tmp/repo')).toBe('d sh · repo')
    expect(terminalWindowTitle('dsh', '/tmp/a' + String.fromCharCode(0x9c) + 'b')).toBe('dsh · a b')
  })

  it('bounds the workspace label', () => {
    const label = terminalWindowTitle('dsh', '/tmp/' + 'x'.repeat(80))
    expect(label).toBe('dsh · ' + 'x'.repeat(47) + '…')
  })
})

describe('splitContextLine', () => {
  it('keeps the detail tail separate from the colored head', () => {
    expect(splitContextLine('ctx 40%  (~400K / 1M · compact at 80%)'))
      .toEqual({ head: 'ctx 40%', detail: '  (~400K / 1M · compact at 80%)' })
    expect(splitContextLine('ctx —')).toEqual({ head: 'ctx —', detail: '' })
  })
})

describe('splitSessionMetrics', () => {
  it('splits the context segment from the usage segments', () => {
    expect(splitSessionMetrics('2 turns  ·  3 steps  ·  50 tok/s  ·  1.5K tok  ·  cache 89%  ·  ctx 40%  (~400K / 1M · compact at 80%)'))
      .toEqual({
        usage: '2 turns  ·  3 steps  ·  50 tok/s  ·  1.5K tok  ·  cache 89%',
        context: 'ctx 40%  (~400K / 1M · compact at 80%)',
      })
  })

  it('leaves a metric row without context intact', () => {
    expect(splitSessionMetrics('2 turns  ·  3 steps')).toEqual({ usage: '2 turns  ·  3 steps', context: undefined })
  })
})
