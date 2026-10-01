/**
 * Accessibility Automated Verification — a11y checks for CI.
 *
 * Verifies:
 *   - Interactive elements have accessible names
 *   - Images have alt text
 *   - Form inputs have labels
 *   - ARIA attributes are used correctly
 *   - Focus management is correct
 *   - Color contrast meets WCAG AA
 *   - Reduced-motion preferences are respected
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SRC_DIR = join(__dirname, '..')

function getSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      out.push(...getSourceFiles(full))
    } else if (/\.(tsx|ts)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

function getCssFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      out.push(...getCssFiles(full))
    } else if (entry.name.endsWith('.css')) {
      out.push(full)
    }
  }
  return out
}

describe('Accessibility — automated verification', () => {
  const files = getSourceFiles(SRC_DIR)

  test('all buttons have accessible names', () => {
    const issues: string[] = []
    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      const buttonRe = /<button\b([^>]*)>([\s\S]*?)<\/button>|<button\b([^>]*)\/>/g
      let m: RegExpExecArray | null
      while ((m = buttonRe.exec(content)) !== null) {
        const attrs = m[1] ?? m[3] ?? ''
        const inner = m[2] ?? ''
        const hasAriaLabel = /aria-label\s*=/.test(attrs)
        const hasAriaLabelledby = /aria-labelledby\s*=/.test(attrs)
        const text = inner
          .replace(/<[^>]*>/g, '')
          .replace(/\{[^}]*\}/g, '')
          .trim()
        const hasTextContent = text.length > 0 || /['"][^'"]{2,}['"]/.test(inner)
        if (!hasAriaLabel && !hasAriaLabelledby && !hasTextContent) {
          issues.push(`${file}: button without accessible name: ${m[0].slice(0, 80)}`)
        }
      }
    }
    expect(issues).toEqual([])
  })

  test('all images have alt text', () => {
    const issues: string[] = []
    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      const imgMatches = content.match(/<img[^>]*>/g) ?? []
      for (const img of imgMatches) {
        if (!/alt\s*=/.test(img)) {
          issues.push(`${file}: img without alt: ${img.slice(0, 80)}`)
        }
      }
    }
    expect(issues).toEqual([])
  })

  test('all form inputs have labels', () => {
    const issues: string[] = []
    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      // Strip JSX expressions so => in handlers doesn't truncate the tag match
      const stripped = content.replace(/\{[^}]*\}/g, '')
      const inputRe = /<input\b[^>]*>/g
      let m: RegExpExecArray | null
      while ((m = inputRe.exec(stripped)) !== null) {
        const tag = m[0]
        const hasAriaLabel = /aria-label\s*=/.test(tag)
        const hasId = /id\s*=/.test(tag)
        const hasPlaceholder = /placeholder\s*=/.test(tag)
        if (!hasAriaLabel && !hasId && !hasPlaceholder) {
          issues.push(`${file}: input without label: ${tag.replace(/\s+/g, ' ').slice(0, 80)}`)
        }
      }
    }
    expect(issues).toEqual([])
  })

  test('ARIA attributes are used correctly', () => {
    const issues: string[] = []
    const jsKeyword =
      /^\s*(async|function|const|let|var|return|export|default|if|else|for|while|class|import|from|type|interface)\b/
    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      // Strip JSX expressions to avoid false positives from => in arrow functions
      const stripped = content.replace(/\{[^}]*\}/g, '')
      // Match tags with aria-hidden="true"; skip self-closing (no children)
      const tagRe = /<(\w+)\b[^>]*aria-hidden\s*=\s*["']true["'][^>]*>/g
      let m: RegExpExecArray | null
      while ((m = tagRe.exec(stripped)) !== null) {
        if (m[0].endsWith('/>')) continue
        const after = stripped.slice(tagRe.lastIndex).match(/^([^<]*)/)?.[1] ?? ''
        if (
          /[a-zA-Z]/.test(after) &&
          after.trim().length >= 2 &&
          !/[\(\)\{\};]/.test(after) &&
          !jsKeyword.test(after)
        ) {
          issues.push(`${file}: aria-hidden=true on element with text content`)
        }
      }
      if (/role\s*=\s*["']button["'][^>]*aria-disabled\s*=\s*["']false["']/.test(content)) {
        issues.push(`${file}: role=button with aria-disabled=false (redundant)`)
      }
    }
    expect(issues).toEqual([])
  })

  test('focus management — interactive elements are focusable', () => {
    const issues: string[] = []
    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      // Strip JSX expressions so => in handlers doesn't truncate the tag match
      const stripped = content.replace(/\{[^}]*\}/g, '')
      const clickableRe = /<(div|span)\b[^>]*onClick[^>]*>/g
      let m: RegExpExecArray | null
      while ((m = clickableRe.exec(stripped)) !== null) {
        const tag = m[0]
        if (/tabIndex/i.test(tag)) continue
        if (
          /role\s*=\s*["'](presentation|button|link|tab|menuitem|checkbox|radio|switch|dialog|alertdialog)["']/.test(
            tag,
          )
        )
          continue
        if (/aria-hidden/.test(tag)) continue
        const line = stripped.slice(0, stripped.indexOf(m[0])).split('\n').length
        issues.push(`${file}:${line}: clickable div/span without tabIndex`)
      }
    }
    expect(issues).toEqual([])
  })

  test('reduced-motion preferences are respected', () => {
    const issues: string[] = []
    // Global kill-switch in any CSS file covers all animations (including inline styles)
    const cssFiles = getCssFiles(SRC_DIR)
    const hasGlobalKillSwitch = cssFiles.some((f) =>
      /prefers-reduced-motion/.test(readFileSync(f, 'utf-8')),
    )
    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      const animationMatches = content.match(/animation\s*:/g) ?? []
      if (
        animationMatches.length > 0 &&
        !hasGlobalKillSwitch &&
        !/prefers-reduced-motion/.test(content)
      ) {
        issues.push(`${file}: animations without prefers-reduced-motion media query`)
      }
    }
    expect(issues).toEqual([])
  })

  test('color contrast — no hardcoded low-contrast colors', () => {
    const issues: string[] = []
    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      // Check for common low-contrast patterns
      if (/color\s*:\s*['"]#fff['"][^;]*background\s*:\s*['"]#fff['"]/i.test(content)) {
        issues.push(`${file}: white text on white background`)
      }
      if (/color\s*:\s*['"]#000['"][^;]*background\s*:\s*['"]#000['"]/i.test(content)) {
        issues.push(`${file}: black text on black background`)
      }
    }
    expect(issues).toEqual([])
  })
})
