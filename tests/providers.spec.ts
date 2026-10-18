import { describe, expect, it } from 'vitest'
import {
  buildCatalogProvider,
  buildCustomProvider,
  buildDiscoveredModelEntry,
  configurableProvidersIn,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_REASONING_EFFORTS,
  defaultApiKeyEnv,
  defaultMaxOutputTokens,
  nativeAuthEnv,
  isValidEnvName,
  isValidProviderRoute,
  mergeDiscoveredProviderModels,
  mergeProviderModel,
  mergeProviderProfiles,
  normalizeBaseURL,
  parseReasoningLevels,
} from '../src/runtime/providers.js'

describe('provider config helpers', () => {
  it('validates route and environment names', () => {
    expect(isValidProviderRoute('my-gateway')).toBe(true)
    expect(isValidProviderRoute('My_Gateway')).toBe(false)
    expect(isValidProviderRoute('-bad')).toBe(false)
    expect(isValidEnvName('MY_GATEWAY_KEY')).toBe(true)
    expect(isValidEnvName('my_lower_key')).toBe(false)
    expect(isValidEnvName('bad-name')).toBe(false)
    expect(isValidEnvName('sk-proj-abc123')).toBe(false)
  })

  it('normalizes HTTP endpoints', () => {
    expect(normalizeBaseURL('https://api.example.com/v1/')).toBe('https://api.example.com/v1')
    expect(() => normalizeBaseURL('ftp://example.com')).toThrow('http or https')
    expect(() => normalizeBaseURL('not a url')).toThrow('valid URL')
  })

  it('builds a custom profile and defaults the display name to the model id', () => {
    expect(buildCustomProvider({
      route: 'my-gateway',
      api: 'openai-completions',
      baseURL: 'https://api.example.com/v1',
      apiKeyEnv: 'MY_GATEWAY_KEY',
      modelId: 'my-model',
      contextWindow: 128000,
      maxTokens: 16384,
    })).toEqual({
      api: 'openai-completions',
      baseURL: 'https://api.example.com/v1',
      apiKeyEnv: 'MY_GATEWAY_KEY',
      models: [{ id: 'my-model', name: 'my-model', contextWindow: 128000, maxTokens: 16384 }],
    })
  })

  it('declares text and image input explicitly', () => {
    const provider = buildCustomProvider({
      route: 'vision-gateway',
      api: 'openai-responses',
      baseURL: 'https://api.example.com/v1',
      apiKeyEnv: 'VISION_GATEWAY_KEY',
      modelId: 'vision-model',
      contextWindow: 128000,
      maxTokens: 16384,
      input: ['text', 'image'],
    })
    expect((provider.models as readonly { input?: readonly string[] }[])[0]?.input).toEqual(['text', 'image'])
    expect(() => buildCustomProvider({
      route: 'vision-gateway',
      api: 'openai-responses',
      baseURL: 'https://api.example.com/v1',
      apiKeyEnv: 'VISION_GATEWAY_KEY',
      modelId: 'vision-model',
      contextWindow: 128000,
      maxTokens: 16384,
      input: ['text', 'text'],
    })).toThrow('unique text/image')
  })

  it('maps reasoning levels and rejects an off-only mapping', () => {
    expect(parseReasoningLevels(' off, low, high ')).toEqual({ off: null, low: 'low', high: 'high' })
    expect(parseReasoningLevels('')).toBeUndefined()
    expect(() => parseReasoningLevels('off')).toThrow('other than off')
    const provider = buildCustomProvider({
      route: 'reasoning-gateway',
      api: 'openai-responses',
      baseURL: 'https://api.example.com/v1',
      apiKeyEnv: 'REASONING_GATEWAY_KEY',
      modelId: 'reasoning-model',
      contextWindow: 128000,
      maxTokens: 16384,
      reasoningEfforts: { low: 'low', high: 'high' },
    })
    expect((provider.models as readonly { reasoningEfforts?: Record<string, string | null> }[])[0]?.reasoningEfforts)
      .toEqual({ low: 'low', high: 'high' })
  })

  it('merges a new model into an existing provider without dropping old models', () => {
    const existing = {
      api: 'openai-completions',
      baseURL: 'https://api.example.com/v1',
      apiKeyEnv: 'EXISTING_KEY',
      models: [{ id: 'old-model', name: 'Old' }],
    }
    const next = {
      api: 'openai-completions',
      baseURL: 'https://api.example.com/v1',
      apiKeyEnv: 'EXISTING_KEY',
      models: [{ id: 'new-model', name: 'New' }],
    }
    const merged = mergeProviderModel(existing, next)
    expect((merged.models as readonly { id: string }[]).map(model => model.id)).toEqual(['old-model', 'new-model'])
    const replaced = mergeProviderModel(existing, { ...next, models: [{ id: 'old-model', name: 'Updated' }] })
    expect(replaced.models).toEqual([{ id: 'old-model', name: 'Updated' }])
  })

  it('upserts discovered models while preserving existing model settings', () => {
    const existing = {
      api: 'openai-completions',
      baseURL: 'https://api.example.com/v1',
      apiKeyEnv: 'EXISTING_KEY',
      models: [
        {
          id: 'old-model',
          name: 'Old',
          contextWindow: 32000,
          maxTokens: 4096,
          input: ['text', 'image'],
          reasoningEfforts: { high: 'high' },
        },
        { id: 'legacy-model', name: 'Legacy' },
      ],
    }
    const merged = mergeDiscoveredProviderModels(existing, [
      { id: 'old-model', name: 'Old updated', contextWindow: 64000, maxTokens: 8192 },
      { id: 'legacy-model', name: 'Legacy updated', contextWindow: 8000, maxTokens: 1024 },
      { id: 'new-model', name: 'New', contextWindow: 16000, maxTokens: 2048, inputModalities: ['text'] },
    ])
    expect(merged.added).toBe(1)
    expect(merged.updated).toBe(2)
    expect(merged.provider.models).toEqual([
      {
        id: 'old-model',
        name: 'Old updated',
        contextWindow: 64000,
        maxTokens: 8192,
        input: ['text', 'image'],
        reasoningEfforts: { high: 'high' },
      },
      // An existing model keeps the absence of a map: blank means "no reasoning".
      { id: 'legacy-model', name: 'Legacy updated', contextWindow: 8000, maxTokens: 1024 },
      {
        id: 'new-model',
        name: 'New',
        contextWindow: 16000,
        maxTokens: 2048,
        input: ['text'],
        reasoningEfforts: DEFAULT_REASONING_EFFORTS,
      },
    ])
    // The default is copied per model so callers cannot share one mutable map.
    const mergedModels = merged.provider.models as readonly { readonly reasoningEfforts?: unknown }[]
    expect(mergedModels[2]?.reasoningEfforts).not.toBe(DEFAULT_REASONING_EFFORTS)
  })

  it('builds an auto-imported discovery model with the default reasoning map', () => {
    expect(DEFAULT_REASONING_EFFORTS).toEqual({ low: 'low', medium: 'medium', high: 'high' })
    expect(buildDiscoveredModelEntry({
      id: 'sibling-model',
      name: 'Sibling',
      contextWindow: 64000,
      maxTokens: 8192,
      inputModalities: ['text', 'image'],
    })).toEqual({
      id: 'sibling-model',
      name: 'Sibling',
      contextWindow: 64000,
      maxTokens: 8192,
      input: ['text', 'image'],
      reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
    })
    const first = buildDiscoveredModelEntry({ id: 'first-model' })
    const second = buildDiscoveredModelEntry({ id: 'second-model' })
    expect(first.reasoningEfforts).not.toBe(second.reasoningEfforts)
  })

  it('falls back to a default output cap bounded by the context window', () => {
    expect(buildDiscoveredModelEntry({ id: 'bare-model' })).toEqual({
      id: 'bare-model',
      name: 'bare-model',
      contextWindow: 128000,
      maxTokens: 32768,
      reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
    })
    expect(buildDiscoveredModelEntry({ id: 'zero-model', contextWindow: 0, maxTokens: -1, inputModalities: [] }))
      .toEqual({
        id: 'zero-model',
        name: 'zero-model',
        contextWindow: 128000,
        maxTokens: 32768,
        reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
      })
    // Modalities pi-ai cannot represent are dropped instead of stored as input.
    expect(buildDiscoveredModelEntry({ id: 'odd-model', inputModalities: ['audio'] }))
      .toEqual({
        id: 'odd-model',
        name: 'odd-model',
        contextWindow: 128000,
        maxTokens: 32768,
        reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
      })
  })

  it('configures a 32k output cap without exceeding the context window', () => {
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(32_768)
    expect(defaultMaxOutputTokens(1_000_000)).toBe(32_768)
    expect(defaultMaxOutputTokens(8_000)).toBe(8_000)
    expect(buildDiscoveredModelEntry({ id: 'wide-model', contextWindow: 1_000_000 }))
      .toMatchObject({ contextWindow: 1_000_000, maxTokens: 32_768 })
    // A capacity the endpoint listing reported still wins over the default.
    expect(buildDiscoveredModelEntry({ id: 'known-model', contextWindow: 1_000_000, maxTokens: 65_536 }))
      .toMatchObject({ maxTokens: 65_536 })
  })

  it('merges routes without dropping existing providers', () => {
    expect(mergeProviderProfiles({ openai: { apiKeyEnv: 'OPENAI_API_KEY' } }, 'my-gateway', { apiKeyEnv: 'X' }))
      .toEqual({ openai: { apiKeyEnv: 'OPENAI_API_KEY' }, 'my-gateway': { apiKeyEnv: 'X' } })
    expect(buildCatalogProvider('OPENAI_API_KEY')).toEqual({ apiKeyEnv: 'OPENAI_API_KEY' })
    // No reference keeps the provider's native auth, matching the Web editor's blank field.
    expect(buildCatalogProvider()).toEqual({})
    expect(() => buildCatalogProvider('bad-name')).toThrow('uppercase environment variable')
  })

  it('selects built-in catalog providers and their native credential env', () => {
    const entries = [
      { provider: 'amazon-bedrock', settingsNs: 'llm-pi-ai', nativeAuth: { env: ['AWS_BEARER_TOKEN_BEDROCK'], oauth: false } },
      { provider: 'anthropic', settingsNs: 'llm-pi-ai', displayName: 'Anthropic', nativeAuth: { env: ['ANTHROPIC_API_KEY'], oauth: true } },
      { provider: 'other-adapter', settingsNs: 'llm-other', nativeAuth: { env: ['OTHER_KEY'] } },
      { provider: '', settingsNs: 'llm-pi-ai' },
      { provider: 'no-auth', settingsNs: 'llm-pi-ai' },
    ]
    const piAi = configurableProvidersIn(entries, 'llm-pi-ai')
    expect(piAi.map(entry => entry.provider)).toEqual(['amazon-bedrock', 'anthropic', 'no-auth'])
    expect(nativeAuthEnv(piAi[0]!)).toBe('AWS_BEARER_TOKEN_BEDROCK')
    expect(nativeAuthEnv(piAi[2]!)).toBeUndefined()
    // Invalid env spellings are skipped so the picker default stays a legal reference.
    expect(nativeAuthEnv({ nativeAuth: { env: ['lower-case', 'GOOD_KEY'] } })).toBe('GOOD_KEY')
    expect(defaultApiKeyEnv('amazon-bedrock')).toBe('AMAZON_BEDROCK_API_KEY')
    expect(defaultApiKeyEnv('my-gateway.v2')).toBe('MY_GATEWAY_V2_API_KEY')
  })
})