import { beforeEach, expect, it, vi } from 'vitest'
import type { CommandContext } from '../src/ui/commands/context.js'
import { contextThresholdCommand } from '../src/ui/commands/context-threshold.js'

const dialogs = vi.hoisted(() => ({ showChoice: vi.fn(), showTextInput: vi.fn() }))
vi.mock('../src/ui/dialogs.js', () => dialogs)

const route = { provider: 'local', model: 'qwen' }
const policy = { summarizationProvider: 'summary', summarizationModel: 'small' }

function harness(uneditable?: 'profile' | 'compactor' | 'preset') {
  const notice = vi.fn()
  const edit = vi.fn()
  const metrics = { turns: 1, steps: 2, totalTokens: 50_000, contextPercent: 34 }
  const resolveModelInfo = vi.fn(async (_provider: string, _model: string) => ({
    context: { contextWindow: 147_456 }, defaultMaxTokens: 32_768,
  }))
  const loadedConfig = { ...policy, auto: true, thresholdRatio: 0.8, headroomTokens: 65_536, modelPolicies: [] }
  const entries = [{
    options: {
      name: '@deepseek-ai/dsh-agent-preset',
      config: { id: 'ptc', plugins: [{ name: '@deepseek-ai/dsh-compaction-basic', config: policy }] },
    },
  }]
  const services: Record<string, unknown> = {
    llm: { resolveModelInfo },
    agentPresets: {
      composedPreset: () => 'ptc',
      serviceFor: () => ({ config: uneditable === 'compactor' ? {} : loadedConfig }),
    },
    configEditor: uneditable === 'profile' ? undefined : { edit, entries: () => uneditable === 'preset' ? [] : entries },
  }
  const ctx = {
    host: { get: (name: string) => services[name] },
    active: { agent: { ctx: {}, session: { requestHeader: () => undefined } } },
    modelSelection: { current: route },
    signal: new AbortController().signal,
    readContext: () => ({ metrics, breakdown: undefined }),
    notice,
  } as unknown as CommandContext
  return { ctx, edit, metrics, notice, resolveModelInfo }
}

beforeEach(() => vi.resetAllMocks())

it('keeps the preview open when summary model discovery fails and lets the user retry', async () => {
  const h = harness()
  h.resolveModelInfo.mockImplementationOnce(async () => ({ context: { contextWindow: 147_456 }, defaultMaxTokens: 32_768 }))
    .mockRejectedValueOnce(new Error('Offline'))
  dialogs.showChoice.mockResolvedValueOnce('summary').mockResolvedValueOnce('summary').mockResolvedValueOnce('cancel')
  dialogs.showTextInput.mockResolvedValue('7000')

  await contextThresholdCommand(h.ctx, '75')

  expect(h.resolveModelInfo).toHaveBeenCalledWith('summary', 'small')
  expect(h.notice).toHaveBeenCalledExactlyOnceWith('warning', 'Could not read the summary model window for summary/small: Offline')
  expect(dialogs.showChoice.mock.calls[1]?.[2]).toContain('summary output 65,536 → 65,536')
  expect(dialogs.showChoice.mock.calls[2]?.[2]).toContain('summary output 65,536 → 7,000')
  expect(h.edit).not.toHaveBeenCalled()
})

it.each([
  ['profile', 'need an editable Host profile'],
  ['compactor', 'no supported compaction policy service'],
  ['preset', 'no unique editable profile declaration'],
] as const)('reports the reason and current context when the %s is uneditable', async (reason, message) => {
  const h = harness(reason)

  await contextThresholdCommand(h.ctx, '75')

  expect(h.notice).toHaveBeenNthCalledWith(1, 'warning', expect.stringContaining(message))
  expect(h.notice).toHaveBeenNthCalledWith(2, 'info', expect.stringContaining('Context used: 34%'), {
    metrics: h.metrics, breakdown: undefined,
  })
  expect(dialogs.showChoice).not.toHaveBeenCalled()
  expect(h.edit).not.toHaveBeenCalled()
})
