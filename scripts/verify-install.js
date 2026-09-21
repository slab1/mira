#!/usr/bin/env node
/**
 * verify-install.js — fail-fast integrity check for node_modules.
 *
 * Why this exists (2026-09-20): partial `bun install` extractions
 * (disk-full kills, concurrent installs, proot EPERM) leave packages
 * with package.json present but entry files missing. Bun then reports
 * cryptic "Cannot find package X" / "File not found .../node_modules/X"
 * minutes later in build/test instead of at install time.
 *
 * What it does: for every dependency of the root + workspace packages,
 * resolves <dep>/package.json from the repo root and asserts the entry
 * files (main/module/bin/exports["."]) exist on disk.
 *
 * Usage: node scripts/verify-install.js
 * Exit 0 = healthy, 1 = broken (prints missing files).
 * Zero dependencies — runs with plain node.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const ROOT = path.resolve(__dirname, '..');

function entryTargets(pkg) {
  const out = new Set();
  const add = (t) => {
    if (typeof t === 'string' && t && !t.startsWith('http')) out.add(t.replace(/^\.\//, ''));
  };
  add(pkg.main);
  add(pkg.module);
  if (typeof pkg.browser === 'string') add(pkg.browser);
  if (typeof pkg.bin === 'string') add(pkg.bin);
  else if (pkg.bin && typeof pkg.bin === 'object') Object.values(pkg.bin).forEach(add);
  const exp = pkg.exports;
  if (typeof exp === 'string') add(exp);
  else if (Array.isArray(exp)) exp.forEach(add);
  else if (exp && typeof exp === 'object') {
    const dot = exp['.'];
    if (typeof dot === 'string') add(dot);
    else if (Array.isArray(dot)) dot.forEach(add);
    else if (dot && typeof dot === 'object') {
      for (const k of ['import', 'require', 'default', 'node', 'bun', 'types']) add(dot[k]);
    }
  }
  return [...out].map((t) => t.split('?')[0].split('#')[0]).filter((t) => t && !t.includes('*'));
}

function workspaceDirs() {
  const dirs = [ROOT];
  let rootPkg = {};
  try {
    rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  } catch {}
  const patterns = rootPkg.workspaces || [];
  for (const pat of patterns) {
    // only supports "dir/*" globs (enough for packages/*)
    const base = pat.replace(/\/\*$/, '');
    const abs = path.join(ROOT, base);
    let children = [];
    try {
      children = fs.readdirSync(abs);
    } catch {
      continue;
    }
    for (const c of children) {
      const d = path.join(abs, c);
      try {
        if (fs.statSync(d).isDirectory() && fs.existsSync(path.join(d, 'package.json'))) dirs.push(d);
      } catch {}
    }
  }
  return dirs;
}

let failures = [];
let checked = 0;

for (const dir of workspaceDirs()) {
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  // Resolve from the DEPENDENT's directory: workspace deps live in
  // packages/<name>/node_modules (symlinks), hoisted ones in root.
  // Resolving everything from root yields false "not installed" hits.
  const requireFromDir = createRequire(path.join(dir, 'package.json'));
  const deps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };
  for (const name of Object.keys(deps)) {
    if (name.startsWith('@mira/')) continue; // workspace self-link, checked via dir existence
    checked++;
    let pjPath;
    try {
      pjPath = requireFromDir.resolve(`${name}/package.json`);
    } catch {
      failures.push(`${name} (wanted by ${path.relative(ROOT, dir) || '.'}): cannot resolve package.json (not installed?)`);
      continue;
    }
    const pkgDir = path.dirname(pjPath);
    let depPkg;
    try {
      depPkg = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
    } catch {
      failures.push(`${name}: package.json unreadable at ${pjPath}`);
      continue;
    }
    for (const t of entryTargets(depPkg)) {
      if (!fs.existsSync(path.join(pkgDir, t))) failures.push(`${name}: missing entry file ${t}`);
    }
  }
}

if (failures.length) {
  console.error(`verify-install: FAIL — ${failures.length} problem(s) across ${checked} deps:`);
  for (const f of failures.slice(0, 30)) console.error(`  - ${f}`);
  if (failures.length > 30) console.error(`  ... and ${failures.length - 30} more`);
  console.error('\nFix: free disk space (need ~2G), then run scripts/install.sh (single guarded install).');
  console.error('Do NOT run concurrent `bun install` processes — they corrupt the store.');
  process.exit(1);
}
console.log(`verify-install: OK — ${checked} deps resolve with entry files present.`);
