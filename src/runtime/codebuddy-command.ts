/**
 * `/codebuddy` command surface for the terminal.
 *
 * The UI is injected: this module owns the sub-command semantics and the exact
 * text, while the terminal owns notice rendering, prompts and the host
 * services. Login and logout go through the authorization and credential
 * seams, so the same flows serve any other surface.
 *
 * @module dsh-native-tui/runtime/codebuddy-command
 */

import type { CodeBuddyService } from '../codebuddy.js'
import { credentialKeyFor, grantOf, readGrant, type CredentialStoreLike } from '../codebuddy/auth.js'
import { checkIn, fetchQuota, type CheckinResult, type QuotaResult } from '../codebuddy/credits.js'
import { classifyFailure, redact } from '../codebuddy/errors.js'
import {
  DEFAULT_CONTEXT_WINDOW,
  PROFILES,
  PROFILE_ALIASES,
  getProfile,
  type CodeBuddyProfile,
  type ProfileId,
} from '../codebuddy/profiles.js'
import { REQUEST_SHAPE } from '../codebuddy/profiles.js'
import { PROMPT_PLACEHOLDER } from '../codebuddy/prompt.js'
import { isSettingsConflict } from './settings-write.js'

/** One authorization flow as the terminal drives it. */
interface AuthorizationLike {
  begin(request: {
    readonly key: string
    readonly method?: string
    readonly interaction: {
      notify(notice: { message: string; url?: string; code?: string }): void
      prompt(prompt: {
        readonly kind: string
        readonly message: string
        readonly placeholder?: string
        readonly options?: readonly { readonly id: string; readonly label: string; readonly description?: string }[]
      }): Promise<string>
    }
    readonly signal?: AbortSignal
  }): Promise<{ readonly status: string }>
}

/** One choice row in the guided system-prompt flow. */
export interface CodeBuddyPromptChoice {
  readonly value: string
  readonly label: string
  readonly description?: string
}

/**
 * The Host settings slice the system-prompt wizard writes through.
 *
 * `systemPrompt` is declared volatile on the plugin row, so the Host applies a
 * write live and the adapter reads it on the next request.
 */
export interface CodeBuddyPromptSettings {
  describe(options?: { redactSecrets?: boolean }): readonly {
    readonly ns: string
    readonly value: Record<string, unknown>
    readonly user?: unknown
    readonly revision: number
  }[]
  mutate(ns: string, ops: readonly (
    | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
    | { readonly op: 'unset'; readonly path: readonly string[] }
  )[], expectedRevision?: number): Promise<void>
}

/** Everything the command needs from the terminal and the host. */
export interface CodeBuddyCommandDeps {
  /** The adapter service mounted by the codebuddy plugin, when present. */
  readonly service: CodeBuddyService | undefined
  /** The authorization seam, when this composition mounts one. */
  readonly authorization: AuthorizationLike | undefined
  /** The credential seam, for sign-in state display and sign-out. */
  readonly credentials: CredentialStoreLike | undefined
  /** Open an authorization URL in the platform browser; undefined when unsupported. */
  readonly openUrl?: (url: string) => boolean
  /** Host settings service, for reading and writing the volatile system prompt. */
  readonly settings?: CodeBuddyPromptSettings
  /** Cancellation for the whole command. */
  readonly signal: AbortSignal
  /** Render one notice line. */
  readonly notice: (level: 'info' | 'warning' | 'error', text: string) => void
  /** Ask the human one question; undefined when the surface declined. */
  readonly prompt: (question: {
    readonly message: string
    readonly placeholder?: string
    readonly secret?: boolean
  }) => Promise<string | undefined>
  /** Show a keyboard-selected list; absent on surfaces without overlays. */
  readonly choose?: (
    title: string,
    items: readonly CodeBuddyPromptChoice[],
    hint: string,
  ) => Promise<string | undefined>
  /** Edit multi-line text; absent on surfaces without overlays. */
  readonly editText?: (title: string, initialValue: string, hint: string) => Promise<string | undefined>
}

