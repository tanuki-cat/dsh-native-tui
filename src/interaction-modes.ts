/**
 * Terminal interaction modes reuse the Host's durable permission identities.
 * Plan guidance and tool/file enforcement remain separate: the scoped plan
 * controller owns user review, while this plugin gates mediated tool calls.
 * PTC outer programs are transports, not a complete side-effect audit boundary.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'

export const name = 'interaction-modes'
export const inject = ['permissionPresets', 'tools', 'commands']
export const INTERACTION_MODES = ['manual', 'accept-edits', 'plan', 'auto', 'off'] as const
export type InteractionMode = typeof INTERACTION_MODES[number]
export const MODE_LABELS: Record<InteractionMode, string> = {
  manual: 'manual mode', 'accept-edits': 'accept edits', plan: 'plan mode', auto: 'auto mode', off: 'off',
}
export const MODE_DESCRIPTIONS: Record<InteractionMode, string> = {
  off: 'Use native DSH permissions without TUI mode restrictions or Auto review',
  manual: 'Read-only files; edits require a one-shot sandbox approval; other actions ask',
  'accept-edits': 'Workspace edits run without prompts; other non-read tools ask',
  plan: 'Read-only planning; review the plan before implementation',
  auto: 'Experimental per-call model review with Full access; denials ask you',
}

interface Permissions {
  readonly names: readonly string[]
  readonly defaultPreset: string
  current(session: Session): string
  resolve(name: string): { sandbox: string; approval: string }
  set(session: Session, name: string): void
}
interface PlanController {
  get(agent: Agent): { active: boolean; pending?: boolean }
  set(agent: Agent, active: boolean): unknown
}
export interface ModeExecution {
  readonly name: string
  readonly arguments: unknown
  readonly agent?: Agent
  readonly parent?: unknown
}
type Decision = { kind: 'allow' | 'cancel' } | { kind: 'deny' | 'ask'; reason?: string }
interface Commands {
  list(agent: Agent): readonly { name: string; definitionId?: string }[]
  /** Resolve one command definition without materializing and sorting the table. */
  find?(agent: Agent, name: string): { readonly definitionId?: unknown } | undefined
  execute(agent: Agent, line: string, attachments: readonly never[], signal: AbortSignal): Promise<{ result: { kind: string; text?: string } } | undefined>
}
interface ModeTools { guard(check: (exec: ModeExecution) => string | undefined): () => void }
interface ModeEvents {
  on(event: 'tools/pre-execute', listener: (exec: ModeExecution, next: () => Promise<Decision>) => Promise<Decision>): () => void
  on(event: 'agent/pre-step', listener: (request: { agent: Agent; signal: AbortSignal }, next: () => Promise<{ kind: string }>) => Promise<{ kind: string }>): () => void
  on(event: 'commands/change', listener: () => void): () => void
}

/** Identity the Host plan-mode plugin registers its `/plan` command under. */
const PLAN_COMMAND_ID = '@deepseek-ai/dsh-plan-mode'

const READ_TOOLS = new Set([
  'read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'skill',
  'ask_user_question', 'exit_plan_mode', 'get_goal', 'job_list', 'job_output',
  'list_agents', 'list_subagent_models', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  // Waiting on a child and reading the shared task board mutate nothing.
  'wait_agent', 'team_task_list', 'team_task_get',
])
const FILE_EDITS = new Set(['write', 'edit'])
function argsOf(exec: ModeExecution): Record<string, unknown> {
  return exec.arguments !== null && typeof exec.arguments === 'object'
    ? exec.arguments as Record<string, unknown> : {}
}
function isRead(exec: ModeExecution): boolean {
  return READ_TOOLS.has(exec.name) || (exec.name === 'working_directory' && argsOf(exec).cd === undefined)
}
function isTransport(exec: ModeExecution): boolean {
  return exec.name === 'run_code' && exec.parent === undefined
}
export function isInteractionMode(value: string): value is InteractionMode {
  return INTERACTION_MODES.includes(value as InteractionMode)
}

