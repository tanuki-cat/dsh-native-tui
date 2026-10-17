import { describe, expect, it } from 'vitest'
import {
  buildCatalogProvider,
  buildCustomProvider,
  isValidEnvName,
  isValidProviderRoute,
  mergeProviderProfiles,
  normalizeBaseURL,
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

  it('merges routes without dropping existing providers', () => {
    expect(mergeProviderProfiles({ openai: { apiKeyEnv: 'OPENAI_API_KEY' } }, 'my-gateway', { apiKeyEnv: 'X' }))
      .toEqual({ openai: { apiKeyEnv: 'OPENAI_API_KEY' }, 'my-gateway': { apiKeyEnv: 'X' } })
    expect(buildCatalogProvider('OPENAI_API_KEY')).toEqual({ apiKeyEnv: 'OPENAI_API_KEY' })
  })
})