/** Shared placeholder for command runs that are not part of a streaming turn. */
const NEVER_ABORTS = new AbortController().signal

const DAY_MS = 24 * 60 * 60 * 1000

/** Short usage text for the command. */
export const CODEBUDDY_USAGE = [
  'Usage: /codebuddy <subcommand>',
  '  status                  sign-in state, token rotation, model catalogue',
  '  login [cn|en|all]       open the browser sign-in for a deployment',
  '  logout [cn|en|all]      remove the stored credential',
  '  models [cn|en]          list models with the input modalities they declare',
  '  models refresh [cn|en]  force a catalogue refresh (default: both)',
  '  quota [cn|en]           remaining credits reported by the gateway',
  '  checkin [cn|en]         claim today credits (one request, no schedule)',
  '  prompt                  guided system-prompt setup (custom template or default)',
  '  prompt show             print the configured system prompt',
  '  prompt reset            remove the custom template',
  '  doctor                  connectivity and capability probe, no secrets',
  '  help                    this text',
].join('\n')

/** Providers named by the argument, or every provider when it names none. */
export function selectProfiles(target: string): CodeBuddyProfile[] | undefined {
  if (target === '' || target === 'all') return [...PROFILES]
  const id: ProfileId | undefined = PROFILE_ALIASES[target] ?? getProfile(target)?.id
  return id === undefined ? undefined : [getProfile(id) as CodeBuddyProfile]
}

/** Human-readable age of one timestamp. */
function ago(at: number | undefined): string {
  if (at === undefined) return 'never'
  const seconds = Math.round((Date.now() - at) / 1000)
  if (seconds < 60) return String(seconds) + 's ago'
  if (seconds < 5400) return String(Math.round(seconds / 60)) + 'm ago'
  return String(Math.round(seconds / 3600)) + 'h ago'
}

/** The sign-in line for one deployment. */
async function loginLine(deps: CodeBuddyCommandDeps, profile: CodeBuddyProfile): Promise<string> {
  if (deps.credentials === undefined) return profile.id + ': credential store unavailable in this profile'
  const grant = await readGrant(deps.credentials, profile)
  if (grant === undefined) return profile.id + ': not signed in — run /codebuddy login ' + profile.id
  const remaining = grant.expires - Date.now()
  if (remaining <= 0) return profile.id + ': signed in, token due for rotation'
  return profile.id + ': signed in, rotation in ' + (remaining / DAY_MS).toFixed(1) + 'd'
}

/** Map one configured profile id onto the route key the service expects. */
function routeKey(target: string): string | undefined {
  const profile = selectProfiles(target)
  return profile !== undefined && profile.length === 1 ? profile[0]?.id : undefined
}

/** Trim one rendered line list to the notice area. */
function report(deps: CodeBuddyCommandDeps, lines: readonly string[], level: 'info' | 'warning' | 'error' = 'info'): void {
  deps.notice(level, lines.join('\n'))
}

/** status sub-command. */
async function status(deps: CodeBuddyCommandDeps): Promise<void> {
  const lines: string[] = []
  const service = deps.service
  for (const profile of PROFILES) {
    lines.push(await loginLine(deps, profile))
    const state = service?.status().find(entry => entry.id === profile.id)
    if (state === undefined) {
      lines.push('  adapter state unavailable; restart the terminal if this persists')
      continue
    }
    lines.push(
      '  ' + String(state.modelCount) + ' models, catalogue refreshed ' + ago(state.lastRefresh)
      + (state.lastError === undefined ? '' : ', last error: ' + state.lastError),
    )
  }
  report(deps, lines)
}

/** Open one URL, treating a throwing opener as "did not open". */
function openOnce(open: (url: string) => boolean, url: string): boolean {
  try {
    return open(url)
  }
  catch {
    return false
  }
}

