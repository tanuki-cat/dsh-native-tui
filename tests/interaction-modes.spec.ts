import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { apply, type InteractionModeService, type ModeExecution } from '../src/interaction-modes.js'

type Decision = { kind: string; reason?: string }
type ExecListener = (exec: ModeExecution, next: () => Promise<Decision>) => Promise<Decision>
type StepListener = (request: { agent: Agent; signal: AbortSignal }, next: () => Promise<Decision>) => Promise<Decision>
function harness() {
  const listeners = new Map<string, unknown>()
  const guards = new Set<(exec: ModeExecution) => string | undefined>()
  const cleanups: Array<() => void> = []
  const events: Array<{ type: string; data: { preset?: string; active?: boolean } }> = []
  let preset = 'accept-edits', auto = true, hasPlan = true, directPlan = true
  let planState: { active: boolean; pending?: boolean } = { active: false }
  const permissions = {
    get names() { return ['read-only', 'workspace-write', 'danger-full-access', 'manual', 'accept-edits', 'plan', ...(auto ? ['auto'] : [])] },
    defaultPreset: 'accept-edits',
    current: () => preset,
    resolve: vi.fn((mode: string) => ({ sandbox: mode === 'auto' ? 'danger-full-access' : mode === 'accept-edits' ? 'workspace-write' : 'read-only', approval: 'ask' })),
    set: vi.fn((_session: Session, next: string) => {
      if (!permissions.names.includes(next)) throw new Error('preset unavailable')
      if (preset === next) return
      preset = next
      events.push({ type: 'permission/preset', data: { preset: next } })
    }),
  }
  const plan = { get: () => planState, set: vi.fn((_agent: Agent, active: boolean) => { planState = { active } }) }
  const agent = { status: 'idle', session: { snapshotEvents: () => events }, ctx: { get: () => hasPlan && directPlan ? plan : undefined } } as unknown as Agent
  const commands = {
    list: vi.fn(() => hasPlan ? [{ name: 'plan', definitionId: '@deepseek-ai/dsh-plan-mode' }] : []),
    find: vi.fn((_agent: Agent, name: string) => hasPlan && name === 'plan'
      ? { definitionId: '@deepseek-ai/dsh-plan-mode' } : undefined),
    execute: vi.fn(async (_agent: Agent, line: string, _attachments: readonly never[], _signal: AbortSignal) => {
      events.push({ type: 'plan/mode', data: { active: line === '/plan' } })
      return { result: { kind: 'success', text: 'Plan updated' } }
    }),
  }
  let modes!: InteractionModeService
  const ctx = {
    get: (name: string) => name === 'permissionPresets' ? permissions : name === 'commands' ? commands : { guard: (guard: (exec: ModeExecution) => string | undefined) => { guards.add(guard); return () => { guards.delete(guard) } } },
    provide: (_name: string, value: InteractionModeService) => { modes = value },
    effect: (run: () => () => void) => { cleanups.push(run()) },
    on: (event: string, callback: unknown) => { listeners.set(event, callback); cleanups.push(() => { listeners.delete(event) }) },
  }
  apply(ctx as never)
  const exec = (name: string, args: unknown = {}, inner = false): ModeExecution => ({ name, arguments: args, agent, ...(inner ? { parent: {} } : {}) })
  return {
    modes, agent, permissions, plan, guards, listeners, exec, commands, events,
    get preset() { return preset },
    set preset(value: string) { preset = value },
    set auto(value: boolean) { auto = value },
    set hasPlan(value: boolean) { hasPlan = value },
    set directPlan(value: boolean) { directPlan = value },
    set planState(value: { active: boolean; pending?: boolean }) { planState = value },
    gate: (execution: ModeExecution, downstream: Decision = { kind: 'allow' }) =>
      (listeners.get('tools/pre-execute') as ExecListener)(execution, async () => downstream),
    step: (decision: Decision = { kind: 'accept' }) => (listeners.get('agent/pre-step') as StepListener)(
      { agent, signal: new AbortController().signal }, async () => decision),
    dispose: () => { for (const cleanup of cleanups.reverse()) cleanup() },
  }
}

