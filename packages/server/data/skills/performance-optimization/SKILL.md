---
name: performance-optimization
description: Measure-first optimization — profile, find the real bottleneck, fix, re-measure.
triggers:
  - performance
  - slow
  - optimize
  - latency
  - profiling
  - benchmark
  - memory leak
---

# Performance Optimization

## Iron rule
NEVER optimize without a measurement. Guesses waste time and add complexity.

## Process
1. **Define the target**: p95 latency, throughput, memory ceiling — with a number.
2. **Measure baseline**: benchmark script or profiler trace under realistic load.
3. **Locate the bottleneck**: profile; trust the flame graph, not intuition.
   Common culprits: N+1 queries, sync I/O on hot paths, O(n²) loops, chatty IPC,
   repeated parsing/serialization, missing indexes.
4. **Fix the top offender only**, then re-measure. Keep the win, discard the rest.
5. **Guard it**: add a benchmark/regression test so the fix can't silently rot.

## Quick wins checklist
- Batch DB reads; add covering indexes for frequent filters/sorts.
- Cache pure/expensive computations at the right layer (invalidate correctly!).
- Stream large payloads instead of buffering whole files/responses.
- Move CPU-heavy work off request paths (queues, workers).

## Honesty
Report numbers before/after. If the gain is <10% and readability dropped, revert.