/** login sub-command: drive the authorization seam once per deployment. */
async function login(deps: CodeBuddyCommandDeps, target: string): Promise<void> {
  const selected = selectProfiles(target)
  if (selected === undefined) {
    report(deps, ['unknown target ' + JSON.stringify(target) + '; expected cn, en or all'], 'warning')
    return
  }
  if (deps.authorization === undefined) {
    report(deps, ['this profile mounts no authorization service, so a browser sign-in cannot be started'], 'warning')
    return
  }
  for (const profile of selected) {
    // Per deployment: the same URL is announced once, and a second deployment
    // in the same run must still open its own page.
    let lastUrl: string | undefined
    try {
      const outcome = await deps.authorization.begin({
        key: credentialKeyFor(profile),
        method: 'oauth',
        interaction: {
          notify: notice => {
            // Hand the authorization page to the browser once per URL, and keep
            // the URL in the notice so a headless or failed launch is still
            // actionable. A rejected opener must not abort the flow: the URL
            // line is the fallback.
            const url = notice.url
            const first = url !== undefined && url !== lastUrl
            const opened = first && url !== undefined && deps.openUrl !== undefined && openOnce(deps.openUrl, url)
            if (url !== undefined) lastUrl = url
            const suffix = url === undefined ? '' : ' ' + url
            // The manual hint belongs to the announcement that could not open a
            // browser, never to a repeat of a URL that already opened.
            const hint = first && !opened ? ' (open this URL in a browser)' : ''
            const code = notice.code === undefined ? '' : ' code: ' + notice.code
            deps.notice('info', notice.message + hint + suffix + code)
          },
          prompt: question => deps.prompt({
            message: question.message,
            ...(question.placeholder === undefined ? {} : { placeholder: question.placeholder }),
            ...(question.kind === 'secret' ? { secret: true } : {}),
          }).then(answer => answer ?? Promise.reject(new Error('cancelled'))),
        },
        signal: deps.signal,
      })
      report(deps, [profile.id + ': ' + (outcome.status === 'authorized' ? 'signed in' : 'sign-in cancelled')],
        outcome.status === 'authorized' ? 'info' : 'warning')
    }
    catch (error) {
      report(deps, [profile.id + ': sign-in failed — ' + redact(error instanceof Error ? error.message : String(error))], 'error')
    }
  }
}

/** logout sub-command. */
async function logout(deps: CodeBuddyCommandDeps, target: string): Promise<void> {
  const selected = selectProfiles(target)
  if (selected === undefined) {
    report(deps, ['unknown target ' + JSON.stringify(target) + '; expected cn, en or all'], 'warning')
    return
  }
  if (deps.credentials === undefined) {
    report(deps, ['credential store unavailable in this profile'], 'warning')
    return
  }
  for (const profile of selected) {
    await deps.credentials.deleteRecord(credentialKeyFor(profile))
    report(deps, [profile.id + ': signed out'])
  }
}

/** models refresh sub-command. */
async function refresh(deps: CodeBuddyCommandDeps, target: string): Promise<void> {
  const selected = selectProfiles(target)
  if (selected === undefined) {
    report(deps, ['unknown target ' + JSON.stringify(target) + '; expected cn, en or all'], 'warning')
    return
  }
  if (deps.service === undefined) {
    report(deps, ['codebuddy adapter is not mounted in this profile'], 'warning')
    return
  }
  const service = deps.service
  const lines: string[] = []
  let failed = false
  for (const profile of selected) {
    const outcomes = await service.refresh(profile.id)
    for (const outcome of outcomes) {
      if (outcome.error === undefined) lines.push(outcome.id + ': refreshed')
      else {
        failed = true
        lines.push(outcome.id + ': failed — ' + outcome.error)
      }
    }
  }
  report(deps, lines, failed ? 'warning' : 'info')
}

