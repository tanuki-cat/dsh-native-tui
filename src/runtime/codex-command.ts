/**
 * `/codex` command semantics: status, route setup, sign-in, sign-out, models.
 *
 * The terminal owns notices, prompts and confirmation; this module owns the
 * wording and the state transitions, so the same behaviour is unit-testable
 * with stub seams.
 *
 * @module dsh-native-tui/runtime/codex-command
 */

import { credentialState, grantOf, readCodexAccount } from '../codex/account.js'
import { loginCodex } from '../codex/login.js'
import { logoutCodex } from '../codex/logout.js'
import {
  countCodexModels,
  ensureCodexRoute,
  removeApiKeyEnvReference,
  removeCodexRoute,
  routeProfile,
} from '../codex/route.js'
import {
  CODEX_KEY,
  CODEX_PROVIDER,
  type AuthorizationLike,
  type CodexAccount,
  type CommandChoice,
  type CredentialState,
  type CredentialStoreLike,
  type ModelCatalog,
  type NoticeTone,
} from '../codex/types.js'
import {
  fetchCodexUsage,
  type UsageReason,
  type UsageSnapshot,
  type UsageWindow,
  type UsageWindowReason,
} from '../codex/usage.js'
import type { SettingsAccess } from './settings-write.js'
import { redact } from '../codebuddy/errors.js'

/** Everything the command needs from the terminal and the Host. */
export interface CodexCommandDeps {
  readonly authorization?: AuthorizationLike
  readonly credentials?: CredentialStoreLike
  readonly settings?: SettingsAccess
  readonly llm?: ModelCatalog
  readonly modelSelection?: { readonly current?: { readonly provider: string; readonly model?: string } }
  readonly notice: (level: NoticeTone, text: string) => void
  readonly choose: (title: string, items: readonly CommandChoice[], hint: string, signal: AbortSignal) => Promise<string | undefined>
  readonly ask: (message: string, placeholder: string | undefined, secret: boolean, signal: AbortSignal) => Promise<string | undefined>
  readonly openUrl?: (url: string) => boolean
  readonly signal: AbortSignal
  readonly now?: () => number
  readonly wait?: (ms: number) => Promise<void>
  readonly formatTime?: (ms: number) => string
  /** Transport for the usage request; the global fetch is used when omitted. */
  readonly fetcher?: typeof fetch
  /** Usage request budget in ms; defaults to 10s. */
  readonly timeoutMs?: number
}

/** Short usage text for the command. */
export const CODEX_USAGE = [
  'Usage: /codex [status|setup|login [browser|device]|logout|models|help]',
  '  status   sign-in state, credential expiry, route, model count and usage',
  '  setup    ensure the openai-codex route without signing in',
  '  login    open the ChatGPT sign-in (browser or device code)',
  '  logout   remove the shared credential after confirmation',
  '  models   list openai-codex models',
].join('\n')

/** Human label for one account, without the token. */
function accountLabel(account: CodexAccount | undefined): string {
  const name = account?.name ?? account?.email
  if (name === undefined) return 'unknown account'
  return account?.plan === undefined ? name : name + ' (' + account.plan + ')'
}

/** The credential state as one display line. */
function stateLine(state: CredentialState, account: CodexAccount | undefined, formatTime: (ms: number) => string): string {
  switch (state.kind) {
    case 'absent':
      return 'Codex: not signed in — run /codex login'
    case 'incomplete':
      return 'Codex: credential incomplete — sign in again'
    case 'expired-refreshable':
      return 'Codex: credential expired; pi-ai refreshes it on the next openai-codex request'
    case 'expired':
      return 'Codex: credential expired — sign in again'
    case 'valid': {
      const expires = account?.expires ?? state.grant.expires
      const suffix = typeof expires === 'number' ? ' · credential valid until ' + formatTime(expires) : ''
      return 'Codex: signed in as ' + accountLabel(account) + suffix
    }
  }
}