describe('interaction modes', () => {
  it.each(['manual', 'accept-edits', 'plan'] as const)('allows native and PTC model discovery as a read in %s', async mode => {
    const h = harness()
    try {
      await h.modes.set(h.agent, mode)
      for (const inner of [false, true]) {
        const execution = h.exec('list_subagent_models', { provider: 'p', model: 'm' }, inner)
        expect(h.modes.planDenial(execution)).toBeUndefined()
        expect(await h.gate(execution)).toEqual({ kind: 'allow' })
      }
      if (mode === 'plan') {
        for (const name of ['subagent', 'write', 'edit']) expect(h.modes.planDenial(h.exec(name))).toContain('blocks tool')
        expect(h.modes.planDenial(h.exec('list_subagent_models', { sandbox_permissions: 'danger-full-access' }))).toContain('does not allow sandbox escalation')
      }
    } finally { h.dispose() }
  })

  it('starts in off mode with the native workspace default without changing permissions', async () => {
    const h = harness()
    h.permissions.defaultPreset = 'workspace-write'
    h.preset = h.permissions.defaultPreset
    expect(h.modes.current(h.agent)).toBe('off')
    await h.step()
    expect(await h.gate(h.exec('bash'))).toEqual({ kind: 'allow' })
    expect(h.permissions.set).not.toHaveBeenCalled()
  })

  it('uses the Host accept-edits identity without creating a parallel mode log', () => {
    const h = harness()
    expect(h.modes.current(h.agent)).toBe('accept-edits')
    expect(h.permissions.set).not.toHaveBeenCalled()
  })

  it.each(['manual', 'accept-edits', 'plan', 'auto'] as const)('selects %s through Host permissions and the scoped plan controller', mode => {
    const h = harness()
    h.modes.set(h.agent, mode)
    expect(h.preset).toBe(mode)
    expect(h.plan.set).toHaveBeenCalledWith(h.agent, mode === 'plan')
    expect(h.modes.current(h.agent)).toBe(mode)
  })

  it.each(['manual', 'accept-edits', 'plan', 'auto'] as const)('turns %s off with the native workspace default', async mode => {
    const h = harness()
    await h.modes.set(h.agent, mode)
    await h.modes.set(h.agent, 'off')
    expect(h.preset).toBe('workspace-write')
    expect(h.modes.current(h.agent)).toBe('off')
    expect(h.plan.set).toHaveBeenLastCalledWith(h.agent, false)
    await h.step()
    expect(h.preset).toBe('workspace-write')
  })

  it.each(['read-only', 'workspace-write', 'danger-full-access', 'custom'])('keeps native %s permissions untouched in off mode', async preset => {
    const h = harness()
    h.preset = preset
    h.planState = { active: true }
    expect(h.modes.current(h.agent)).toBe('off')
    await h.step()
    expect(h.permissions.set).not.toHaveBeenCalled()
    for (const name of ['write', 'bash', 'subagent', 'mcp__server__write', 'run_code']) {
      for (const inner of [false, true]) {
        const exec = h.exec(name, { sandbox_permissions: 'danger-full-access' }, inner)
        expect(h.modes.planDenial(exec)).toBeUndefined()
        for (const kind of ['allow', 'ask', 'deny', 'cancel']) {
          const decision = { kind, reason: 'native permission' }
          expect(await h.gate(exec, decision)).toBe(decision)
        }
      }
    }
    await h.modes.set(h.agent, 'off')
    expect(h.permissions.set).not.toHaveBeenCalled()
  })

  it('restores the latest native preset from the durable history across mode switches', async () => {
    const h = harness()
    h.permissions.set(h.agent.session, 'read-only')
    await h.modes.set(h.agent, 'manual')
    h.permissions.set(h.agent.session, 'danger-full-access')
    await h.modes.set(h.agent, 'accept-edits')
    await h.modes.set(h.agent, 'plan')
    await h.modes.set(h.agent, 'off')
    expect(h.preset).toBe('danger-full-access')
    expect(h.modes.current(h.agent)).toBe('off')
  })

  it('does not replace an unavailable native preset with broader fallback access', () => {
    const h = harness()
    h.events.push({ type: 'permission/preset', data: { preset: 'removed-native-preset' } })
    expect(() => h.modes.set(h.agent, 'off')).toThrow('preset unavailable')
    expect(h.preset).toBe('accept-edits')
  })

  it('restores off after accepted plan exit', async () => {
    const h = harness()
    await h.modes.set(h.agent, 'off')
    await h.modes.set(h.agent, 'plan')
    h.planState = { active: true, pending: false }
    await h.step()
    expect(h.preset).toBe('workspace-write')
    expect(h.modes.current(h.agent)).toBe('off')
  })

  it('uses a native profile default when no native selection has been logged', async () => {
    const h = harness()
    h.permissions.defaultPreset = 'read-only'
    await h.modes.set(h.agent, 'off')
    expect(h.preset).toBe('read-only')
  })

  it('restores the durable preset identity when the Host rejects a sandbox change', () => {
    const h = harness()
    h.permissions.set.mockImplementationOnce(() => { h.preset = 'manual'; throw new Error('terminal fence') })
    expect(() => h.modes.set(h.agent, 'manual')).toThrow('terminal fence')
    expect(h.preset).toBe('accept-edits')
    expect(h.permissions.set).toHaveBeenLastCalledWith(h.agent.session, 'accept-edits')
  })

  it('rolls back permissions if leaving plan for off fails', async () => {
    const h = harness()
    await h.modes.set(h.agent, 'plan')
    h.plan.set.mockImplementationOnce(() => { throw new Error('plan exit failed') })
    expect(() => h.modes.set(h.agent, 'off')).toThrow('plan exit failed')
    expect(h.preset).toBe('plan')
  })

  it('uses the Host command when a planning group isolates planMode from agent.ctx', async () => {
    const h = harness()
    h.directPlan = false
    await h.modes.set(h.agent, 'plan')
    expect(h.commands.execute).toHaveBeenCalledWith(h.agent, '/plan', [], expect.any(AbortSignal))
    expect(h.modes.current(h.agent)).toBe('plan')
    await h.modes.set(h.agent, 'manual')
    expect(h.commands.execute).toHaveBeenLastCalledWith(h.agent, '/plan off', [], expect.any(AbortSignal))
    expect(h.modes.current(h.agent)).toBe('manual')
  })

  it('rolls back a failed isolated Host plan command', async () => {
    const h = harness()
    h.directPlan = false
    h.commands.execute.mockResolvedValueOnce({ result: { kind: 'error', text: 'plan failed' } })
    await expect(h.modes.set(h.agent, 'plan')).rejects.toThrow('plan failed')
    expect(h.preset).toBe('accept-edits')
  })

  it('does not accept a replacement /plan command without the Host definition identity', () => {
    const h = harness()
    h.directPlan = false
    h.commands.list.mockReturnValue([{ name: 'plan', definitionId: 'unrelated-plugin' }])
    h.commands.find.mockReturnValue({ definitionId: 'unrelated-plugin' })
    expect(() => h.modes.set(h.agent, 'plan')).toThrow('unavailable')
  })

  it('does not advertise a mislabeled preset as a safe mode', () => {
    const h = harness()
    h.permissions.resolve.mockReturnValue({ sandbox: 'danger-full-access', approval: 'never' })
    expect(h.modes.current(h.agent)).toBe('custom')
    expect(h.modes.available(h.agent)).toEqual(['off'])
    expect(() => h.modes.set(h.agent, 'plan')).toThrow('unavailable')
  })

  it('does not label unrestricted access as Auto', () => {
    const h = harness()
    h.preset = 'danger-full-access'
    expect(h.modes.current(h.agent)).toBe('off')
  })

  it('refuses unavailable Auto and plan modes without changing permissions', () => {
    const h = harness()
    h.auto = false
    expect(() => h.modes.set(h.agent, 'auto')).toThrow('unavailable')
    h.hasPlan = false
    expect(() => h.modes.set(h.agent, 'plan')).toThrow('unavailable')
    expect(h.permissions.set).not.toHaveBeenCalled()
  })

  it('does not change permissions during a running turn', () => {
    const h = harness()
    Object.assign(h.agent, { status: 'running' })
    expect(() => h.modes.set(h.agent, 'auto')).toThrow('running turn')
    expect(h.permissions.set).not.toHaveBeenCalled()
  })

  it('rolls back permission selection if plan activation fails', () => {
    const h = harness()
    h.plan.set.mockImplementationOnce(() => { throw new Error('plan unavailable') })
    expect(() => h.modes.set(h.agent, 'plan')).toThrow('plan unavailable')
    expect(h.preset).toBe('accept-edits')
  })

  it.each(['read', 'read_image', 'glob', 'grep', 'web_fetch', 'skill', 'ask_user_question', 'exit_plan_mode', 'write', 'edit'])('leaves %s to the Host file sandbox or read path in accept-edits mode', async name => {
    const h = harness()
    expect(await h.gate(h.exec(name))).toEqual({ kind: 'allow' })
  })

  it.each(['manual', 'accept-edits'] as const)('asks for non-read tools in %s, including PTC inner dispatch', async mode => {
    const h = harness()
    h.modes.set(h.agent, mode)
    for (const name of ['bash', 'mcp__server__write', 'subagent']) {
      expect((await h.gate(h.exec(name))).kind).toBe('ask')
      expect((await h.gate(h.exec(name, {}, true))).kind).toBe('ask')
    }
  })

  it('never weakens a downstream denial, and lets one-shot shell approval stay with its owner', async () => {
    const h = harness()
    const denial = { kind: 'deny', reason: 'another policy' }
    expect(await h.gate(h.exec('bash'), denial)).toBe(denial)
    expect(await h.gate(h.exec('bash', { sandbox_permissions: 'workspace-write' }))).toEqual({ kind: 'allow' })
    expect((await h.gate(h.exec('mcp__fake__write', { sandbox_permissions: 'workspace-write' }))).kind).toBe('ask')
  })

  it('does not replace the Host Auto reviewer with an allow decision', async () => {
    const h = harness()
    h.modes.set(h.agent, 'auto')
    expect(await h.gate(h.exec('bash'))).toEqual({ kind: 'allow' })
    expect(await h.gate(h.exec('bash'), { kind: 'deny', reason: 'reviewer denied' })).toEqual({ kind: 'deny', reason: 'reviewer denied' })
  })

  it.each(['write', 'edit', 'bash', 'subagent', 'mcp__idea__read_file', 'working_directory'])('blocks %s in plan mode through a final guard, native and PTC', name => {
    const h = harness()
    h.modes.set(h.agent, 'plan')
    const args = name === 'working_directory' ? { cd: '/other' } : {}
    expect(h.modes.planDenial(h.exec(name, args))).toContain('Plan mode blocks')
    expect(h.modes.planDenial(h.exec(name, args, true))).toContain('Plan mode blocks')
  })

  it('keeps the PTC transport confined and rejects explicit sandbox widening in plan mode', () => {
    const h = harness()
    h.modes.set(h.agent, 'plan')
    expect(h.modes.planDenial(h.exec('run_code'))).toBeUndefined()
    expect(h.modes.planDenial(h.exec('read'))).toBeUndefined()
    expect(h.modes.planDenial(h.exec('exit_plan_mode'))).toBeUndefined()
    expect(h.modes.planDenial(h.exec('working_directory'))).toBeUndefined()
    expect(h.modes.planDenial(h.exec('run_code', { sandbox_permissions: 'danger-full-access' }))).toContain('escalation')
    h.permissions.resolve.mockReturnValue({ sandbox: 'danger-full-access', approval: 'ask' })
    expect(h.modes.planDenial(h.exec('run_code'))).toContain('read-only sandbox')
  })

  it.each(['manual', 'accept-edits', 'auto'] as const)('restores %s after accepted plan exit instead of resetting to a broader default', async before => {
    const h = harness()
    h.modes.set(h.agent, before)
    h.modes.set(h.agent, 'plan')
    h.planState = { active: true, pending: false }
    await h.step()
    expect(h.preset).toBe(before)
  })

  it('retains plan restrictions after rejection or an aborted pre-step', async () => {
    const h = harness()
    h.modes.set(h.agent, 'plan')
    h.planState = { active: true, pending: false }
    await h.step({ kind: 'reject' })
    expect(h.preset).toBe('plan')
    h.planState = { active: true }
    await h.step()
    expect(h.preset).toBe('plan')
  })

  it('reconciles an existing Host /plan selection before the next tools run', async () => {
    const h = harness()
    h.planState = { active: false, pending: true }
    expect(h.modes.current(h.agent)).toBe('plan')
    await h.step()
    expect(h.preset).toBe('plan')
  })

  it('fails closed when the previous Auto reviewer disappeared during plan mode', () => {
    const h = harness()
    h.modes.set(h.agent, 'auto')
    h.modes.set(h.agent, 'plan')
    h.auto = false
    h.planState = { active: false }
    expect(() => h.modes.reconcilePlan(h.agent)).toThrow('unavailable')
    expect(h.preset).toBe('plan')
  })

  it('re-probes the plan command once the command table changes', () => {
    const h = harness()
    h.directPlan = false
    h.hasPlan = false
    expect(h.modes.available(h.agent)).not.toContain('plan')
    h.commands.find.mockReturnValue({ definitionId: '@deepseek-ai/dsh-plan-mode' })
    // A cached verdict must never outlive the registration it described.
    expect(h.modes.available(h.agent)).not.toContain('plan')
    const invalidate = h.listeners.get('commands/change') as () => void
    invalidate()
    expect(h.modes.available(h.agent)).toContain('plan')
  })

  it('owns guard and listener registrations through the plugin context', () => {
    const h = harness()
    expect(h.guards.size).toBe(1)
    // Tool gate, pre-step plan reconciliation, and the command-table invalidation.
    expect(h.listeners.size).toBe(3)
    h.dispose()
    expect(h.guards.size).toBe(0)
    expect(h.listeners.size).toBe(0)
  })
})