/** models list sub-command: what each model declares, and where that came from. */
function listModels(deps: CodeBuddyCommandDeps, target: string): void {
  const selected = selectProfiles(target)
  if (selected === undefined) {
    report(deps, ['unknown target ' + JSON.stringify(target) + '; expected cn, en or all'], 'warning')
    return
  }
  if (deps.service === undefined) {
    report(deps, ['codebuddy adapter is not mounted in this profile'], 'warning')
    return
  }
  const service = deps.service
  const lines: string[] = []
  for (const profile of selected) {
    const models = service.models(profile.id)
    lines.push(profile.id + ': ' + String(models.length) + ' models')
    for (const model of models) {
      const images = model.inputModalities.includes('image')
      // A declaration that asked for images and was narrowed is the one state
      // worth naming: it is the only case where the printed source (catalogue,
      // or an operator override) is not what the harness actually reads.
      const note = model.degraded === 'no-attachment-service'
        ? ' (' + model.source + ' asks for images; no attachment service mounted, so text only)'
        : ''
      lines.push('  ' + model.id.padEnd(26) + (images ? 'text+image' : 'text only') + '  [' + model.source + ']' + note)
    }
  }
  report(deps, lines)
}

/** Resolve a request-ready token for one target, or the reason it is unavailable. */
async function accessFor(
  deps: CodeBuddyCommandDeps,
  profile: CodeBuddyProfile,
): Promise<{ readonly access: string } | { readonly error: string }> {
  if (deps.service === undefined) return { error: 'codebuddy adapter is not mounted in this profile' }
  try {
    const access = await deps.service.accessTokenFor(profile.id, deps.signal)
    return access === '' ? { error: 'not signed in — run /codebuddy login ' + profile.id } : { access }
  }
  catch (error) {
    return { error: 'credential refused — ' + redact(error instanceof Error ? error.message : String(error)) }
  }
}

/** One quota result as text. */
function quotaLine(profile: CodeBuddyProfile, result: QuotaResult): string {
  if (!result.ok) return profile.id + ': unavailable — ' + result.error
  const { remaining, packages } = result.summary
  const detail = packages.length === 0
    ? 'no packages reported'
    : String(packages.length) + ' package' + (packages.length === 1 ? '' : 's') + ', '
      + String(packages.filter(entry => entry.refill).length) + ' renewing'
  return profile.id + ': ' + String(remaining) + ' credits remaining (' + detail + ')'
}

/** One check-in result as text. */
function checkinLine(profile: CodeBuddyProfile, result: CheckinResult): string {
  switch (result.status) {
    case 'already':
      return profile.id + ': already claimed today'
    case 'failed':
      return profile.id + ': failed — ' + result.error
    case 'checked-in': {
      const streak = result.streakDays === undefined ? '' : ', ' + String(result.streakDays) + ' day streak'
      return profile.id + ': claimed ' + String(result.credit) + ' credits' + streak
    }
  }
}

/** quota sub-command. */
async function quota(deps: CodeBuddyCommandDeps, target: string): Promise<void> {
  const selected = selectProfiles(target)
  if (selected === undefined) {
    report(deps, ['unknown target ' + JSON.stringify(target) + '; expected cn, en or all'], 'warning')
    return
  }
  const lines: string[] = []
  for (const profile of selected) {
    const access = await accessFor(deps, profile)
    if ('error' in access) {
      lines.push(profile.id + ': ' + access.error)
      continue
    }
    lines.push(quotaLine(profile, await fetchQuota(profile, access.access, deps.signal)))
  }
  report(deps, lines)
}

/** checkin sub-command; one explicit request per selected deployment. */
async function checkin(deps: CodeBuddyCommandDeps, target: string): Promise<void> {
  const selected = selectProfiles(target)
  if (selected === undefined) {
    report(deps, ['unknown target ' + JSON.stringify(target) + '; expected cn, en or all'], 'warning')
    return
  }
  const lines: string[] = []
  for (const profile of selected) {
    const access = await accessFor(deps, profile)
    if ('error' in access) {
      lines.push(profile.id + ': ' + access.error)
      continue
    }
    lines.push(checkinLine(profile, await checkIn(profile, access.access, deps.signal)))
  }
  lines.push('', 'Check-in calls the vendor own endpoint. Confirm your account terms allow it.')
  report(deps, lines)
}

