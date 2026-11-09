import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandContext } from '../src/ui/commands/context.js'
import { diffCommand, toolCommand, toolsCommand } from '../src/ui/commands/tools.js'
import { showTextPager } from '../src/ui/dialogs.js'
import { createPalette } from '../src/ui/theme.js'

vi.mock('../src/ui/dialogs.js', () => ({ showTextPager: vi.fn(async () => {}) }))

function context(events: readonly unknown[]) {
  const notice = vi.fn()
  return { palette: createPalette('plain'), tui: {}, notice,
    active: { agent: { session: { snapshotEvents: () => events } } },
  } as unknown as CommandContext & { notice: typeof notice }
}

function nested(index: number) {
  return { type: 'tool/ptc-dispatch', data: { subCallId: 'nested-' + index, name: 'write',
    arguments: { file_path: 'file-' + index + '.ts', content: 'new-' + index },
    content: [{ type: 'text', text: 'Updated file' }],
    meta: { diffs: [{ path: 'file-' + index + '.ts', oldText: 'old-' + index, newText: 'new-' + index }] },
  } }
}

beforeEach(() => vi.clearAllMocks())

describe('tool inspection commands', () => {
  it('opens the latest nested PTC diff', async () => {
    const ctx = context([nested(0), nested(1)])
    await diffCommand(ctx, '')
    const text = vi.mocked(showTextPager).mock.calls[0]?.[3]
    expect(text).toContain('nested-1')
    expect(text).toContain('- old-1')
    expect(text).toContain('+ new-1')
    expect(text).not.toContain('old-0')
    expect(ctx.notice).not.toHaveBeenCalled()
  })

  it('uses the same retained indices for /tools, /tool and /diff', async () => {
    const ctx = context(Array.from({ length: 55 }, (_, index) => nested(index)))
    toolsCommand(ctx)
    expect(ctx.notice.mock.calls[0]?.[1]).toContain('49. write')
    await toolCommand(ctx, '0')
    await diffCommand(ctx, '0')
    const calls = vi.mocked(showTextPager).mock.calls
    expect(calls[0]?.[3]).toContain('nested-5')
    expect(calls[1]?.[3]).toContain('nested-5')
    expect(calls[1]?.[3]).toContain('- old-5')
  })

  it('keeps the no-diff notice when dispatch results have no diff metadata', async () => {
    const item = nested(0)
    const ctx = context([{ ...item, data: { ...item.data, meta: { diffs: [] } } }])
    await diffCommand(ctx, '')
    expect(ctx.notice).toHaveBeenCalledWith('info', 'No file diffs recorded in this session yet.')
    expect(showTextPager).not.toHaveBeenCalled()
  })
})
