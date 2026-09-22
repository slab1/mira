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
      models: {
        'deepseek-ai/deepseek-v4-flash': {
          name: 'DeepSeek V4 Flash (cheap/fast)',
          limit: { context: 128000, output: 8192 },
        },
        'deepseek-ai/deepseek-v4-pro': {
          name: 'DeepSeek V4 Pro (reasoning)',
          limit: { context: 128000, output: 8192 },
        },
        'meta/llama-3.3-70b-instruct': {
          name: 'Llama 3.3 70B (fallback)',
          limit: { context: 128000, output: 4096 },
        },
      },
    },
    colibri: {
      npm: '@ai-sdk/openai-compatible',
      name: 'Colibri Local (MoE streamed from disk)',
      options: {
        baseURL: 'http://127.0.0.1:8000/v1',
        apiKey: '{env:COLI_API_KEY}',
        headers: {},
        timeout: 180_000,
        kind: 'colibri',
      },
      models: {
        'qwen3.6': { name: 'Qwen3.6 35B-A3B (20GB, recommended local)', limit: { context: 32768, output: 4096 } },
        'olmoe': { name: 'OLMoE 7B (8GB, fastest local)', limit: { context: 4096, output: 2048 } },
        'glm-5.2': { name: 'GLM-5.2 744B MoE (372GB)', limit: { context: 131072, output: 8192 } },
      },
    },
  },
  routing: {
    aliases: {},
    // Nvidia is primary — auto-pick keeps costs low; anthropic/openai/google stay as fallbacks
    fallbacks: [
      'anthropic/claude-sonnet-4',
      'openai/gpt-4o',
      'google/gemini-2.0-flash',
    ],
    defaultProvider: 'nvidia',
  },
  subgateways: {
    default: {
      provider: 'nvidia',
      model: 'nvidia/deepseek-ai/deepseek-v4-flash',
      fallback: [
        'nvidia/deepseek-ai/deepseek-v4-pro',
        'nvidia/meta/llama-3.3-70b-instruct',
        'anthropic/claude-sonnet-4',
      ],
      rateLimit: { rps: 10, burst: 20 },
      retry: { maxAttempts: 3, baseMs: 500, maxMs: 10_000 },
      timeout: 120_000,
      circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30_000 },
      enabled: true,
    },
    cheap: {
      provider: 'nvidia',
      model: 'nvidia/deepseek-ai/deepseek-v4-flash',
      fallback: [
        'nvidia/meta/llama-3.3-70b-instruct',
        'anthropic/claude-3.5-sonnet',
      ],
      rateLimit: { rps: 20, burst: 40 },
      retry: { maxAttempts: 3, baseMs: 300, maxMs: 5_000 },
      timeout: 60_000,
      circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 15_000 },
      enabled: true,
    },
    vision: {
      provider: 'openai',
      model: 'openai/gpt-4o',
      fallback: ['google/gemini-2.0-flash', 'anthropic/claude-sonnet-4'],
      rateLimit: { rps: 5, burst: 10 },
      retry: { maxAttempts: 3, baseMs: 500, maxMs: 10_000 },
      timeout: 120_000,
      circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30_000 },
      enabled: true,
    },
    local: {
      provider: 'nvidia',
      model: 'nvidia/deepseek-ai/deepseek-v4-flash',
      fallback: ['colibri/qwen3.6', 'colibri/olmoe', 'nvidia/meta/llama-3.3-70b-instruct', 'anthropic/claude-sonnet-4'],
      rateLimit: { rps: 10, burst: 20 },
      retry: { maxAttempts: 2, baseMs: 500, maxMs: 5_000 },
      timeout: 180_000,
      circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 10_000 },
      enabled: true,
    },
    compaction: {
      provider: 'nvidia',
      model: 'nvidia/deepseek-ai/deepseek-v4-flash',
      fallback: ['colibri/olmoe', 'colibri/qwen3.6', 'nvidia/meta/llama-3.3-70b-instruct'],
      rateLimit: { rps: 10, burst: 20 },
      retry: { maxAttempts: 2, baseMs: 300, maxMs: 5_000 },
      timeout: 180_000,
      circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 15_000 },
      enabled: true,
    },
    'agent:ask': {
      provider: 'nvidia',
      model: 'nvidia/deepseek-ai/deepseek-v4-flash',
      fallback: ['nvidia/meta/llama-3.3-70b-instruct', 'anthropic/claude-3.5-sonnet'],
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
  smallModel: 'claude-3.5-sonnet',
}