declare module '@deepseek-ai/cordis' {
  interface Context { interactionModes: InteractionModeService }
}

export function apply(ctx: Context): void {
  ctx.provide('interactionModes', new InteractionModeService(ctx))
}

export class InteractionModeService {
  private readonly permissions: Permissions
  private readonly commands: Commands | undefined
  /**
   * Whether a plan command exists, per agent.
   *
   * `current()` runs on every status repaint and every guarded tool call, and a
   * composition without the Host plan-mode service can only answer by looking
   * the command up. The verdict is thrown away whenever the command table
   * changes — the Host emits `commands/change` when a definition is registered
   * and when its layer is disposed — so an unregistered or newly registered
   * command is never frozen in. The list-based fallback below is a shape
   * compatibility branch, not a second invalidation path.
   */
  private planCommands = new WeakMap<Agent, boolean>()

  constructor(ctx: Context) {
    this.permissions = ctx.get('permissionPresets') as Permissions
    this.commands = ctx.get('commands') as Commands | undefined
    const events = ctx as unknown as ModeEvents
    const tools = ctx.get('tools') as ModeTools
    ctx.effect(() => tools.guard(exec => this.planDenial(exec)))
    events.on('commands/change', () => { this.planCommands = new WeakMap() })
    events.on('tools/pre-execute', async (exec, next) => {
      const downstream = await next()
      if (downstream.kind !== 'allow' || exec.agent === undefined || isTransport(exec)) return downstream
      const mode = this.current(exec.agent)
      if (mode !== 'manual' && mode !== 'accept-edits') return downstream
      if (isRead(exec) || FILE_EDITS.has(exec.name)) return downstream
      // First-party sandbox retries own their exact one-shot approval.
      if ((exec.name === 'bash' || exec.name === 'pwsh') && argsOf(exec).sandbox_permissions !== undefined) return downstream
      return { kind: 'ask', reason: MODE_LABELS[mode] + ': approve tool "' + exec.name + '" for this call.' }
    })
    events.on('agent/pre-step', async (request, next) => {
      const decision = await next()
      if (decision.kind !== 'reject' && !request.signal.aborted) this.reconcilePlan(request.agent)
      return decision
    })
  }

  private plan(agent: Agent): PlanController | undefined {
    try {
      const direct = agent.ctx.get('planMode') as PlanController | undefined
      if (direct !== undefined) return direct
    }
    catch { /* A nested preset can isolate the service from agent.ctx. */ }
    if (!this.hasPlanCommand(agent)) return undefined
    const commands = this.commands!
    const get = (): { active: boolean } => {
      const event = agent.session.snapshotEvents().findLast(event => (event.type as string) === 'plan/mode')
      return { active: (event?.data as { active?: unknown } | undefined)?.active === true }
    }
    return {
      get,
      set: (_agent, active) => {
        if (get().active === active) return
        return commands.execute(agent, active ? '/plan' : '/plan off', [], new AbortController().signal).then(execution => {
          if (execution?.result.kind !== 'success') throw new Error(execution?.result.text ?? 'The Host plan command is unavailable.')
          if (get().active !== active) throw new Error('The plan selection did not commit; wait for the session to become idle.')
        })
      },
    }
  }

  /**
   * Whether the Host plan-mode plugin registered `/plan` for this agent.
   * @param agent - agent whose scoped command table is consulted.
   * @returns true when the durable plan selection can be driven through it.
   */
  private hasPlanCommand(agent: Agent): boolean {
    const cached = this.planCommands.get(agent)
    if (cached !== undefined) return cached
    let available = false
    try {
      const found = this.commands?.find?.(agent, 'plan')
      available = found === undefined
        // A composition without the lookup helper still answers, at list cost.
        ? this.commands?.list?.(agent).some(command => command.name === 'plan' && command.definitionId === PLAN_COMMAND_ID) === true
        : found.definitionId === PLAN_COMMAND_ID
    }
    catch {
      available = false
    }
    this.planCommands.set(agent, available)
    return available
  }

