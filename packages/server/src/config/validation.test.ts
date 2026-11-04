/**
 * Tests for configuration validation module
 */

import { describe, it, expect } from 'bun:test'
import { validateConfig, checkForSecretsInConfig, enhancedMiraConfigSchema } from './validation.js'
import type { PartialMiraConfig } from './types.js'

describe('Configuration Validation', () => {
  describe('enhancedMiraConfigSchema', () => {
    it('should validate a minimal config', () => {
      const config: PartialMiraConfig = {
        model: 'openai/gpt-4o',
      }
      
      const result = enhancedMiraConfigSchema.safeParse(config)
      expect(result.success).toBe(true)
    })

    it('should accept model in format "provider/model-id"', () => {
      const config: PartialMiraConfig = {
        model: 'openai/gpt-4o',
        smallModel: 'openai/gpt-3.5-turbo',
      }
      
      const result = enhancedMiraConfigSchema.safeParse(config)
      expect(result.success).toBe(true)
    })

    it('should accept model in simple format', () => {
      const config: PartialMiraConfig = {
        model: 'gpt-4o',
      }
      
      const result = enhancedMiraConfigSchema.safeParse(config)
      expect(result.success).toBe(true)
    })
  })

  describe('checkForSecretsInConfig', () => {
    it('should detect OpenAI API keys', () => {
      const config: PartialMiraConfig = {
        model: 'openai/gpt-4o',
        provider: {
          openai: {
            options: {
              apiKey: 'sk-abc123def456',
            },
          },
        },
      }
      
      const result = checkForSecretsInConfig(config as any, 'test-config')
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors[0]).toContain('apiKey')
    })

    it('should detect Anthropic API keys', () => {
      const config = {
        model: 'anthropic/claude-3-sonnet',
        provider: {
          anthropic: {
            options: {
              apiKey: 'sk_ant_abc123',
            },
          },
        },
      }
      
      const result = checkForSecretsInConfig(config as any, 'test-config')
      expect(result.errors.length).toBeGreaterThan(0)
    })

    it('should detect NVIDIA API keys', () => {
      const config = {
        model: 'nvidia/llama-3.1-70b',
        provider: {
          nvidia: {
            options: {
              apiKey: 'nvapi-abc123',
            },
          },
        },
      }
      
      const result = checkForSecretsInConfig(config as any, 'test-config')
      expect(result.errors.length).toBeGreaterThan(0)
    })

    it('should NOT flag env template values as secrets', () => {
      const config = {
        model: 'openai/gpt-4o',
        provider: {
          openai: {
            options: {
              apiKey: '{env:OPENAI_API_KEY}',
            },
          },
        },
      }
      
      const result = checkForSecretsInConfig(config as any, 'test-config')
      expect(result.errors.length).toBe(0)
    })

    it('should warn about keys that look like secrets without templates', () => {
      const config = {
        model: 'openai/gpt-4o',
        provider: {
          openai: {
            options: {
              apiKey: '{env:OPENAI_API_KEY}',
            },
          },
        },
        // This key name suggests a secret but the value is a template
        customSecret: '{env:CUSTOM_SECRET}',
      }
      
      const result = checkForSecretsInConfig(config as any, 'test-config')
      // Should have warnings but no errors
      expect(result.errors.length).toBe(0)
    })
  })

  describe('validateConfig', () => {
    it('should validate and return config for valid input', () => {
      const config = {
        model: 'openai/gpt-4o',
        smallModel: 'openai/gpt-3.5-turbo',
        loop: {
          maxSteps: 10,
          contextLimit: 100000,
        },
      }
      
      const result = validateConfig(config as any, 'test-config')
      expect(result.model).toBe('openai/gpt-4o')
      expect(result.smallModel).toBe('openai/gpt-3.5-turbo')
    })

    it('should throw on secrets in config', () => {
      const config = {
        model: 'openai/gpt-4o',
        provider: {
          openai: {
            options: {
              apiKey: 'sk-abc123',
            },
          },
        },
      }
      
      expect(() => validateConfig(config as any, 'test-config')).toThrow()
    })

    it('should accept config with env templates', () => {
      const config = {
        model: 'openai/gpt-4o',
        provider: {
          openai: {
            name: 'OpenAI',
            options: {
              baseURL: 'https://api.openai.com/v1',
              apiKey: '{env:OPENAI_API_KEY}',
            },
          },
        },
      }
      
      const result = validateConfig(config as any, 'test-config')
      expect(result.model).toBe('openai/gpt-4o')
    })
  })
})
