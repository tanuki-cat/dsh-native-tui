/**
 * `/provider`: add, list, edit, fetch models for, and remove `llm-pi-ai`
 * third-party routes.
 *
 * The add flow is long because it is a guided wizard; it is split into the
 * catalog path and the custom-gateway path so each stays readable.
 *
 * @module dsh-native-tui/ui/commands/provider
 */

import { showChoice, showSearchChoice, showTextInput } from '../dialogs.js'
import {
  buildCatalogProvider,
  buildCustomProvider,
  buildDiscoveredModelEntry,
  configurableProvidersIn,
  DEFAULT_MAX_OUTPUT_TOKENS,
  defaultApiKeyEnv,
  defaultMaxOutputTokens,
  isValidEnvName,
  isValidProviderRoute,
  mergeDiscoveredProviderModels,
  mergeProviderModel,
  nativeAuthEnv,
  parseReasoningLevels,
  type ConfigurableProviderEntry,
  type ProviderProtocol,
} from '../../runtime/providers.js'
import type { CommandContext } from './context.js'
import { selectModel } from './model.js'
import type { CredentialsService, LLM, SettingsService } from './services.js'
import { NL, errorMessage } from './shared.js'

/** A discovered model row as the Host reports it. */
type DiscoveredModel = {
  readonly id: string
  readonly name?: string
  readonly contextWindow?: number
  readonly maxTokens?: number
  readonly inputModalities?: readonly ('text' | 'image')[]
}

/** A gateway model the wizard is about to write. */
interface WizardModel {
  id: string
  name?: string
  contextWindow: number
  maxTokens: number
  inputModalities?: readonly ('text' | 'image')[]
}

/** Everything the wizard shares between its steps. */
interface WizardState {
  settings: SettingsService
  llm: LLM
  credentials: CredentialsService | undefined
  route: string
  providerRecord: Record<string, unknown>
  revision: number
}

/** The `/provider` command. */
export async function providerCommand(ctx: CommandContext, args: string): Promise<void> {
  const settings = ctx.host.get('settings') as unknown as SettingsService | undefined
  const llm = ctx.host.get('llm') as LLM | undefined
  if (settings === undefined) {
    ctx.notice('warning', 'The settings service is unavailable in this profile.')
    return
  }
  if (llm === undefined) {
    ctx.notice('warning', 'The LLM catalog service is unavailable.')
    return
  }
  const credentials = ctx.host.get('credentials') as CredentialsService | undefined
  const descriptor = settings.describe({ redactSecrets: true }).find(row => row.ns === 'llm-pi-ai')
  if (descriptor === undefined) {
    ctx.notice('warning', 'The llm-pi-ai settings namespace is unavailable; mount the llm-pi-ai Host row first.')
    return
  }
  const currentProviders = descriptor.value.providers
  const providerRecord: Record<string, unknown> = currentProviders !== null && typeof currentProviders === 'object' && !Array.isArray(currentProviders)
    ? currentProviders as Record<string, unknown>
    : {}

  if (args === 'list') {
    await listProviders(ctx, llm, credentials, providerRecord)
    return
  }
  if (args === '') {
    const route = await chooseProviderRoute(ctx, providerRecord, 'Open provider')
    if (route !== undefined)
      await editProvider(ctx, settings, llm, providerRecord, route)
    return
  }
  if (args === 'edit' || args.startsWith('edit ')) {
    const route = args === 'edit' ? await chooseProviderRoute(ctx, providerRecord, 'Open provider') : args.slice('edit '.length).trim()
    if (route !== undefined)
      await editProvider(ctx, settings, llm, providerRecord, route)
    return
  }
  if (args === 'models' || args.startsWith('models ')) {
    const route = args === 'models' ? undefined : args.slice('models '.length).trim()
    if (route === undefined || route === '') {
      ctx.notice('warning', 'Usage: /provider models <route>')
      return
    }
    if (!isValidProviderRoute(route)) {
      ctx.notice('warning', 'Invalid provider route "' + route + '".')
      return
    }
    await fetchProviderModels(ctx, settings, llm, route)
    return
  }
  if (args.startsWith('remove ')) {
    const route = args.slice('remove '.length).trim()
    if (route === '' || !isValidProviderRoute(route)) {
      ctx.notice('warning', 'Usage: /provider remove <route>')
      return
    }
    if (!Object.hasOwn(providerRecord, route)) {
      ctx.notice('warning', 'No configured provider route "' + route + '".')
      return
    }
    const confirmed = await showChoice(ctx.tui, ctx.palette, 'Remove provider ' + route + '?', [
      { value: 'yes', label: 'Remove', description: 'Delete this route from llm-pi-ai settings' },
      { value: 'no', label: 'Cancel' },
    ], 'Enter selects · Esc cancels', ctx.signal)
    if (confirmed !== 'yes')
      return
    try {
      await settings.mutate('llm-pi-ai', [{ op: 'unset', path: ['providers', route] }], descriptor.revision)
      ctx.notice('info', 'Removed provider route: ' + route)
    }
    catch (error) {
      ctx.notice('error', 'Could not remove provider: ' + errorMessage(error))
    }
    return
  }
  if (args !== '' && args !== 'add') {
    ctx.notice('warning', 'Usage: /provider [add | list | edit [route] | models <route> | remove <route>]')
    return
  }
  await addProvider(ctx, {
    settings,
    llm,
    credentials,
    route: '',
    providerRecord,
    revision: descriptor.revision,
  })
}