/** One sentence describing the route, without writing anything. */
async function routeLine(deps: CodexCommandDeps): Promise<string> {
  const profile = routeProfile(deps.settings)
  switch (profile.kind) {
    case 'unavailable':
      return 'route openai-codex: settings namespace unavailable'
    case 'missing':
      return 'route openai-codex: missing — run /codex setup'
    case 'blocked':
      return 'route openai-codex: names credential reference ' + String(profile.apiKeyEnv) + '; OAuth is not used'
    case 'present': {
      const result = await countCodexModels(deps.llm)
      if (result.error !== undefined) return 'route openai-codex: catalogue unavailable — ' + result.error
      if (result.count === 0) return 'route openai-codex: no models listed'
      return 'route openai-codex: ' + String(result.count) + ' models'
    }
  }
}

/** Cells in the remaining-quota bar. */
const USAGE_BAR_WIDTH = 10

/** One percentage with at most one decimal, so 88.25 reads as 88.3%. */
function percentText(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)) + '%'
}

/** A bar whose filled cells follow the remaining quota. */
function usageBar(remainingPercent: number): string {
  const filled = Math.max(0, Math.min(USAGE_BAR_WIDTH, Math.round(remainingPercent / (100 / USAGE_BAR_WIDTH))))
  return '█'.repeat(filled) + '░'.repeat(USAGE_BAR_WIDTH - filled)
}

/** Why one window is not shown as a bar. */
function windowReasonText(reason: UsageWindowReason | undefined): string {
  switch (reason) {
    case 'expired':
      return 'already reset; run /codex status again'
    case 'invalid-response':
      return 'reported in an unreadable shape'
    case 'not-returned':
    case undefined:
      return 'not reported by the service'
  }
}

/** One quota window as an aligned line. */
function usageWindowLine(
  label: string,
  window: UsageWindow | undefined,
  reason: UsageWindowReason | undefined,
  formatTime: (ms: number) => string,
): string {
  const prefix = '  ' + label.padEnd(12) + '  '
  if (window === undefined) return prefix + windowReasonText(reason)
  const reset = window.resetsAt === undefined ? 'reset time unknown' : 'resets ' + formatTime(window.resetsAt)
  return prefix + '[' + usageBar(window.remainingPercent) + '] '
    + percentText(window.remainingPercent) + ' left · '
    + percentText(window.usedPercent) + ' used · ' + reset
}

/** The two quota windows plus any account-wide restriction. */
function usageLines(usage: UsageSnapshot, formatTime: (ms: number) => string): string[] {
  const lines = [
    usageWindowLine('5-hour limit', usage.fiveHour, usage.fiveHourReason, formatTime),
    usageWindowLine('weekly limit', usage.weekly, usage.weeklyReason, formatTime),
  ]
  if (usage.allowed === false) lines.push('  account: usage is currently disallowed; calls may fail until the window resets')
  return lines
}

/** Why the usage block is missing. */
function usageReasonText(reason: UsageReason): string {
  switch (reason) {
    case 'cancelled':
      return 'the request was cancelled'
    case 'credential-expired':
      return 'the credential expired; run /codex login'
    case 'permission-denied':
      return 'this account cannot read usage (403)'
    case 'rate-limited':
      return 'the usage service rate-limited the request'
    case 'network-error':
      return 'the request failed'
    case 'timeout':
      return 'the request timed out'
    case 'invalid-response':
      return 'the service returned an unexpected response'
    case 'account-changed':
      return 'the stored account changed; run /codex status again'
  }
}

