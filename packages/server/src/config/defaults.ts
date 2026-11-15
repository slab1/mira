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
        'nvidia/nemotron-3.5-lightning-30b-a3b': {
          name: 'Nemotron 3.5 Lightning 30B (fast/balanced)',
          limit: { context: 128000, output: 8192 },
        },
        'nvidia/nemotron-3.5-bolt-e4b': {
          name: 'Nemotron 3.5 Bolt E4B (ultra-fast)',
          limit: { context: 128000, output: 8192 },
        },
        'nvidia/nemotron-3-ultra-550b-a55b': {
          name: 'Nemotron 3 Ultra 550B (reasoning)',
          limit: { context: 128000, output: 8192 },
        },
        'nvidia/nemotron-3.5-super-vl-120b-a12b': {
          name: 'Nemotron 3.5 Super VL 120B',
          limit: { context: 128000, output: 8192 },
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
    groq: {
      npm: '@ai-sdk/openai-compatible',
      name: 'Groq Cloud',
      options: {
        baseURL: 'https://api.groq.com/openai/v1',
        apiKey: '{env:GROQ_API_KEY}',
        headers: {},
        timeout: 60_000,
        kind: 'groq',
      },
      models: {},
    },
    mistral: {
      npm: '@ai-sdk/openai-compatible',
      name: 'Mistral AI',
      options: {
        baseURL: 'https://api.mistral.ai/v1',
        apiKey: '{env:MISTRAL_API_KEY}',
        headers: {},
        timeout: 120_000,
        kind: 'mistral',
      },
      models: {},
    },
    together: {
      npm: '@ai-sdk/openai-compatible',
      name: 'Together AI',
      options: {
        baseURL: 'https://api.together.xyz/v1',
        apiKey: '{env:TOGETHER_API_KEY}',
        headers: {},
        timeout: 120_000,
        kind: 'together',
      },
      models: {},
    },
  },
  routing: {
    aliases: {
      sonnet: 'anthropic/claude-sonnet-4',
      'claude-sonnet': 'anthropic/claude-sonnet-4',
      opus: 'anthropic/claude-opus-4',
      'claude-opus': 'anthropic/claude-opus-4',
      haiku: 'anthropic/claude-haiku-3',
      'gpt-4o': 'openai/gpt-4o',
      'gpt-4o-mini': 'openai/gpt-4o-mini',
      deepseek: 'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b',
      flash: 'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b',
      pro: 'nvidia/nvidia/nemotron-3-ultra-550b-a55b',
      llama: 'nvidia/nvidia/nemotron-3.5-bolt-e4b',
      nemotron: 'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b',
      gemini: 'google/gemini-2.0-flash',
    },
    // Nvidia is primary — auto-pick keeps costs low; anthropic/openai/google stay as fallbacks
    fallbacks: [
      'anthropic/claude-sonnet-4',
      'openai/gpt-4o',
      'google/gemini-2.0-flash',
      'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b',
    ],
    defaultProvider: 'nvidia',
    retiredModels: [
      'claude-3-opus-20240229',
      'meta/llama-3.3-70b-instruct',
      'deepseek-ai/deepseek-v4-flash',
      'deepseek-ai/deepseek-v4-pro',
    ],
  },
  subgateways: {
    default: {
      provider: 'nvidia',
      model: 'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b',
      fallback: [
        'nvidia/nvidia/nemotron-3.5-bolt-e4b',
        'nvidia/nvidia/nemotron-3-ultra-550b-a55b',
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
      model: 'nvidia/nvidia/nemotron-3.5-bolt-e4b',
      fallback: [
        'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b',
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
      fallback: ['nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b', 'google/gemini-2.0-flash', 'anthropic/claude-sonnet-4'],
      rateLimit: { rps: 5, burst: 10 },
      retry: { maxAttempts: 3, baseMs: 500, maxMs: 10_000 },
      timeout: 120_000,
      circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30_000 },
      enabled: true,
    },
    local: {
      provider: 'nvidia',
      model: 'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b',
      fallback: ['colibri/qwen3.6', 'colibri/olmoe', 'nvidia/nvidia/nemotron-3.5-bolt-e4b', 'anthropic/claude-sonnet-4'],
      rateLimit: { rps: 10, burst: 20 },
      retry: { maxAttempts: 2, baseMs: 500, maxMs: 5_000 },
      timeout: 180_000,
      circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 10_000 },
      enabled: true,
    },
    compaction: {
      provider: 'nvidia',
      model: 'nvidia/nvidia/nemotron-3.5-bolt-e4b',
      fallback: ['colibri/olmoe', 'colibri/qwen3.6', 'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b'],
      rateLimit: { rps: 10, burst: 20 },
      retry: { maxAttempts: 2, baseMs: 300, maxMs: 5_000 },
      timeout: 180_000,
      circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 15_000 },
      enabled: true,
    },
    'agent:ask': {
      provider: 'nvidia',
      model: 'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b',
      fallback: ['nvidia/nvidia/nemotron-3.5-bolt-e4b', 'anthropic/claude-3.5-sonnet'],
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
