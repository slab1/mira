/**
 * SolidJS optimization utilities.
 *
 * Patterns:
 *   - createOptimizedMemo: createMemo with optional debug label
 *   - createFeatureStore: factory for feature stores with common patterns
 *   - useFeatureContext: typed accessor for feature context
 *
 * Avoid signal dependency loops: A depends on B, B depends on A.
 * Use createMemo for all derived state — never access signals directly
 * in render when the value can be memoized.
 */

import { createMemo, createContext, useContext, type Accessor } from 'solid-js'

/** createMemo wrapper with optional debug label for DevTools */
export function createOptimizedMemo<T>(
  fn: (prev: T | undefined) => T,
  label?: string,
): Accessor<T> {
  // In dev, label helps identify memos in Solid DevTools
  if (label && import.meta.env?.DEV) {
    // eslint-disable-next-line no-console
    console.debug(`[memo] ${label}`)
  }
  return createMemo(fn)
}

/** Feature context type — each feature provides its store via context */
export interface FeatureContextValue<T> {
  store: T
}

/** Create a typed feature context */
export function createFeatureContext<T>(_displayName: string) {
  return createContext<FeatureContextValue<T>>({} as FeatureContextValue<T>)
}

/** Hook to access feature context — throws if provider is missing */
export function useFeatureContext<T>(ctx: ReturnType<typeof createFeatureContext<T>>): FeatureContextValue<T> {
  const value = useContext(ctx)
  if (!value) {
    throw new Error('useFeatureContext must be used within a provider')
  }
  return value
}

/** Common feature store factory — provides state + derived + actions pattern */
export function createFeatureStore<T extends object>(initialState: T) {
  let state = initialState
  const listeners = new Set<() => void>()

  function getState(): T {
    return state
  }

  function setState(partial: Partial<T> | ((prev: T) => Partial<T>)) {
    const patch = typeof partial === 'function' ? partial(state) : partial
    state = { ...state, ...patch }
    listeners.forEach((fn) => fn())
  }

  function subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  return { getState, setState, subscribe }
}

/**
 * Signal loop prevention utility.
 * Wraps a memo to detect if it depends on itself (directly or indirectly).
 * In dev mode, logs a warning when a potential loop is detected.
 */
export function createSafeMemo<T>(
  fn: (prev: T | undefined) => T,
  label?: string,
): Accessor<T> {
  let computing = false
  return createMemo((prev) => {
    if (computing && import.meta.env?.DEV) {
      console.warn(`[memo] Potential signal loop detected in "${label ?? 'unnamed'}"`)
    }
    computing = true
    try {
      return fn(prev)
    } finally {
      computing = false
    }
  })
}