/** A short catalogue probe for one deployment. */
async function probeCatalogue(profile: CodeBuddyProfile, access: string, signal: AbortSignal): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, 15_000)
  try {
    const response = await fetch(profile.configUrl, {
      method: 'GET',
      headers: profile.headers(access),
      signal: AbortSignal.any([signal, controller.signal]),
    })
    const text = await response.text()
    if (!response.ok) {
      return classifyFailure(response.status, text) + ' (HTTP ' + String(response.status) + ') ' + redact(text.slice(0, 120))
    }
    const models = (JSON.parse(text) as { data?: { models?: unknown } }).data?.models
    return Array.isArray(models) ? 'ok, ' + String(models.length) + ' models' : 'ok, catalogue carried no models'
  }
  catch (error) {
    return 'failed: ' + redact(error instanceof Error ? error.message : String(error))
  }
  finally {
    clearTimeout(timeout)
  }
}

/** doctor sub-command. */
async function doctor(deps: CodeBuddyCommandDeps): Promise<void> {
  const lines: string[] = []
  for (const profile of PROFILES) {
    lines.push(profile.id + ' (' + profile.name + ')')
    lines.push('  chat endpoint:  ' + profile.chatBaseUrls.join(' -> '))
    lines.push('  catalogue:      ' + profile.configUrl)
    lines.push('  credits:        ' + profile.usageUrls.join(' -> '))
    lines.push('  request shape:  maxTokensField=' + REQUEST_SHAPE.maxTokensField
      + ', store=' + String(REQUEST_SHAPE.supportsStore)
      + ', stream options=' + String(REQUEST_SHAPE.supportsUsageInStreaming))
    const access = await accessFor(deps, profile)
    if ('error' in access) {
      lines.push('  probe: ' + access.error)
      continue
    }
    lines.push('  catalogue probe: ' + await probeCatalogue(profile, access.access, deps.signal))
  }
  lines.push('', 'Default context window for an unlisted model: ' + String(DEFAULT_CONTEXT_WINDOW) + ' tokens.')
  report(deps, lines)
}

/** Profile entry id whose volatile `systemPrompt` the wizard writes. */
export const CODEBUDDY_PROMPT_NS = 'codebuddy'

/** One settings descriptor as the prompt flow reads it. */
type PromptDescriptor = ReturnType<CodeBuddyPromptSettings['describe']>[number]

/** Locate the codebuddy settings entry, or undefined when the Host does not expose it. */
function promptDescriptorOf(settings: CodeBuddyPromptSettings): PromptDescriptor | undefined {
  return settings.describe({ redactSecrets: true }).find(row => row.ns === CODEBUDDY_PROMPT_NS)
}

