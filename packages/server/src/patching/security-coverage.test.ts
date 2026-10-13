/**
 * Code-injection coverage for the security stage.
 *
 * COVERAGE GAP FOUND BY EXECUTION: the scanner declared the kinds
 * "command-injection", "xss" and "path-traversal" and defined
 * COMMAND_INJECTION_RE / PATH_TRAVERSAL_RE, but scanText() only ever ran
 * INJECTION_PATTERNS and SECRET_PATTERNS. Those constants were reachable only
 * from scanToolArgs(), which runs only when `tool` is supplied — and the
 * governance gate calls scan({ text, route }). Declaring a kind is not
 * detecting it.
 *
 * Measured before the fix, 7 of 9 hostile patches passed clean: eval,
 * innerHTML, exec-with-concat, child_process.exec, concatenated SQL, md5, and
 * disabled TLS verification. Only the hardcoded-key exfil was caught.
 *
 * These tests pin BOTH directions, because a security gate that cries wolf is
 * bypassed just as surely as one that sleeps: the hostile set must block, and
 * ordinary repository code must not.
 */
import { describe, test, expect } from 'bun:test'
import { SecurityScanner } from './security.js'
import { SecurityReview } from './governance/security-review.js'

const blocking = (text: string) =>
  new SecurityScanner()
    .scan({ text })
    .issues.filter((i) => i.severity === 'high' || i.severity === 'critical')

describe('SecurityScanner — code injection coverage', () => {
  test.each([
    ['eval of untrusted input', 'const r = eval(userInput)', 'code-eval'],
    ['runInNewContext of a string', 'vm.runInNewContext(userCode)', 'code-eval'],
    ['shell command from a variable', 'child_process.exec(userCmd)', 'command-injection'],
    ['shell command concatenated', 'exec("rm -rf " + path)', 'command-injection'],
    ['shell command interpolated', 'exec(`ls ${dir}`)', 'command-injection'],
    ['unescaped HTML sink', 'el.innerHTML = userControlled', 'xss'],
    ['insertAdjacentHTML', 'el.insertAdjacentHTML("beforeend", html)', 'xss'],
    [
      'dangerouslySetInnerHTML',
      'const x = <div dangerouslySetInnerHTML={{ __html: body }} />',
      'xss',
    ],
    [
      'SQL by concatenation',
      'db.query("SELECT * FROM t WHERE id = " + req.body.id)',
      'sql-injection',
    ],
    ['SQL by interpolation', 'db.query(`SELECT * FROM t WHERE id = ${id}`)', 'sql-injection'],
    [
      'TLS verification disabled',
      'https.request({ rejectUnauthorized: false })',
      'insecure-transport',
    ],
    ['auth disabled', 'if (skipAuth) return next()', 'permission-bypass'],
  ])('%s is reported', (_name, text, kind) => {
    const issues = blocking(text)
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.map((i) => i.kind)).toContain(kind as never)
  })

  // A gate that fires on correct code is a gate operators learn to bypass, so
  // the benign side is pinned just as hard as the hostile side.
  test.each([
    ['parameterized query', "const rows = await db.query('SELECT * FROM t WHERE id = ?', [id])"],
    ['argv-array spawn', "await execFile('git', ['rev-parse', 'HEAD'])"],
    ['literal shell command', "const out = execSync('git status --porcelain').toString()"],
    ['static innerHTML', "div.innerHTML = '<b>static</b>'"],
    ['textContent sink', 'el.textContent = userSuppliedName'],
    ['pre-sanitized HTML', 'element.outerHTML = sanitizedHtml'],
    ['constant Function body', "const fn = new Function('return 1')"],
    ['comment mentioning eval', '// never use eval() on user input'],
    ['TLS verification kept', 'https.request({ rejectUnauthorized: true })'],
    ['non-SQL query client', "queryClient.query({ queryKey: ['u', id] })"],
    ['identifier containing "eval"', 'export const evalCount = 0'],
    ['auth field in a config', 'auth: false, // legacy'],
  ])('%s is NOT reported', (_name, text) => {
    expect(blocking(text)).toEqual([])
  })

  // Context lines are pre-existing code; a diff that only touches an adjacent
  // line must not be blocked for something it did not introduce.
  test('a hazard present only in diff CONTEXT does not block the change', () => {
    const diff = [
      'diff --git a/src/legacy.ts b/src/legacy.ts',
      '--- a/src/legacy.ts',
      '+++ b/src/legacy.ts',
      '@@ -10,6 +10,7 @@ export function run(cmd) {',
      '   const out = exec(cmd)   // pre-existing, context line',
      '   return out',
      '+  const label = "hello"',
    ].join('\n')
    expect(blocking(diff)).toEqual([])
  })

  test('the same hazard INTRODUCED by the diff does block', () => {
    const diff = [
      'diff --git a/src/run.ts b/src/run.ts',
      '--- a/src/run.ts',
      '+++ b/src/run.ts',
      '@@ -1,2 +1,3 @@',
      '   const safe = 1',
      '+  const out = exec(userCmd)',
    ].join('\n')
    expect(blocking(diff).map((i) => i.kind)).toContain('command-injection')
  })

  // The point of the whole exercise: the promotion gate must refuse a patch
  // that hands user input to a shell.
  test('the promotion gate refuses a shell-injection patch', async () => {
    const review = new SecurityReview(new SecurityScanner())
    const result = await review.review('+const out = exec(userSuppliedCmd)', 'src/run.ts')
    expect(result.passed).toBe(false)
    expect(result.outcome).toBe('FAILED')
  })

  test('hardening suggestions cover the new kinds', () => {
    const scanner = new SecurityScanner()
    const issues = scanner.scan({ text: 'const r = eval(userInput)\nconst o = exec(cmd)' }).issues
    const suggestions = scanner.hardeningSuggestions(issues)
    expect(suggestions.length).toBeGreaterThan(0)
  })
})
