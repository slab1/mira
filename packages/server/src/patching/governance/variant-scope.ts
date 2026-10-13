/**
 * Governance — variant scope.
 *
 * The candidate variant (see variant.ts) is a disposable, patched copy of the
 * source tree. For a canary to mean anything, requests routed to the candidate
 * arm must actually operate against THAT tree: file writes land in the copy,
 * reads see the patched code, and the production tree stays untouched for the
 * baseline arm.
 *
 * This holds the mapping from a request/session key to the variant root and
 * answers the two questions the rest of the system needs:
 *
 *   rootFor(key) — the working root a tool should use for this arm
 *   allowedRoots(key, base) — the roots the path policy may accept, which must
 *     include the variant directory. The candidate tree lives in a temp
 *     worktree, so it is outside the configured allowedRoots and would
 *     otherwise be denied by the guardrails on every single file operation.
 *
 * Scoped deliberately: a candidate may only ever redirect work INTO its own
 * variant directory. A path that escapes it is rejected rather than silently
 * falling back to the production tree, because "the candidate wrote to
 * production" is exactly the failure this exists to prevent.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'

export interface VariantScopeOptions {
  /** Production working root; tool execution defaults here. */
  productionRoot: string
}

export class VariantScope {
  private readonly productionRoot: string
  private byKey = new Map<string, string>()

  constructor(opts: VariantScopeOptions) {
    this.productionRoot = resolve(opts.productionRoot)
  }

  /** Bind a request/session key to a candidate root. */
  attach(key: string, variantRoot: string): void {
    this.byKey.set(key, resolve(variantRoot))
  }

  detach(key: string): void {
    this.byKey.delete(key)
  }

  /** Drop every binding for a variant root (after teardown). */
  detachRoot(variantRoot: string): void {
    const target = resolve(variantRoot)
    for (const [k, v] of [...this.byKey]) {
      if (v === target) this.byKey.delete(k)
    }
  }

  clear(): void {
    this.byKey.clear()
  }

  /** The working root for this arm — candidate root, else production. */
  rootFor(key: string | undefined): string {
    if (!key) return this.productionRoot
    const bound = this.byKey.get(key)
    return bound ?? this.productionRoot
  }

  /** The candidate root for this arm, or undefined when on the baseline arm. */
  variantFor(key: string | undefined): string | undefined {
    if (!key) return undefined
    return this.byKey.get(key)
  }

  /** True when this key is on the candidate arm. */
  isCandidate(key: string | undefined): boolean {
    return key !== undefined && this.byKey.has(key)
  }

  /**
   * Roots the path policy may accept for this arm. On the candidate arm the
   * production root is deliberately NOT included — a candidate must not write
   * to production.
   */
  allowedRoots(key: string | undefined, base: string[] = []): string[] {
    const variant = this.variantFor(key)
    if (!variant) return base
    return [variant, ...base.filter((r) => resolve(r) !== this.productionRoot)]
  }

  /**
   * Rewrite a tool path so it resolves inside this arm's root.
   *
   * Returns null when the path escapes the arm's root — a traversal or an
   * absolute path pointing outside the candidate. Refusing is deliberate: the
   * caller must not quietly retry against production.
   */
  resolvePath(key: string | undefined, path: string): string | null {
    const root = this.rootFor(key)
    const target = isAbsolute(path) ? resolve(path) : resolve(root, path)
    const rel = relative(root, target)
    if (rel === '') return root
    if (rel.startsWith('..') || rel.startsWith(`..${sep}`)) return null
    if (rel.split(sep)[0] === '..') return null
    return target
  }
}

let shared: VariantScope | undefined

export function getVariantScope(): VariantScope {
  return (shared ??= new VariantScope({ productionRoot: process.cwd() }))
}

export function resetVariantScope(productionRoot?: string): VariantScope {
  shared = new VariantScope({ productionRoot: productionRoot ?? process.cwd() })
  return shared
}