/** Choose one configured route, or report that none exist. */
async function chooseProviderRoute(
  ctx: CommandContext,
  providerRecord: Record<string, unknown>,
  title: string,
): Promise<string | undefined> {
  const routes = Object.keys(providerRecord)
  if (routes.length === 0) {
    ctx.notice('info', 'No third-party providers configured. Use /provider add.')
    return undefined
  }
  return showChoice(ctx.tui, ctx.palette, title, routes.map(route => ({
    value: route,
    label: route,
    description: 'open provider configuration',
  })), 'Enter opens · Esc cancels', ctx.signal)
}

/** `/provider list`. */
async function listProviders(
  ctx: CommandContext,
  llm: LLM,
  credentials: CredentialsService | undefined,
  providerRecord: Record<string, unknown>,
): Promise<void> {
  const entries = Object.entries(providerRecord)
  if (entries.length === 0) {
    ctx.notice('info', 'No third-party providers configured. Use /provider add.')
    return
  }
  const rows: string[] = []
  for (const [route, raw] of entries) {
    let count = 0
    try {
      count = (await llm.listModels(route)).length
    }
    catch {
      // Missing credentials or invalid route: show the configured entry anyway.
    }
    const env = raw !== null && typeof raw === 'object' && typeof (raw as { readonly apiKeyEnv?: unknown }).apiKeyEnv === 'string'
      ? (raw as { readonly apiKeyEnv: string }).apiKeyEnv
      : undefined
    let envState = ''
    if (env !== undefined) {
      if (!isValidEnvName(env)) {
        envState = '  (invalid env name; remove this route and rotate the key)'
      }
      else if (process.env[env] !== undefined) {
        envState = '  ' + env
      }
      else {
        let stored = false
        if (credentials !== undefined) {
          try {
            stored = (await credentials.resolve(env))?.value !== undefined
          }
          catch {
            // A credential-store read failure is shown as unset, not as a provider error.
          }
        }
        envState = '  ' + env + (stored ? ' (stored)' : ' (not set)')
      }
    }
    rows.push(route + '  ' + String(count) + ' model(s)' + envState)
  }
  ctx.notice('info', 'Configured third-party providers:' + NL + rows.join(NL)
    + NL + 'Use /provider add to add one, /provider edit <route> to fetch models, /provider remove <route> to delete one.')
}

