---
name: docker-deploy
description: Container builds and deployment — multi-stage images, small layers, health checks, env config.
triggers:
  - docker
  - dockerfile
  - container
  - deploy
  - image build
  - compose
---

# Docker & Deploy

## Dockerfile discipline
- Multi-stage: build stage compiles; runtime stage copies ONLY artifacts + runtime deps.
- Order layers by change frequency: system deps → package manifests install → source copy.
- `.dockerignore`: node_modules, .git, dist, secrets, logs — smaller builds, fewer leaks.
- Pin base image digests/tags (`node:22-alpine`, not `latest`); run as non-root USER.
- One concern per container; logs to stdout/stderr (collector's job, not file mounts).

## Configuration
- Config via env vars only — same image across environments, `docker run -e` / compose env.
- Never bake secrets into images or layer history (they survive deletion).

## Runtime readiness
- HEALTHCHECK or orchestrator probe hitting a real dependency-checked endpoint.
- Graceful shutdown: trap SIGTERM → stop accepting → drain → exit 0.
- Expose only needed ports; set resource limits (memory/cpu) in compose/k8s.

## Debugging a failing deploy
1. `docker logs` first, then `docker run -it --entrypoint sh` to poke interactively.
2. Reproduce the build locally with the exact same tag/base — cache differences lie.
3. Check the healthcheck endpoint manually from INSIDE the container network.
