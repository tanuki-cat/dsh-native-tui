import { isDeepStrictEqual } from 'node:util'
import {
  effectiveThreshold, highestThreshold, parseThresholdPercent, planThreshold, positiveTokens, sameRoute, targetThreshold,
  type CompactionBudget, type CompactionPolicy, type ModelRoute, type ThresholdPlan,
} from '../../runtime/compaction-policy.js'
import {
  declaredCompactionPolicy, mountedCompactionPolicy, readCompactionSettings, saveCompactionThreshold, type CompactionSettings,
} from '../../runtime/compaction-settings.js'
import { showChoice, showTextInput } from '../dialogs.js'
import type { CommandContext } from './context.js'
import { contextCommand } from './context-stats.js'
import { errorMessage } from './shared.js'
import type { LLM } from './services.js'

function requestReservation(ctx: CommandContext, route: ModelRoute, fallback: number): number {
  const header = ctx.active.agent.session.requestHeader()?.config
  return (sameRoute(route, header) ? header?.maxTokens : undefined) ?? fallback
}

const number = (value: number): string => value.toLocaleString('en-US')

function thresholdLabel(tokens: number | undefined, window: number): string {
  if (tokens === undefined) return 'unknown'
  return String(Math.round(tokens / window * 1000) / 10) + '% (' + number(tokens) + ' tokens)'
}

function policyLabel(policy: CompactionPolicy | undefined, budget: CompactionBudget): string {
  if (policy === undefined) return 'unknown'
  if (!policy.auto) return 'automatic compaction disabled'
  return thresholdLabel(effectiveThreshold(policy, budget), budget.window)
}

async function chooseThreshold(
  ctx: CommandContext, args: string, route: string, preset: string, budget: CompactionBudget,
  current: CompactionPolicy | undefined, baseline: CompactionPolicy,
): Promise<ThresholdPlan | undefined> {
  let input: string | undefined = args === '' ? undefined : args
  while (!ctx.signal.aborted) {
    if (input === undefined) {
      input = await showTextInput(ctx.tui, ctx.palette,
        'Compaction threshold · ' + route + '\nPreset ' + preset + ' · active ' + policyLabel(current, budget)
          + (isDeepStrictEqual(current, baseline) ? '' : '\nSaved ' + policyLabel(baseline, budget)),
        '1–100%', 'Enter a whole percentage · Esc cancels', ctx.signal,
        String(Math.round(baseline.ratio * 100)))
      if (input === undefined) return undefined
    }
    const requested = parseThresholdPercent(input)
    if (requested === undefined) {
      ctx.notice('warning', 'Enter a whole percentage from 1 to 100. Usage: /context threshold [percent]')
      return undefined
    }
    const candidate = planThreshold(requested, budget, baseline)
    if (candidate !== undefined) return candidate
    const ceiling = budget.window - budget.reserved
    if (targetThreshold(requested, budget) <= ceiling) {
      ctx.notice('warning', 'The threshold must leave a positive budget above the preset’s retained history.')
      return undefined
    }
    const suggestion = highestThreshold(requested, budget, baseline)
    const reason = requested + '% needs ' + number(targetThreshold(requested, budget)) + ' tokens.\n'
      + number(budget.reserved) + ' tokens reserved for output · ' + number(Math.max(0, ceiling)) + ' available before headroom.'
    const choice = await showChoice(ctx.tui, ctx.palette, reason, [
      ...(suggestion === undefined ? [] : [{ value: 'use', label: 'Use ' + suggestion.percent + '%',
        description: number(suggestion.tokens) + ' tokens · ' + number(suggestion.policy.headroom) + ' headroom' }]),
      { value: 'retry', label: 'Enter another percentage' },
      { value: 'cancel', label: 'Cancel' },
    ], suggestion === undefined ? 'No valid percentage under the current policy · Esc cancels'
      : 'Highest valid percentage · Review before saving', ctx.signal)
    if (choice === 'use') return suggestion
    if (choice !== 'retry') return undefined
    input = undefined
  }
  return undefined
}

