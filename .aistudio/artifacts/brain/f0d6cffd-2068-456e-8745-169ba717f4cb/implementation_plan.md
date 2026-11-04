# Implementation Plan — Mira Inference Engine (MIE) & Ollama Integration

Implement a robust local inference layer supporting Ollama (`ollama/qwen2.5:1.5b`), strict privacy routing (`local_only` vs `cloud_allowed`), resource management, health checks, and gateway integration.

## Proposed Changes

### 1. New Package: `packages/inference/`
- **`package.json` & `tsconfig.json`**: Package configuration for monorepo integration.
- **`src/core/`**: `inference-engine.ts`, `model-registry.ts`, `request-context.ts` for orchestrating requests and tracking model capabilities.
- **`src/providers/`**: `provider.interface.ts`, `ollama.provider.ts`, `cloud.provider.ts` integrating OpenAI-compatible Ollama endpoints (`http://127.0.0.1:11434/v1`).
- **`src/routing/`**: `model-router.ts`, `routing-policy.ts` enforcing `local_only` (never falling back to cloud) and `cloud_allowed` policies.
- **`src/resources/`**: `resource-monitor.ts`, `concurrency-manager.ts` limiting concurrent local requests to 1 and enforcing 2048 token context windows.
- **`src/security/`**: `privacy-policy.ts`, `provider-allowlist.ts` guaranteeing local-only privacy isolation.
- **`src/telemetry/`**: `inference-metrics.ts` tracking latency, token usage, and failure rates.
- **`tests/`**: Unit tests for Ollama provider, model registry, resource manager, and routing logic.

### 2. Integration with Mira Server (`packages/server/`)
- **`src/config/defaults.ts`**: Register Ollama provider (`ollama/qwen2.5:1.5b`) with OpenAI-compatible transport config.
- **`src/providers/registry.ts`**: Support local provider health, capability validation, and fallback handling.
- **`src/routes/health.ts`**: Expose local Ollama runtime health and readiness status.

### 3. Documentation (`docs/inference/`)
- `ARCHITECTURE.md`, `CONFIGURATION.md`, `SECURITY.md`, `BENCHMARKING.md`.

## Verification Plan

### Automated Tests
- Run `bun test` across `packages/inference` and `packages/server` to verify Ollama provider unit tests, routing security tests (`local_only` isolation), and gateway regression tests.
- Verify health check endpoints and server compilation.
