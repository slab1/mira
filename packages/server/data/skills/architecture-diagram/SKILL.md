---
name: architecture-diagram
description: Create clear architecture diagrams for systems, data flow, and component interactions.
triggers:
  - architecture diagram
  - system diagram
  - component diagram
  - data flow
  - infra diagram
---
# Architecture Diagram

## Principles
- Start with context: who uses the system, what problem it solves.
- One diagram per concern: C4 Level 1 Context, Level 2 Containers, Level 3 Components.
- Keep nodes to < 20; explode into sub-diagrams otherwise.
- Label interfaces explicitly: protocols, data formats, auth.

## C4 Levels
- Context: external actors ↔ system boundary, main use cases.
- Containers: web, API, worker, DB, cache, message bus.
- Components: services, modules inside a container.
- Code: classes/functions where needed, rarely drawn.

## Notation
- Use standard shapes: rectangle = component, cylinder = DB, cloud = external.
- Arrows = synchronous request, dashed = async/event.
- Annotate throughput/latency SLOs on critical paths.

## Checklist
- All data stores named with type.
- Secrets and auth boundary marked.
- Failure modes noted on critical dependencies.
- Version the diagram; keep in docs/architecture/.
