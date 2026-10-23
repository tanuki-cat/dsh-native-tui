/**
 * Drive one ChatGPT Codex sign-in through the authorization seam.
 *
 * pi-ai owns the OAuth protocol; this module only answers its prompts. Two
 * details matter for the terminal:
 *
 * - the browser flow always races a callback against a pasted code, so its text
 *   prompt is also the cancel affordance;
 * - an empty submit must stay pending. Resolving the prompt with an empty
 *   string would cancel the callback and fail the attempt, so empty answers are
 *   re-asked rather than forwarded.
 *
 * @module dsh-native-tui/codex/login
 */

import { CODEX_KEY, type AuthorizationLike, type AuthorizationNotice, type AuthorizationPrompt, type CommandChoice, type NoticeTone } from './types.js'

/** How one attempt ended, from this surface's point of view. */
export type LoginOutcome =
  | { readonly status: 'authorized' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'timed-out' }

/** Everything the sign-in surface needs from the terminal. */
export interface LoginDeps {
  readonly authorization: AuthorizationLike
  readonly openUrl?: (url: string) => boolean
  readonly notice: (level: NoticeTone, text: string) => void
  readonly choose: (title: string, items: readonly CommandChoice[], hint: string, signal: AbortSignal) => Promise<string | undefined>
  /** `''` is an empty submit; `undefined` means the dialog was cancelled. */
  readonly ask: (message: string, placeholder: string | undefined, secret: boolean, signal: AbortSignal) => Promise<string | undefined>
  /** Terminal lifecycle signal, aborted on dispose. Not a per-command cancel. */
  readonly signal: AbortSignal
  readonly method?: 'browser' | 'device'
  /** Default 15 minutes, matching pi-ai's device-code validity. */
  readonly timeoutMs?: number
}

/** Hosts whose pages are safe to hand to the platform browser automatically. */
const AUTO_OPEN_HOSTS = new Set(['auth.openai.com', 'chatgpt.com'])

/** Whether a notice URL is an authorization page rather than a documentation link. */
function autoOpenable(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    return AUTO_OPEN_HOSTS.has(parsed.hostname) || parsed.hostname.endsWith('.openai.com')
  }
  catch {
    return false
  }
}

/** The error code a Host service attached, when it carries one. */
function codeOf(error: unknown): unknown {
  return error !== null && typeof error === 'object' ? (error as { readonly code?: unknown }).code : undefined
}

/** Render one notice without duplicating the URL or code. */
function noticeText(notice: AuthorizationNotice, opened: boolean): string {
  const parts = [notice.message]
  if (notice.code !== undefined) parts.push('code: ' + notice.code)
  if (notice.url !== undefined) {
    parts.push(notice.url)
    if (!opened) parts.push('(open this URL in a browser)')
  }
  return parts.join(' ')
}

/**
 * Run one sign-in attempt.
 * @param deps - the authorization seam and the terminal interaction helpers.
 * @returns how the attempt ended.
 */
export async function loginCodex(deps: LoginDeps): Promise<LoginOutcome> {
  const entry = deps.authorization.describe(CODEX_KEY)
  if (entry === undefined) {
    deps.notice('warning', 'No openai-codex sign-in flow is registered in this profile; mount llm-pi-ai first.')
    return { status: 'cancelled' }
  }
  if (entry.inFlight) {
    deps.notice('warning', 'An OpenAI sign-in is already running.')
    return { status: 'cancelled' }
  }
  const oauth = entry.methods.find(method => method.id === 'oauth')
  const method = oauth?.id ?? entry.methods[0]?.id
  if (method === undefined) {
    deps.notice('warning', 'The openai-codex flow offers no sign-in method.')
    return { status: 'cancelled' }
  }
  if (oauth === undefined) deps.notice('info', 'The flow does not declare an oauth method; using ' + method + '.')

  const preferred = deps.method === 'browser' ? 'browser' : deps.method === 'device' ? 'device_code' : undefined
  const controller = new AbortController()
  let timedOut = false
  const timeoutMs = deps.timeoutMs ?? 15 * 60_000
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  timer.unref()
  const signal = AbortSignal.any([deps.signal, controller.signal])
  const opened = new Set<string>()
  let waitAbort: AbortController | undefined

  const notify = (notice: AuthorizationNotice): void => {
    if (signal.aborted) return
    const url = notice.url
    const first = url !== undefined && !opened.has(url)
    const launched = first && url !== undefined && autoOpenable(url)
      ? deps.openUrl?.(url) === true
      : false
    if (first && url !== undefined) opened.add(url)
    deps.notice('info', noticeText(notice, launched))
  }

  const startDeviceWait = (notice: AuthorizationNotice): void => {
    if (notice.code === undefined || waitAbort !== undefined) return
    const local = new AbortController()
    waitAbort = local
    const title = 'Waiting for authorization… code ' + notice.code
      + (notice.url === undefined ? '' : ' · ' + notice.url)
    void deps.choose(title, [{
      value: 'cancel',
      label: 'Cancel sign-in',
      description: 'Stop waiting for device authorization',
    }], 'Enter cancels · Esc cancels', AbortSignal.any([signal, local.signal])).then(picked => {
      if (picked === 'cancel' || (picked === undefined && !local.signal.aborted)) controller.abort()
    }, () => undefined)
  }

  try {
    const outcome = await deps.authorization.begin({
      key: CODEX_KEY,
      method,
      signal,
      interaction: {
        notify: notice => {
          startDeviceWait(notice)
          notify(notice)
        },
        async prompt(prompt: AuthorizationPrompt): Promise<string> {
          if (prompt.kind === 'select') {
            if (preferred !== undefined && prompt.options.some(option => option.id === preferred)) return preferred
            const picked = await deps.choose(
              prompt.message,
              prompt.options.map(option => ({
                value: option.id,
                label: option.label,
                ...(option.description === undefined ? {} : { description: option.description }),
              })),
              'Enter selects · Esc cancels',
              signal,
            )
            if (picked === undefined) {
              controller.abort()
              throw new Error('sign-in cancelled')
            }
            return picked
          }
          for (;;) {
            const promptSignal = prompt.signal === undefined ? signal : AbortSignal.any([signal, prompt.signal])
            const answer = await deps.ask(prompt.message, prompt.placeholder, prompt.kind === 'secret', promptSignal)
            if (answer === undefined) {
              if (prompt.signal?.aborted === true) throw new Error('prompt withdrawn')
              controller.abort()
              throw new Error('sign-in cancelled')
            }
            if (answer !== '') return answer
          }
        },
      },
    })
    if (outcome.status === 'authorized') return { status: 'authorized' }
    return { status: timedOut ? 'timed-out' : 'cancelled' }
  }
  catch (error) {
    if (codeOf(error) === 'ALREADY_IN_FLIGHT') {
      deps.notice('warning', 'An OpenAI sign-in is already running.')
      return { status: 'cancelled' }
    }
    if (timedOut) return { status: 'timed-out' }
    if (deps.signal.aborted || controller.signal.aborted) return { status: 'cancelled' }
    throw error
  }
  finally {
    clearTimeout(timer)
    waitAbort?.abort()
  }
}