/** Discover the route's models and merge them into the profile. */
async function fetchProviderModels(ctx: CommandContext, settings: SettingsService, llm: LLM, route: string): Promise<void> {
  const latest = settings.describe({ redactSecrets: true }).find(row => row.ns === 'llm-pi-ai')
  const providers = latest?.value.providers
  const raw = providers !== null && typeof providers === 'object' && !Array.isArray(providers)
    ? (providers as Record<string, unknown>)[route]
    : undefined
  if (latest === undefined || raw === undefined) {
    ctx.notice('warning', 'No configured provider route "' + route + '".')
    return
  }
  const profile = raw !== null && typeof raw === 'object'
    ? raw as { readonly baseURL?: unknown; readonly api?: unknown }
    : {}
  ctx.notice('info', 'Fetching available models for ' + route + '…')
  const discoveryAbort = new AbortController()
  const timeout = setTimeout(() => discoveryAbort.abort(), 8000)
  let discovered: readonly DiscoveredModel[] = []
  try {
    discovered = await llm.discoverModels('llm-pi-ai', {
      provider: route,
      ...(typeof profile.baseURL === 'string' ? { baseURL: profile.baseURL } : {}),
      ...(typeof profile.api === 'string' ? { api: profile.api } : {}),
    }, AbortSignal.any([ctx.signal, discoveryAbort.signal]))
  }
  catch (error) {
    ctx.notice('error', 'Could not fetch models for ' + route + ': ' + errorMessage(error))
    return
  }
  finally {
    clearTimeout(timeout)
  }
  if (discovered.length === 0) {
    ctx.notice('warning', 'The provider returned no models for ' + route + '.')
    return
  }
  const merged = mergeDiscoveredProviderModels(raw, discovered)
  try {
    await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', route], value: merged.provider }], latest.revision)
  }
  catch (error) {
    ctx.notice('error', 'Fetched models but could not save them: ' + errorMessage(error))
    return
  }
  ctx.notice('info', 'Fetched ' + String(discovered.length) + ' model(s) for ' + route + ': ' + String(merged.added) + ' added, ' + String(merged.updated) + ' refreshed. Use /model to switch.')
}

/** The per-route edit menu. */
async function editProvider(
  ctx: CommandContext,
  settings: SettingsService,
  llm: LLM,
  providerRecord: Record<string, unknown>,
  route: string,
): Promise<void> {
  if (!Object.hasOwn(providerRecord, route)) {
    ctx.notice('warning', 'No configured provider route "' + route + '".')
    return
  }
  const action = await showChoice(ctx.tui, ctx.palette, 'Provider ' + route, [
    { value: 'fetch', label: 'Fetch available models', description: 'Discover models from the configured endpoint and merge them into this route' },
    { value: 'cancel', label: 'Cancel' },
  ], 'Enter selects · Esc cancels', ctx.signal)
  if (action === 'fetch')
    await fetchProviderModels(ctx, settings, llm, route)
}

/** Warn about a credential field that is not an exported environment name. */
function requireEnv(ctx: CommandContext, env: string): boolean {
  if (!isValidEnvName(env)) {
    ctx.notice('warning', 'The credential field must be an UPPERCASE environment variable name, not the API key. Provider was not saved.')
    return false
  }
  const value = process.env[env]
  if (value === undefined || value.trim() === '') {
    ctx.notice('warning', 'Environment variable ' + env + ' is not set in this dsh process. Export it before launching dsh, restart the TUI, then run /provider add again. Provider was not saved.')
    return false
  }
  return true
}

/** Ask for a model id and its limits when the endpoint listed nothing usable. */
async function readManualModel(ctx: CommandContext): Promise<{ id: string; name?: string; contextWindow: number; maxTokens: number } | undefined> {
  const modelId = await showTextInput(ctx.tui, ctx.palette, 'Model id', 'gpt-4o-mini', 'Exact model id sent on the wire · Esc cancels', ctx.signal)
  if (modelId === undefined)
    return undefined
  const contextRaw = await showTextInput(ctx.tui, ctx.palette, 'Context window', '128000', 'Positive integer; Enter keeps the default · Esc cancels', ctx.signal, '128000')
  if (contextRaw === undefined)
    return undefined
  // Suggest a cap bounded by the window just entered, so the default is never
  // larger than what the model can accept.
  const declaredWindow = Number(contextRaw)
  const suggestedMax = Number.isSafeInteger(declaredWindow) && declaredWindow > 0
    ? defaultMaxOutputTokens(declaredWindow)
    : DEFAULT_MAX_OUTPUT_TOKENS
  const maxRaw = await showTextInput(ctx.tui, ctx.palette, 'Max output tokens', String(suggestedMax), 'Positive integer; Enter keeps the default · Esc cancels', ctx.signal, String(suggestedMax))
  if (maxRaw === undefined)
    return undefined
  return { id: modelId, contextWindow: Number(contextRaw), maxTokens: Number(maxRaw) }
}