  current(agent: Agent): InteractionMode | 'custom' {
    const preset = this.permissions.current(agent.session)
    if (!isInteractionMode(preset) || preset === 'off') return 'off'
    const plan = this.plan(agent)?.get(agent)
    if (plan?.pending ?? plan?.active ?? false) return 'plan'
    return this.configured(preset) ? preset : 'custom'
  }

  private configured(mode: InteractionMode): boolean {
    if (mode === 'off') return true
    if (!this.permissions.names.includes(mode)) return false
    const spec = this.permissions.resolve(mode)
    const sandbox = mode === 'auto' ? 'danger-full-access' : mode === 'accept-edits' ? 'workspace-write' : 'read-only'
    return spec.sandbox === sandbox && spec.approval === 'ask'
  }

  available(agent: Agent): readonly InteractionMode[] {
    return INTERACTION_MODES.filter(mode => this.configured(mode)
      && (mode !== 'plan' || this.plan(agent) !== undefined))
  }

  /** Switch only between turns, preserving failed or unavailable selections. */
  set(agent: Agent, mode: InteractionMode): void | Promise<void> {
    if (agent.status === 'running') throw new Error('Wait for the running turn to finish or cancel it before changing mode.')
    if (!this.available(agent).includes(mode)) throw new Error('Mode "' + mode + '" is unavailable in this profile.')
    const plan = this.plan(agent)
    const previous = this.permissions.current(agent.session)
    const target = mode === 'off' ? this.nativePreset(agent) : mode
    const rollback = (error: unknown): never => {
      if (target !== previous) this.permissions.set(agent.session, previous)
      throw error
    }
    try {
      if (target !== previous) this.permissions.set(agent.session, target)
      const changed = plan?.set(agent, mode === 'plan')
      if (changed instanceof Promise) return changed.catch(rollback)
    }
    catch (error) { rollback(error) }
  }

  private nativePreset(agent: Agent): string {
    const current = this.permissions.current(agent.session)
    if (!isInteractionMode(current)) return current
    const events = agent.session.snapshotEvents()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!
      if ((event.type as string) !== 'permission/preset') continue
      const preset = (event.data as { preset?: unknown }).preset
      if (typeof preset === 'string' && !isInteractionMode(preset)) return preset
    }
    const fallback = this.permissions.defaultPreset
    return isInteractionMode(fallback) ? 'workspace-write' : fallback
  }

  private beforePlan(agent: Agent): string {
    const events = agent.session.snapshotEvents()
    let reachedPlan = false
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!
      if ((event.type as string) !== 'permission/preset') continue
      const preset = (event.data as { preset?: unknown }).preset
      if (preset === 'plan') { reachedPlan = true; continue }
      if (reachedPlan && typeof preset === 'string') return preset
    }
    return 'accept-edits'
  }

  /** Called at an accepted pre-step, not from the non-reentrant append feed. */
  reconcilePlan(agent: Agent): void {
    if (this.current(agent) === 'off') return
    const plan = this.plan(agent)?.get(agent)
    if (plan === undefined) return
    const wanted = plan.pending ?? plan.active
    const preset = this.permissions.current(agent.session)
    if (wanted && preset !== 'plan') this.permissions.set(agent.session, 'plan')
    else if (!wanted && preset === 'plan') this.permissions.set(agent.session, this.beforePlan(agent))
  }

  /** A monotonic final guard covers native tools and PTC inner dispatch alike. */
  planDenial(exec: ModeExecution): string | undefined {
    if (exec.agent === undefined || this.current(exec.agent) !== 'plan') return undefined
    if (argsOf(exec).sandbox_permissions !== undefined) return 'Plan mode does not allow sandbox escalation. Finish plan review or switch mode first.'
    if (isTransport(exec)) {
      if (this.permissions.current(exec.agent.session) !== 'plan' || !this.configured('plan')) return 'Plan mode requires its read-only sandbox before starting a PTC program.'
      return undefined
    }
    if (isRead(exec)) return undefined
    return 'Plan mode blocks tool "' + exec.name + '". Use read/search tools and exit_plan_mode for review.'
  }
}