/** The custom template the user section carries, or undefined for the default. */
function configuredPromptOf(descriptor: PromptDescriptor | undefined): string | undefined {
  const user = descriptor?.user
  if (user === null || typeof user !== 'object') return undefined
  const value = (user as Record<string, unknown>).systemPrompt
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Key and semantics hint shared by the editor and the confirmation. */
const PROMPT_EDIT_HINT = 'Enter saves · Shift+Enter/Ctrl+J newline · Esc cancels · {prompt} keeps the harness prompt · empty clears'

/** Human label for how a template affects the harness prompt. */
function promptModeOf(template: string): string {
  return template.includes(PROMPT_PLACEHOLDER) ? 'keeps the harness prompt' : 'replaces the whole system prompt'
}

/**
 * Write the volatile `systemPrompt`, retrying once against a fresh revision.
 * @param settings - Host settings service.
 * @param template - template to set, or undefined to restore the default.
 * @param revision - revision the descriptor was read at.
 */
async function writePromptSetting(
  settings: CodeBuddyPromptSettings,
  template: string | undefined,
  revision: number,
): Promise<void> {
  const op = template === undefined
    ? { op: 'unset' as const, path: ['systemPrompt'] as const }
    : { op: 'set' as const, path: ['systemPrompt'] as const, value: template }
  try {
    await settings.mutate(CODEBUDDY_PROMPT_NS, [op], revision)
  }
  catch (error) {
    if (!isSettingsConflict(error)) throw error
    const fresh = promptDescriptorOf(settings)
    if (fresh === undefined) throw new Error('the codebuddy configuration entry disappeared while saving')
    await settings.mutate(CODEBUDDY_PROMPT_NS, [op], fresh.revision)
  }
}

/** Persist one template (or its removal) and report what the next request sends. */
async function savePrompt(
  deps: CodeBuddyCommandDeps,
  settings: CodeBuddyPromptSettings,
  template: string | undefined,
  revision: number,
): Promise<void> {
  await writePromptSetting(settings, template, revision)
  if (template === undefined) {
    deps.notice('info', 'CodeBuddy system prompt reset to the default. Applies to the next request.')
    return
  }
  deps.notice('info', 'CodeBuddy system prompt saved (' + String(template.length) + ' chars, '
    + promptModeOf(template) + '). Applies to the next request.')
}

/** Print the configured template without opening an overlay. */
function showPromptSetting(deps: CodeBuddyCommandDeps, descriptor: PromptDescriptor | undefined): void {
  if (descriptor === undefined) {
    report(deps, ['the codebuddy configuration entry is not exposed to the settings service in this profile'], 'warning')
    return
  }
  const custom = configuredPromptOf(descriptor)
  if (custom === undefined) {
    report(deps, [
      'CodeBuddy system prompt: default',
      '  CN restates the harness identity line; every other line is sent unchanged.',
      '  Run /codebuddy prompt to add a custom template.',
    ])
    return
  }
  report(deps, [
    'CodeBuddy system prompt: custom template (' + String(custom.length) + ' chars, ' + promptModeOf(custom) + ')',
    ...custom.split('\n').map(line => '  ' + line),
  ])
}

/** Guided template editor: edit, confirm a whole-prompt replacement, then save. */
async function promptWizard(deps: CodeBuddyCommandDeps, settings: CodeBuddyPromptSettings): Promise<void> {
  const choose = deps.choose
  const editText = deps.editText
  if (choose === undefined || editText === undefined) {
    report(deps, ['this surface has no interactive editor; use /codebuddy prompt show|reset'], 'warning')
    return
  }
  const descriptor = promptDescriptorOf(settings)
  if (descriptor === undefined) {
    report(deps, ['the codebuddy configuration entry is not exposed to the settings service in this profile'], 'warning')
    return
  }
  const custom = configuredPromptOf(descriptor)
  const current = custom === undefined
    ? 'default (CN restates the identity line; everything else unchanged)'
    : 'custom template · ' + String(custom.length) + ' chars · ' + promptModeOf(custom)
  const action = await choose(
    'CodeBuddy system prompt\nCurrent: ' + current,
    [
      {
        value: 'edit',
        label: custom === undefined ? 'Add a custom template…' : 'Edit the custom template…',
        description: 'Multi-line editor; {prompt} keeps tool instructions and workspace rules',
      },
      {
        value: 'reset',
        label: 'Use the default prompt',
        description: 'Remove the custom template; CN only restates the identity line',
      },
    ],
    'Enter selects · Esc cancels',
  )
  if (action === undefined) return
  if (action === 'reset') {
    if (custom === undefined) {
      deps.notice('info', 'CodeBuddy already uses the default system prompt.')
      return
    }
    await savePrompt(deps, settings, undefined, descriptor.revision)
    return
  }

  let draft = custom ?? PROMPT_PLACEHOLDER
  for (;;) {
    const text = await editText('CodeBuddy system prompt', draft, PROMPT_EDIT_HINT)
    if (text === undefined) return
    if (text.trim() === '') {
      await savePrompt(deps, settings, undefined, descriptor.revision)
      return
    }
    if (!text.includes(PROMPT_PLACEHOLDER)) {
      const confirm = await choose(
        'No {prompt} placeholder\nThis template replaces the whole harness system prompt, including tool instructions and workspace rules.',
        [
          { value: 'save', label: 'Save anyway', description: 'Send only the configured text as the system prompt' },
          { value: 'back', label: 'Back to the editor', description: 'Add {prompt} to keep the harness prompt' },
        ],
        'Enter selects · Esc cancels',
      )
      if (confirm === undefined) return
      if (confirm === 'back') {
        draft = text
        continue
      }
    }
    await savePrompt(deps, settings, text, descriptor.revision)
    return
  }
}

/** `prompt` sub-command: guided by default, with scripted show/reset escape hatches. */
async function promptCommand(deps: CodeBuddyCommandDeps, action: string): Promise<void> {
  const settings = deps.settings
  if (settings === undefined) {
    report(deps, ['the settings service is unavailable in this profile, so the system prompt cannot be changed here'], 'warning')
    return
  }
  try {
    const descriptor = promptDescriptorOf(settings)
    if (action === 'show') {
      showPromptSetting(deps, descriptor)
      return
    }
    if (descriptor === undefined) {
      report(deps, ['the codebuddy configuration entry is not exposed to the settings service in this profile'], 'warning')
      return
    }
    if (action === 'reset') {
      if (configuredPromptOf(descriptor) === undefined) {
        deps.notice('info', 'CodeBuddy already uses the default system prompt.')
        return
      }
      await savePrompt(deps, settings, undefined, descriptor.revision)
      return
    }
    if (action !== '') {
      report(deps, ['expected "/codebuddy prompt", "/codebuddy prompt show" or "/codebuddy prompt reset"', '', CODEBUDDY_USAGE], 'warning')
      return
    }
    await promptWizard(deps, settings)
  }
  catch (error) {
    report(deps, ['could not update the CodeBuddy system prompt — ' + redact(error instanceof Error ? error.message : String(error))], 'error')
  }
}

/**
 * Run one /codebuddy invocation.
 * @param args - the text after the command name.
 * @param deps - terminal and host services.
 */
export async function runCodebuddyCommand(args: string, deps: CodeBuddyCommandDeps): Promise<void> {
  const [sub = 'status', ...rest] = args.trim().split(/\s+/u)
  if (sub === '' || sub === 'status') { await status(deps); return }
  if (sub === 'help') { report(deps, [CODEBUDDY_USAGE]); return }
  if (sub === 'login') { await login(deps, rest[0] ?? ''); return }
  if (sub === 'logout') { await logout(deps, rest[0] ?? ''); return }
  if (sub === 'quota') { await quota(deps, rest[0] ?? ''); return }
  if (sub === 'checkin') { await checkin(deps, rest[0] ?? ''); return }
  if (sub === 'prompt') { await promptCommand(deps, rest[0] ?? ''); return }
  if (sub === 'doctor') { await doctor(deps); return }
  if (sub === 'models') {
    const [action = '', target = ''] = rest
    if (action === 'refresh') {
      await refresh(deps, target)
      return
    }
    if (action === '' || action === 'cn' || action === 'en' || action === 'all') {
      listModels(deps, action)
      return
    }
    report(deps, ['expected "/codebuddy models [cn|en|all]" or "/codebuddy models refresh [cn|en]"', '', CODEBUDDY_USAGE], 'warning')
    return
  }
  report(deps, ['unknown subcommand ' + JSON.stringify(sub), '', CODEBUDDY_USAGE], 'warning')
}
