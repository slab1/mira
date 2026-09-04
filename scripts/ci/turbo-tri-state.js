#!/usr/bin/env node
/**
 * scripts/ci/turbo-tri-state.js — H3-C Fix 1 (monorepo verdict §5.1 / §7.2).
 *
 * Implements `--continue` tri-state selection per job type. NOTE: `continue`
 * is a turbo CLI flag ONLY (turbo.json must NOT get a `continue` key —
 * reverted in c49d8d2a). All turbo invocations in CI use bare `--continue`;
 * the tri-state lives in THIS helper's exit code, which gates downstream jobs:
 *
 *   never                    → a --require (blocking) package failed → exit 1,
 *                               downstream stays red/blocked.
 *   dependencies-successful  → only non-blocking packages failed → ::warning::,
 *                               exit 0, downstream still runs.
 *   always                   → no failures (or no summary to judge) → ::notice::,
 *                               exit 0, everything proceeds.
 *
 * Per-job turbo flag selection (all boolean `--continue` on turbo 2.10.x):
 *
 *   typecheck → --continue   (mode: dependencies-successful)
 *   build     → --continue   (mode: always; post-hoc gate via --require)
 *   test      → --continue   (mode: dependencies-successful)
 *   eval      → --continue   (mode: always; fast-tier never blocks merge)
 *
 * Usage in CI (see .github/workflows/ci.yml):
 *
 *   node scripts/ci/turbo-tri-state.js --require=@mira/server,@mira/shared
 *   node scripts/ci/turbo-tri-state.js --require=@mira/server --summary=.turbo/runs/<id>.json
 *   node scripts/ci/turbo-tri-state.js --failed=@mira/tui --require=@mira/server  # no summary file
 *   node scripts/ci/turbo-tri-state.js --print-flag --job=build                   # prints "--continue"
 *   node scripts/ci/turbo-tri-state.js --list                                     # per-job table
 *
 * Exit codes: 0 = proceed (always / dependencies-successful), 1 = block (never).
 * Missing/unparseable summary NEVER fails — it prints a notice and exits 0,
 * so this step is safe to run with `if: always()` on runners without
 * `--summarize` output.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Tri-state selection per job type. Values are the downstream-gating mode;
// the turbo CLI flag is boolean `--continue` for every job on turbo 2.10.x.
const CONTINUE_MODE = {
  typecheck: 'dependencies-successful',
  build: 'always',
  test: 'dependencies-successful',
  eval: 'always',
};

function flagFor(job) {
  if (!Object.prototype.hasOwnProperty.call(CONTINUE_MODE, job)) {
    throw new Error(`unknown job "${job}" (expected one of: ${Object.keys(CONTINUE_MODE).join(', ')})`);
  }
  // Turbo 2.10.x: --continue is a boolean CLI flag (no =value form).
  return '--continue';
}

function selectContinueMode(job) {
  if (!Object.prototype.hasOwnProperty.call(CONTINUE_MODE, job)) {
    throw new Error(`unknown job "${job}" (expected one of: ${Object.keys(CONTINUE_MODE).join(', ')})`);
  }
  return CONTINUE_MODE[job];
}

function parseArgs(argv) {
  const out = { require: [], failed: [], summary: null, job: null, printFlag: false, list: false };
  for (const arg of argv) {
    if (arg.startsWith('--require=')) out.require = arg.slice(10).split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg.startsWith('--failed=')) out.failed = arg.slice(9).split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg.startsWith('--summary=')) out.summary = arg.slice(10);
    else if (arg.startsWith('--job=')) out.job = arg.slice(6);
    else if (arg === '--print-flag') out.printFlag = true;
    else if (arg === '--list') out.list = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

function latestSummary(explicit) {
  if (explicit) return explicit;
  const dir = path.join(process.cwd(), '.turbo', 'runs');
  let entries;
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  entries.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return path.join(dir, entries[0]);
}

// A task counts as failed when its status/state field says so across the
// summary shapes turbo has emitted (status | state | result).
function isFailedTask(t) {
  for (const key of ['status', 'state', 'result']) {
    const v = t[key];
    if (typeof v === 'string' && /^(failed|failure|error|errored)$/i.test(v.trim())) return true;
  }
  return false;
}

// Match a failed task against a --require entry: entry matches the task's
// package name, its full taskId ("@mira/server#build"), or the bare task id.
function matchesRequire(task, entry) {
  const pkg = task.package || task.packageName || '';
  const taskId = task.taskId || task.id || '';
  const bare = task.task || task.name || '';
  return entry === pkg || entry === taskId || entry === bare || (taskId !== '' && taskId.startsWith(`${entry}#`));
}

function failedFromSummary(summaryPath) {
  const raw = fs.readFileSync(summaryPath, 'utf8');
  const data = JSON.parse(raw);
  const tasks = Array.isArray(data) ? data : data.tasks || data.executionSummary || [];
  if (!Array.isArray(tasks)) throw new Error(`unrecognized summary shape in ${summaryPath}`);
  return tasks.filter(isFailedTask);
}

function main(argv) {
  const opts = parseArgs(argv);

  if (opts.help) {
    console.log('Usage: node scripts/ci/turbo-tri-state.js --require=pkg1,pkg2 [--summary=path] [--failed=pkgA,...] [--print-flag --job=build] [--list]');
    return 0;
  }

  if (opts.list) {
    for (const job of Object.keys(CONTINUE_MODE)) {
      console.log(`${job}: mode=${CONTINUE_MODE[job]} flag=${flagFor(job)}`);
    }
    return 0;
  }

  if (opts.printFlag) {
    if (!opts.job) throw new Error('--print-flag requires --job=<typecheck|build|test|eval>');
    console.log(flagFor(opts.job));
    return 0;
  }

  // Collect failed tasks: explicit --failed override wins (no summary needed),
  // otherwise read the latest turbo run summary; absent/unparseable summary
  // is a graceful no-op (never red on missing evidence).
  let failed = opts.failed.map((f) => ({ taskId: f, package: f }));
  let summaryPath = null;
  if (failed.length === 0) {
    summaryPath = latestSummary(opts.summary);
    if (opts.summary && !summaryPath) {
      console.log(`::notice::turbo-tri-state: summary not found at ${opts.summary} — nothing to gate (always).`);
      return 0;
    }
    if (summaryPath) {
      try {
        failed = failedFromSummary(summaryPath);
      } catch (err) {
        console.log(`::notice::turbo-tri-state: ignoring unparseable summary ${summaryPath}: ${err.message} (always).`);
        return 0;
      }
    } else {
      console.log('::notice::turbo-tri-state: no .turbo/runs summary found — nothing to gate (always).');
      return 0;
    }
  }

  const total = failed.length;
  if (total === 0) {
    console.log(`::notice::turbo-tri-state: 0 failed tasks${summaryPath ? ` in ${summaryPath}` : ''} (always).`);
    return 0;
  }

  const blocking = failed.filter((t) => opts.require.some((r) => matchesRequire(t, r)));
  const label = (t) => t.taskId || t.id || t.package || JSON.stringify(t);
  if (blocking.length > 0) {
    console.log(`::error::turbo-tri-state: ${blocking.length} blocking failure(s) / ${total} failed (never): ${blocking.map(label).join(', ')}`);
    return 1;
  }
  console.log(`::warning::turbo-tri-state: ${total} non-blocking failure(s), required [${opts.require.join(', ')}] green (dependencies-successful): ${failed.map(label).join(', ')}`);
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`::error::turbo-tri-state: ${err.message}`);
    process.exit(2);
  }
}

module.exports = { CONTINUE_MODE, selectContinueMode, flagFor, isFailedTask, matchesRequire };
