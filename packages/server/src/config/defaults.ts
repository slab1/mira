import type { MiraConfig } from '../types/index.js'
import { DEFAULT_CONFIG as SHARED_DEFAULT } from '../../../shared/src/schemas/config.js'
import type { LoopLimits } from './types.js'

export const DEFAULT_CONFIG: MiraConfig = {
  ...SHARED_DEFAULT,
  // Server adds richer defaults — MCP + provider registry (shared has minimal)
  mcp: {
    firecrawl: {
      type: 'remote' as const,
      url: 'https://mcp.firecrawl.dev/mcp',
      enabled: false,
      headers: { Authorization: 'Bearer {env:FIRECRAWL_API_KEY}' },
    },
    tavily: { type: 'remote' as const, url: 'https://mcp.tavily.com/mcp', enabled: false },
  },
  provider: {
    openrouter: {
      npm: '@ai-sdk/openai-compatible',
      name: 'OpenRouter',
      options: {
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: '{env:OPENROUTER_API_KEY}',
        headers: {},
        timeout: 120_000,
        kind: 'openrouter',
      },
      models: {},
    },
    anthropic: {
      npm: '@ai-sdk/anthropic',
      name: 'Anthropic Direct',
      options: {
        baseURL: 'https://api.anthropic.com/v1',
        apiKey: '{env:ANTHROPIC_API_KEY}',
        headers: {},
        timeout: 120_000,
        kind: 'anthropic',
      },
      models: {
        'claude-sonnet-4': { name: 'Claude Sonnet 4', limit: { context: 200000, output: 8192 } },
      },
    },
    openai: {
      npm: '@ai-sdk/openai',
      name: 'OpenAI',
      options: {
        baseURL: 'https://api.openai.com/v1',
        apiKey: '{env:OPENAI_API_KEY}',
        headers: {},
        timeout: 120_000,
        kind: 'openai',
      },
      models: { 'gpt-4o': { name: 'GPT-4o', limit: { context: 128000, output: 4096 } } },
    },
    google: {
      npm: '@ai-sdk/google',
      name: 'Google Generative AI',
      options: {
        baseURL: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: ['{env:GOOGLE_GENERATIVE_AI_API_KEY}', '{env:GOOGLE_API_KEY}'],
        headers: {},
        timeout: 120_000,
        kind: 'google',
      },
      models: {},
    },
    deepseek: {
      npm: '@ai-sdk/openai-compatible',
      name: 'DeepSeek',
      options: {
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: '{env:DEEPSEEK_API_KEY}',
        headers: {},
        timeout: 120_000,
        kind: 'deepseek',
      },
      models: {},
    },
    nvidia: {
      npm: '@ai-sdk/openai-compatible',
      name: 'NVIDIA NIM',
      options: {
        baseURL: 'https://integrate.api.nvidia.com/v1',
        apiKey: '{env:NVIDIA_API_KEY}',
        headers: {},
        timeout: 120_000,
        kind: 'nvidia',
      },
      models: {},
    },
  },
  routing: {
    aliases: {},
    fallbacks: [],
    defaultProvider: 'openrouter',
  },
  subgateways: {
    default: {
      provider: 'openrouter',
      model: SHARED_DEFAULT.model,
      fallback: [],
      rateLimit: { rps: 10, burst: 20 },
      retry: { maxAttempts: 3, baseMs: 500, maxMs: 10_000 },
      timeout: 120_000,
      circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30_000 },
      enabled: true,
    },
    cheap: {
      provider: 'openrouter',
      model: SHARED_DEFAULT.smallModel ?? 'openrouter/deepseek/deepseek-v3.2-exp',
      fallback: [],
      rateLimit: { rps: 20, burst: 40 },
      retry: { maxAttempts: 3, baseMs: 300, maxMs: 5_000 },
      timeout: 60_000,
      circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 15_000 },
      enabled: true,
    },
    vision: {
      provider: 'openai',
      model: 'openai/gpt-4o',
      fallback: [],
      rateLimit: { rps: 5, burst: 10 },
      retry: { maxAttempts: 3, baseMs: 500, maxMs: 10_000 },
      timeout: 120_000,
      circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30_000 },
      enabled: true,
    },
    local: {
      provider: 'openrouter',
      model: SHARED_DEFAULT.model,
      fallback: [],
      rateLimit: { rps: 10, burst: 20 },
      retry: { maxAttempts: 2, baseMs: 500, maxMs: 5_000 },
      timeout: 30_000,
      circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 10_000 },
      enabled: true,
    },
    compaction: {
      provider: 'openrouter',
      model: SHARED_DEFAULT.smallModel ?? 'openrouter/deepseek/deepseek-v3.2-exp',
      fallback: [],
      rateLimit: { rps: 10, burst: 20 },
      retry: { maxAttempts: 2, baseMs: 300, maxMs: 5_000 },
      timeout: 45_000,
      circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 15_000 },
      enabled: true,
    },
    'agent:ask': {
      provider: 'openrouter',
      model: 'openrouter/deepseek/deepseek-v3.2-exp',
      fallback: [],
      rateLimit: { rps: 20, burst: 40 },
      retry: { maxAttempts: 3, baseMs: 300, maxMs: 5_000 },
      timeout: 60_000,
      circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 15_000 },
      enabled: true,
    },
  },
} as MiraConfig

export const DEFAULT_LOOP_LIMITS: LoopLimits = {
  maxSteps: 32,
  contextLimit: 128_000,
  compactionThreshold: 0.8,
  smallModel: 'openrouter/deepseek/deepseek-v3.2-exp',
}