/** Usage lines for the current credential, or the reason they are absent. */
async function statusUsage(
  deps: CodexCommandDeps,
  state: CredentialState,
  account: CodexAccount | undefined,
  formatTime: (ms: number) => string,
): Promise<string[]> {
  if (state.kind === 'expired-refreshable') {
    return ['  usage: unavailable — the credential expired; pi-ai refreshes it on the next openai-codex request']
  }
  if (state.kind !== 'valid') return []
  const access = state.grant.access
  if (access === undefined || access === '') return []
  const accountId = account?.accountId
  if (accountId === undefined) {
    return ['  usage: unavailable — sign in again so the account id is recorded']
  }
  const result = await fetchCodexUsage({
    access,
    accountId,
    signal: deps.signal,
    ...(deps.fetcher === undefined ? {} : { fetcher: deps.fetcher }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
  })
  if (result.kind === 'ok') return usageLines(result.usage, formatTime)
  if (result.reason === 'cancelled') return []
  return ['  usage: unavailable — ' + usageReasonText(result.reason)]
}

/** `/codex status`. */
async function status(deps: CodexCommandDeps): Promise<void> {
  if (deps.credentials === undefined) {
    deps.notice('warning', 'The credential store is unavailable in this profile.')
    return
  }
  const formatTime = deps.formatTime ?? ((ms: number) => new Date(ms).toISOString())
  const record = await deps.credentials.readRecord(CODEX_KEY)
  const state = credentialState(record, deps.now?.() ?? Date.now())
  const account = state.kind === 'valid' || state.kind === 'expired-refreshable' || state.kind === 'expired'
    ? readCodexAccount(state.grant)
    : undefined
  const lines = [stateLine(state, account, formatTime)]
  const entry = deps.authorization?.describe(CODEX_KEY)
  if (deps.authorization === undefined) lines.push('  sign-in flow: authorization service unavailable')
  else if (entry === undefined) lines.push('  sign-in flow: openai-codex not registered (mount llm-pi-ai)')
  else if (entry.inFlight) lines.push('  sign-in in progress (started by this process)')
  const [route, usage] = await Promise.all([
    routeLine(deps),
    statusUsage(deps, state, account, formatTime),
  ])
  lines.push('  ' + route, ...usage)
  deps.notice('info', lines.join('\n'))
}

/** Confirm one destructive or configuration-changing step. */
async function confirm(deps: CodexCommandDeps, title: string, yes: string, description: string): Promise<boolean> {
  const picked = await deps.choose(title, [
    { value: 'yes', label: yes, description },
    { value: 'no', label: 'Cancel' },
  ], 'Enter selects · Esc cancels', deps.signal)
  return picked === 'yes'
}

/** Ask whether the route added by this command should be undone. */
async function offerUndo(deps: CodexCommandDeps, settings: SettingsAccess): Promise<void> {
  if (!await confirm(deps, 'Remove the openai-codex route added in this run?', 'Remove route', 'Restores the profile to its previous state')) return
  const removed = await removeCodexRoute(settings)
  deps.notice(removed ? 'info' : 'warning', removed ? 'Removed route openai-codex.' : 'Could not remove route openai-codex; check /settings edit llm-pi-ai.')
}

/**
 * `/codex setup`: ensure the route, resolving the credential-reference conflict
 * with a confirmation.
 * @returns true when the route is ready.
 */
async function setup(deps: CodexCommandDeps): Promise<boolean> {
  const settings = deps.settings
  if (settings === undefined) {
    deps.notice('warning', 'The settings service is unavailable in this profile.')
    return false
  }
  let state = await ensureCodexRoute(settings, deps.llm, { wait: deps.wait })
  if (state.kind === 'blocked') {
    const reference = state.apiKeyEnv
    if (!await confirm(
      deps,
      'Route openai-codex names credential reference ' + reference + '; OAuth would be ignored. Remove it and use ChatGPT sign-in?',
      'Remove reference',
      'Unsets providers.openai-codex.apiKeyEnv and keeps the rest of the route',
    )) {
      deps.notice('warning', 'Route left unchanged; OAuth will not be used while apiKeyEnv is set.')
      return false
    }
    if (!await removeApiKeyEnvReference(settings)) {
      deps.notice('error', 'Could not remove the credential reference; check /settings edit llm-pi-ai.')
      return false
    }
    state = await ensureCodexRoute(settings, deps.llm, { wait: deps.wait })
  }
  switch (state.kind) {
    case 'unavailable':
      deps.notice('warning', 'Cannot configure openai-codex: ' + state.reason)
      return false
    case 'blocked':
      deps.notice('warning', 'Route openai-codex still names credential reference ' + state.apiKeyEnv + '; OAuth is not used.')
      return false
    case 'unverified':
      deps.notice('warning', 'The route was saved but the provider did not register within 5s; try /reload. ' + state.reason)
      if (state.added) await offerUndo(deps, settings)
      return false
    case 'added':
    case 'present': {
      const result = await countCodexModels(deps.llm)
      if (result.error !== undefined) {
        deps.notice('warning', 'Route openai-codex is configured, but its catalogue is unavailable: ' + result.error)
        return true
      }
      deps.notice('info', 'Route openai-codex is ready (' + String(result.count) + ' models).')
      return true
    }
  }
}

/** `/codex login [browser|device]`. */
async function login(deps: CodexCommandDeps, target: string): Promise<void> {
  if (target !== '' && target !== 'browser' && target !== 'device') {
    deps.notice('warning', 'Usage: /codex login [browser|device]')
    return
  }
  if (deps.authorization === undefined) {
    deps.notice('warning', 'The authorization service is unavailable in this profile.')
    return
  }
  if (deps.credentials === undefined) {
    deps.notice('warning', 'The credential store is unavailable in this profile.')
    return
  }
  const entry = deps.authorization.describe(CODEX_KEY)
  if (entry === undefined) {
    deps.notice('warning', 'No openai-codex sign-in flow is registered in this profile; mount llm-pi-ai first.')
    return
  }
  if (entry.inFlight) {
    deps.notice('warning', 'An OpenAI sign-in is already running.')
    return
  }
  const state = credentialState(await deps.credentials.readRecord(CODEX_KEY), deps.now?.() ?? Date.now())
  if (state.kind === 'valid') {
    if (!await confirm(deps, 'ChatGPT Codex is already signed in. Sign in again and replace the stored credential?', 'Sign in again', 'Starts a new OAuth attempt and overwrites the current grant')) return
  }
  let outcome
  try {
    outcome = await loginCodex({
      authorization: deps.authorization,
      notice: deps.notice,
      choose: deps.choose,
      ask: deps.ask,
      signal: deps.signal,
      ...(deps.openUrl === undefined ? {} : { openUrl: deps.openUrl }),
      ...(target === '' ? {} : { method: target }),
    })
  }
  catch (error) {
    deps.notice('error', 'Codex sign-in failed — ' + redact(error instanceof Error ? error.message : String(error)))
    return
  }
  if (outcome.status === 'timed-out') {
    deps.notice('warning', 'Codex sign-in timed out after 15 minutes; start it again when ready.')
    return
  }
  if (outcome.status === 'cancelled') {
    deps.notice('warning', 'Codex sign-in cancelled.')
    return
  }
  const account = readCodexAccount(grantOf(await deps.credentials.readRecord(CODEX_KEY)))
  deps.notice('info', 'Codex: signed in as ' + accountLabel(account) + ' (applies to every profile using this DSH home).')
  const ready = await setup(deps)
  if (!ready) deps.notice('warning', 'The credential is stored; run /codex setup to finish configuring the route.')
}

/** `/codex logout`. */
async function logout(deps: CodexCommandDeps): Promise<void> {
  if (deps.authorization === undefined || deps.credentials === undefined) {
    deps.notice('warning', 'The authorization or credential service is unavailable in this profile.')
    return
  }
  if (await deps.credentials.readRecord(CODEX_KEY) === undefined) {
    deps.notice('info', 'Codex: not signed in.')
    return
  }
  if (!await confirm(
    deps,
    'Sign out ChatGPT Codex for every profile using this DSH home?',
    'Sign out',
    'Removes the shared OAuth credential; the openai-codex route and its models stay configured',
  )) return
  const outcome = await logoutCodex({
    authorization: deps.authorization,
    credentials: deps.credentials,
    signal: deps.signal,
    ...(deps.wait === undefined ? {} : { wait: deps.wait }),
  })
  switch (outcome) {
    case 'signed-out':
      deps.notice('info', 'Codex: signed out.')
      break
    case 'busy':
      deps.notice('warning', 'A sign-in is still settling; try /codex logout again in a moment.')
      return
    case 'still-present':
      deps.notice('warning', 'The credential was rewritten by a background refresh; sign out again when the session is idle.')
      return
    case 'not-signed-in':
      deps.notice('info', 'Codex: not signed in.')
      return
  }
  const selected = deps.modelSelection?.current
  if (selected?.provider === CODEX_PROVIDER) {
    deps.notice('warning', 'The selected model is still ' + CODEX_PROVIDER + '/' + String(selected.model ?? '?') + '; choose another with /model.')
  }
}

/** `/codex models`. */
async function models(deps: CodexCommandDeps): Promise<void> {
  if (deps.llm === undefined) {
    deps.notice('warning', 'The LLM catalogue service is unavailable.')
    return
  }
  const profile = routeProfile(deps.settings)
  if (profile.kind === 'missing') {
    deps.notice('warning', 'Route openai-codex is missing — run /codex setup.')
    return
  }
  if (profile.kind === 'unavailable') {
    deps.notice('warning', 'The llm-pi-ai settings namespace is unavailable.')
    return
  }
  if (profile.kind === 'blocked') {
    deps.notice('warning', 'Route openai-codex names credential reference ' + String(profile.apiKeyEnv) + '; OAuth is not used.')
  }
  let listed
  try {
    listed = await deps.llm.listModels(CODEX_PROVIDER)
  }
  catch (error) {
    deps.notice('error', 'Could not list openai-codex models — ' + redact(error instanceof Error ? error.message : String(error)))
    return
  }
  const lines = ['openai-codex: ' + String(listed.length) + ' models']
  for (const model of listed) lines.push('  ' + model.id + (model.name === model.id ? '' : '  ' + model.name))
  if (listed.length === 0) lines.push('  The catalogue listed no models; /codex setup or /reload may refresh it.')
  const record = await deps.credentials?.readRecord(CODEX_KEY)
  if (credentialState(record, deps.now?.() ?? Date.now()).kind !== 'valid') lines.push('  Calls require sign-in: /codex login')
  deps.notice('info', lines.join('\n'))
}

/**
 * Run one `/codex` line.
 * @param args - text after the command name.
 * @param deps - Host seams and terminal interaction helpers.
 */
export async function runCodexCommand(args: string, deps: CodexCommandDeps): Promise<void> {
  try {
    await dispatch(args, deps)
  }
  catch (error) {
    deps.notice('error', 'Codex command failed — ' + redact(error instanceof Error ? error.message : String(error)))
  }
}

/** Dispatch after the outer failure boundary is in place. */
async function dispatch(args: string, deps: CodexCommandDeps): Promise<void> {
  const [sub = '', ...rest] = args.trim().split(/\s+/).filter(part => part !== '')
  switch (sub.toLowerCase()) {
    case '':
    case 'status':
      await status(deps)
      return
    case 'setup':
      await setup(deps)
      return
    case 'login':
      await login(deps, rest[0]?.toLowerCase() ?? '')
      return
    case 'logout':
      await logout(deps)
      return
    case 'models':
      await models(deps)
      return
    case 'help':
      deps.notice('info', CODEX_USAGE)
      return
    default:
      deps.notice('warning', 'Unknown /codex subcommand "' + sub + '".\n' + CODEX_USAGE)
  }
}