async function reviewThreshold(
  ctx: CommandContext, llm: LLM, route: ModelRoute, preset: string, budget: CompactionBudget,
  current: CompactionPolicy | undefined, baseline: CompactionPolicy, initial: ThresholdPlan,
): Promise<ThresholdPlan | undefined> {
  let plan = initial
  while (!ctx.signal.aborted) {
    const title = [
      'Compaction threshold · ' + route.provider + '/' + route.model + ' · ' + preset,
      number(budget.window) + ' window · ' + number(budget.reserved) + ' reserved output',
      'Active ' + policyLabel(current, budget) + (isDeepStrictEqual(current, baseline) ? '' : ' · saved ' + policyLabel(baseline, budget)),
      'New ' + plan.percent + '% · ' + number(plan.tokens) + ' tokens' + (!plan.policy.auto ? ' · automatic compaction disabled' : ''),
      'Headroom ' + number(baseline.headroom) + ' → ' + number(plan.policy.headroom)
        + ' · summary output ' + number(baseline.summaryMax) + ' → ' + number(plan.policy.summaryMax),
      'Applies when switching to this model.',
      'Saving writes the preset configuration to this profile.',
      'On bundle upgrades, carry this policy into the updated preset.',
    ].join('\n')
    const choice = await showChoice(ctx.tui, ctx.palette, title, [
      { value: 'save', label: 'Save threshold' },
      { value: 'summary', label: 'Edit summary output limit' },
      { value: 'cancel', label: 'Cancel' },
    ], 'Enter selects · Esc cancels', ctx.signal, () => 14)
    if (choice === 'save') return plan
    if (choice !== 'summary') return undefined
    const text = await showTextInput(ctx.tui, ctx.palette, 'Summary output limit', 'tokens',
      'Applies to automatic summaries, /compact and overflow recovery · Esc returns', ctx.signal, String(plan.policy.summaryMax))
    if (text === undefined) continue
    const cap = /^\d+$/u.test(text) ? Number(text) : Number.NaN
    if (!positiveTokens(cap)) {
      ctx.notice('warning', 'The summary output limit must be a positive whole number of tokens.')
      continue
    }
    const summaryRoute = baseline.summaryRoute ?? route
    let window: number | undefined
    try {
      window = sameRoute(summaryRoute, route) ? budget.window
        : (await llm.resolveModelInfo(summaryRoute.provider, summaryRoute.model)).context?.contextWindow
    } catch (error) {
      if (ctx.signal.aborted) return undefined
      ctx.notice('warning', 'Could not read the summary model window for ' + summaryRoute.provider + '/'
        + summaryRoute.model + ': ' + errorMessage(error))
      continue
    }
    if (window !== undefined && cap > window) {
      ctx.notice('warning', 'The summary output limit exceeds the summary model’s ' + number(window) + '-token window.')
      continue
    }
    const edited = planThreshold(plan.percent, budget, baseline, cap)
    if (edited === undefined) {
      ctx.notice('warning', 'Could not apply the summary output limit. The previous limit is still selected.')
      continue
    }
    plan = edited
  }
  return undefined
}

export async function contextThresholdCommand(ctx: CommandContext, args: string): Promise<void> {
  const llm = ctx.host.get('llm') as LLM | undefined
  const route = ctx.modelSelection.current
  if (route === undefined || llm === undefined) {
    ctx.notice('warning', 'Select a model before editing its compaction threshold.')
    return
  }
  let settings: CompactionSettings
  let baseline: CompactionPolicy
  try {
    settings = readCompactionSettings(ctx.host, ctx.active.agent)
    baseline = declaredCompactionPolicy(settings, route)
  } catch (error) {
    ctx.notice('warning', 'Compaction threshold is read-only: ' + errorMessage(error))
    contextCommand(ctx)
    return
  }
  const isCurrent = (): boolean => !ctx.signal.aborted && ctx.isCurrent?.() !== false && sameRoute(route, ctx.modelSelection.current)
    && settings.registry.composedPreset(ctx.active.agent.ctx) === settings.preset
  const readBudget = async (): Promise<{ budget: CompactionBudget; fallback: number }> => {
    const info = await llm.resolveModelInfo(route.provider, route.model)
    const window = info.context?.contextWindow
    if (window === undefined || !positiveTokens(window)) throw new Error('The selected model has no known context window.')
    const fallback = info.defaultMaxTokens ?? 0
    const reserved = requestReservation(ctx, route, fallback)
    if (!Number.isSafeInteger(reserved) || reserved < 0) throw new Error('The selected model has an invalid output reservation.')
    return { budget: { window, reserved }, fallback }
  }
  const { budget } = await readBudget()
  if (!isCurrent()) return
  const current = mountedCompactionPolicy(ctx.host, ctx.active.agent, route)
  const label = route.provider + '/' + route.model
  const initial = await chooseThreshold(ctx, args, label, settings.preset, budget, current, baseline)
  if (initial === undefined || !isCurrent()) return
  const plan = await reviewThreshold(ctx, llm, route, settings.preset, budget, current, baseline, initial)
  if (plan === undefined || !isCurrent()) return
  const refreshed = await readBudget()
  if (!isDeepStrictEqual(refreshed.budget, budget)) throw new Error('Model budget changed. Reopen the threshold preview.')
  const saved = await saveCompactionThreshold(settings, route, budget, baseline, plan,
    () => isCurrent() && requestReservation(ctx, route, refreshed.fallback) === budget.reserved)
  if (ctx.isCurrent?.() === false) return
  const mounted = mountedCompactionPolicy(ctx.host, ctx.active.agent, route)
  const active = isDeepStrictEqual(mounted, plan.policy)
  ctx.notice('info', (saved ? 'Saved ' : 'Already saved ') + plan.percent + '% threshold for ' + label + ' in ' + settings.preset
    + (active ? '. Active in this session.' : '. Run /reload when idle to apply it to this session.'))
  ctx.renderStatus()
}
