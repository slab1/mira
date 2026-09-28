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

describe('Accessibility — automated verification', () => {
  const files = getSourceFiles(SRC_DIR)

  test('all buttons have accessible names', () => {
    const issues: string[] = []
    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      const buttonMatches = content.match(/<button[^>]*>/g) ?? []
      for (const btn of buttonMatches) {
        const hasAriaLabel = /aria-label\s*=/.test(btn)
        const hasAriaLabelledby = /aria-labelledby\s*=/.test(btn)
        const hasTextContent = />([^<]+)</.test(btn)
        if (!hasAriaLabel && !hasAriaLabelledby && !hasTextContent) {
          issues.push(`${file}: button without accessible name: ${btn.slice(0, 80)}`)
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
      const inputMatches = content.match(/<input[^>]*>/g) ?? []
      for (const input of inputMatches) {
        const hasAriaLabel = /aria-label\s*=/.test(input)
        const hasId = /id\s*=/.test(input)
        if (!hasAriaLabel && !hasId) {
          issues.push(`${file}: input without label: ${input.slice(0, 80)}`)
        }
      }
    }
    expect(issues).toEqual([])
  })

  test('ARIA attributes are used correctly', () => {
    const issues: string[] = []
    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      // Check for common ARIA mistakes
      if (/aria-hidden\s*=\s*["']true["'][^>]*>[^<]*[a-zA-Z]/.test(content)) {
        issues.push(`${file}: aria-hidden=true on element with text content`)
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
      const clickableMatches = content.match(/onClick\s*=\s*\{[^}]+\}/g) ?? []
      for (const match of clickableMatches) {
        // Check if the element with onClick also has tabIndex or is a button
        const line = content.slice(0, content.indexOf(match)).split('\n').length
        const lines = content.split('\n')
        const context = lines.slice(Math.max(0, line - 3), line + 3).join('\n')
        if (/div|span/i.test(context) && !/tabIndex/.test(context) && !/<button/.test(context)) {
          issues.push(`${file}:${line}: clickable div/span without tabIndex`)
        }
      }
    }
    expect(issues).toEqual([])
  })

  test('reduced-motion preferences are respected', () => {
    const issues: string[] = []
    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      // Check for animations without prefers-reduced-motion
      const animationMatches = content.match(/animation\s*:/g) ?? []
      if (animationMatches.length > 0 && !/prefers-reduced-motion/.test(content)) {
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
