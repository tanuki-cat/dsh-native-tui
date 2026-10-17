import { describe, expect, it } from 'vitest'
import {
  buildCatalogProvider,
  buildCustomProvider,
  isValidEnvName,
  isValidProviderRoute,
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

  it('merges routes without dropping existing providers', () => {
    expect(mergeProviderProfiles({ openai: { apiKeyEnv: 'OPENAI_API_KEY' } }, 'my-gateway', { apiKeyEnv: 'X' }))
      .toEqual({ openai: { apiKeyEnv: 'OPENAI_API_KEY' }, 'my-gateway': { apiKeyEnv: 'X' } })
    expect(buildCatalogProvider('OPENAI_API_KEY')).toEqual({ apiKeyEnv: 'OPENAI_API_KEY' })
  })
})