/** The guided `/provider add` wizard. */
async function addProvider(ctx: CommandContext, state: WizardState): Promise<void> {
  const { settings, llm, credentials, providerRecord } = state
  try {
    const kind = await showChoice(ctx.tui, ctx.palette, 'Provider type', [
      { value: 'openai-completions', label: 'Custom OpenAI-compatible gateway', description: 'Chat Completions endpoint; you supply baseURL and model' },
      { value: 'openai-responses', label: 'Custom OpenAI Responses gateway', description: 'Responses API endpoint; you supply baseURL and model' },
      { value: 'anthropic-messages', label: 'Custom Anthropic-compatible gateway', description: 'Messages API endpoint; you supply baseURL and model' },
      { value: 'catalog', label: 'Built-in pi-ai catalog route', description: 'Use a shipped provider catalog (for example openai, anthropic)' },
    ], 'Enter selects · Esc cancels', ctx.signal)
    if (kind === undefined)
      return
    let route: string | undefined
    let nativeEnv: string | undefined
    if (kind === 'catalog') {
      let directory: readonly ConfigurableProviderEntry[] = []
      try {
        directory = configurableProvidersIn(llm.listConfigurableProviders(), 'llm-pi-ai')
      }
      catch {
        directory = []
      }
      if (directory.length === 0) {
        ctx.notice('warning', 'The built-in provider directory is unavailable; enter a shipped pi-ai catalog id manually.')
        route = await showTextInput(ctx.tui, ctx.palette, 'Provider route', 'anthropic', 'Shipped pi-ai catalog id · Esc cancels', ctx.signal)
      }
      else {
        const picked = await showSearchChoice(ctx.tui, ctx.palette, 'Built-in provider · ' + String(directory.length) + ' available', directory.map((entry) => {
          const env = nativeAuthEnv(entry)
          return {
            value: entry.provider,
            label: entry.provider,
            description: [
              ...(entry.displayName !== undefined && entry.displayName !== entry.provider ? [entry.displayName] : []),
              ...(env === undefined ? [] : ['native env ' + env]),
            ].join(' · '),
          }
        }), 'Type to filter · Enter selects · Esc cancels', ctx.signal)
        if (picked !== undefined) {
          route = picked
          nativeEnv = nativeAuthEnv(directory.find(entry => entry.provider === picked) ?? { provider: picked })
        }
      }
    }
    else {
      route = await showTextInput(ctx.tui, ctx.palette, 'Provider route', 'my-gateway', 'lowercase letters, digits, hyphens · Esc cancels', ctx.signal)
    }
    if (route === undefined)
      return
    if (!isValidProviderRoute(route)) {
      ctx.notice('warning', 'Provider route must start with a letter and contain only lowercase letters, digits, and hyphens.')
      return
    }
    const envDefault = nativeEnv ?? defaultApiKeyEnv(route)
    const baseURL = kind === 'catalog'
      ? undefined
      : await showTextInput(ctx.tui, ctx.palette, 'Base URL', 'https://api.example.com/v1', 'OpenAI-compatible API root · Esc cancels', ctx.signal)
    if (kind !== 'catalog' && baseURL === undefined)
      return
    const credentialSource = await showChoice(ctx.tui, ctx.palette, 'Credential source', [
      ...(nativeEnv === undefined ? [] : [{ value: 'native', label: 'Use built-in environment auth', description: 'Leave the profile key unset; the provider reads ' + nativeEnv }]),
      { value: 'store', label: 'Store API key in DSH credentials', description: 'Recommended; key goes to the credential store, not the profile' },
      { value: 'env', label: 'Use an environment variable', description: 'Read a key exported before dsh started' },
    ], 'Enter selects · Esc cancels', ctx.signal)
    if (credentialSource === undefined)
      return
    let env: string | undefined
    let apiKey: string | undefined
    if (credentialSource === 'native') {
      env = undefined
    }
    else if (credentialSource === 'store') {
      if (credentials === undefined) {
        ctx.notice('warning', 'The credential store is unavailable in this profile; choose the environment-variable option instead.')
        return
      }
      const secret = await showTextInput(ctx.tui, ctx.palette, 'API key (stored in DSH credentials)', 'paste the key here', 'Visible while typing; stored outside the profile config · Esc cancels', ctx.signal)
      if (secret === undefined)
        return
      const value = secret.trim()
      if (value === '') {
        ctx.notice('warning', 'API key must not be empty.')
        return
      }
      env = envDefault
      try {
        await credentials.set(env, value)
      }
      catch (error) {
        ctx.notice('error', 'Could not store the API key: ' + errorMessage(error))
        return
      }
      apiKey = value
      ctx.notice('info', 'Stored API key under credential reference ' + env + '.')
    }
    else {
      const value = await showTextInput(ctx.tui, ctx.palette, 'API key env var NAME (not the key)', envDefault, 'UPPERCASE name like MY_GATEWAY_KEY; export the secret before launch · Esc cancels', ctx.signal, envDefault)
      if (value === undefined)
        return
      if (!requireEnv(ctx, value))
        return
      env = value
      apiKey = process.env[value]!
    }
    let provider: Record<string, unknown>
    let chosenModel: string | undefined
    let discovered: readonly DiscoveredModel[] = []
    if (kind === 'catalog') {
      provider = buildCatalogProvider(env)
    }
    else {
      if (baseURL === undefined)
        return
      ctx.notice('info', 'Discovering models from ' + baseURL + '…')
      const discoveryAbort = new AbortController()
      const timeout = setTimeout(() => discoveryAbort.abort(), 5000)
      try {
        discovered = await llm.discoverModels('llm-pi-ai', {
          baseURL,
          api: kind,
          apiKey,
        }, AbortSignal.any([ctx.signal, discoveryAbort.signal]))
      }
      catch (error) {
        ctx.notice('warning', 'Automatic model discovery failed: ' + errorMessage(error) + ' — falling back to manual model id.')
      }
      finally {
        clearTimeout(timeout)
      }
      let model: WizardModel | undefined
      if (discovered.length > 0) {
        const choice = await showChoice(ctx.tui, ctx.palette, 'Select model from ' + route, [
          ...discovered.map((candidate, index) => ({
            value: String(index),
            label: candidate.id,
            description: candidate.name ?? 'discovered by the endpoint',
          })),
          { value: '__manual__', label: 'Enter model id manually', description: 'Use a model the endpoint did not list' },
        ], 'Enter selects · Esc cancels', ctx.signal)
        if (choice === undefined)
          return
        if (choice === '__manual__') {
          model = await readManualModel(ctx)
        }
        else {
          const found = discovered[Number(choice)]
          if (found !== undefined) {
            const contextWindow = typeof found.contextWindow === 'number' && found.contextWindow > 0 ? found.contextWindow : 128000
            model = {
              id: found.id,
              ...(found.name === undefined ? {} : { name: found.name }),
              contextWindow,
              maxTokens: typeof found.maxTokens === 'number' && found.maxTokens > 0 ? found.maxTokens : defaultMaxOutputTokens(contextWindow),
              ...(found.inputModalities === undefined ? {} : { inputModalities: found.inputModalities }),
            }
          }
        }
      }
      else {
        ctx.notice('info', 'No models discovered from the endpoint; entering model id manually.')
        model = await readManualModel(ctx)
      }
      if (model === undefined)
        return
      const supportsImage = model.inputModalities?.includes('image') === true
      const imageFirst = supportsImage || model.inputModalities === undefined
      const inputChoice = await showChoice(ctx.tui, ctx.palette, 'Input modalities', imageFirst
        ? [
            { value: 'image', label: 'Text + image', description: supportsImage ? 'The endpoint reports image input' : 'Only if the endpoint accepts image input' },
            { value: 'text', label: 'Text only', description: 'Safest for text-only models' },
          ]
        : [
            { value: 'text', label: 'Text only', description: 'The endpoint reports text input only' },
            { value: 'image', label: 'Text + image', description: 'Override only if the endpoint accepts images' },
          ], 'Enter selects · Esc cancels', ctx.signal)
      if (inputChoice === undefined)
        return
      const input = inputChoice === 'image' ? ['text', 'image'] as const : ['text'] as const
      const reasoningRaw = await showTextInput(ctx.tui, ctx.palette, 'Reasoning levels', 'low, medium, high', 'Comma-separated: off/minimal/low/medium/high/xhigh/max; blank = no reasoning · Esc cancels', ctx.signal, 'low,medium,high')
      if (reasoningRaw === undefined)
        return
      let reasoningEfforts: Record<string, string | null> | undefined
      try {
        reasoningEfforts = parseReasoningLevels(reasoningRaw)
      }
      catch (error) {
        ctx.notice('warning', 'Invalid reasoning levels: ' + errorMessage(error))
        return
      }
      chosenModel = model.id
      provider = buildCustomProvider({
        route,
        api: kind as ProviderProtocol,
        baseURL,
        apiKeyEnv: env ?? envDefault,
        modelId: model.id,
        ...(model.name === undefined ? {} : { modelName: model.name }),
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        input,
        ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
      })
      const selectedModels = (provider as { models?: Record<string, unknown>[] }).models
      if (Array.isArray(selectedModels)) {
        for (const candidate of discovered) {
          if (candidate.id === model.id)
            continue
          selectedModels.push(buildDiscoveredModelEntry(candidate))
        }
      }
    }
    if (Object.hasOwn(providerRecord, route)) {
      const existing = providerRecord[route]
      if (kind === 'catalog') {
        const confirmed = await showChoice(ctx.tui, ctx.palette, 'Provider route ' + route + ' already exists', [
          { value: 'yes', label: 'Replace credential', description: 'Replace this catalog route profile' },
          { value: 'no', label: 'Cancel' },
        ], 'Enter selects · Esc cancels', ctx.signal)
        if (confirmed !== 'yes')
          return
      }
      else {
        const confirmed = await showChoice(ctx.tui, ctx.palette, 'Provider route ' + route + ' already exists', [
          { value: 'merge', label: 'Add/replace this model, keep other models', description: 'Append to the existing route and keep its other models' },
          { value: 'replace', label: 'Replace entire route', description: 'Discard the existing model list' },
          { value: 'cancel', label: 'Cancel' },
        ], 'Enter selects · Esc cancels', ctx.signal)
        if (confirmed === undefined || confirmed === 'cancel')
          return
        if (confirmed === 'merge')
          provider = mergeProviderModel(existing, provider)
      }
    }
    await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', route], value: provider }], state.revision)
    ctx.notice('info', 'Saved provider route: ' + route + ' · key is read from ' + ((provider as { apiKeyEnv?: string }).apiKeyEnv ?? nativeEnv ?? 'no credential reference'))
    if (chosenModel !== undefined) {
      await selectModel(ctx, llm, route + '/' + chosenModel)
      return
    }
    let models: readonly { readonly id: string; readonly name: string; readonly description?: string }[] = []
    try {
      models = await llm.listModels(route)
    }
    catch (error) {
      ctx.notice('warning', 'Provider saved, but its model list is currently unavailable: ' + errorMessage(error))
      return
    }
    if (models.length === 0) {
      ctx.notice('warning', 'Provider saved, but /model sees no models yet. Export '
        + String((provider as { apiKeyEnv?: string }).apiKeyEnv ?? nativeEnv ?? 'the API key env var')
        + ' before launching dsh, then restart the TUI or run /model.')
      return
    }
    const selected = await showChoice(ctx.tui, ctx.palette, 'Model for ' + route, models.map(model => ({
      value: route + '/' + model.id,
      label: model.id,
      description: model.name,
    })), 'Enter selects · Esc keeps the current model', ctx.signal)
    if (selected !== undefined)
      await selectModel(ctx, llm, selected)
  }
  catch (error) {
    ctx.notice('error', 'Provider setup failed: ' + errorMessage(error))
  }
}
