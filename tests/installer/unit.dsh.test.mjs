// Unit tests for bin/lib/dsh.js — the DeepSeek Harness (DSH) install helper.
// Covers the marker-block upsert/strip state machine (same fence convention as
// the OpenClaw SOUL.md helper), the ownership-journaled skill copy, the
// DSH_HOME resolution, and the byte-equivalence invariant between the
// embedded standalone fallback and src/rules/caveman-activate.md.
//
// Isolation contract: this suite calls the helper directly with an explicit
// tmp `dshHome` and never spawns the installer or reads ambient env — so it
// can never sweep a developer's real ~/.dsh. The final guard test pins that
// contract; spawn-based suites instead use isolated-homes.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireCjs = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const DSH = requireCjs(path.join(REPO_ROOT, 'bin', 'lib', 'dsh.js'));

const QUIET = { write: () => {}, note: () => {}, warn: () => {} };

function freshDshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'caveman-dsh-test-'));
  fs.mkdirSync(path.join(home, '.dsh'), { recursive: true });
  return path.join(home, '.dsh');
}

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

test('resolveDshHome honors DSH_HOME, defaults to ~/.dsh', () => {
  assert.equal(DSH.resolveDshHome({ DSH_HOME: '/tmp/x' }), path.resolve('/tmp/x'));
  assert.equal(DSH.resolveDshHome({}), path.join(os.homedir(), '.dsh'));
});

test('installDsh copies the DSH skill subset and writes the fenced ruleset', () => {
  const home = freshDshHome();
  try {
    const r = DSH.installDsh({ dshHome: home, repoRoot: REPO_ROOT, log: QUIET });
    assert.equal(r.ok, true);
    assert.deepEqual(r.skills.sort(), [...DSH.DSH_SKILL_DIRS].sort());
    for (const name of DSH.DSH_SKILL_DIRS) {
      assert.ok(fs.existsSync(path.join(home, 'skills', name, 'SKILL.md')), `${name}/SKILL.md missing`);
    }
    // Copied body must match the repo source byte-for-byte.
    const src = read(path.join(REPO_ROOT, 'skills', 'caveman', 'SKILL.md'));
    assert.equal(read(path.join(home, 'skills', 'caveman', 'SKILL.md')), src);

    const agentsMd = path.join(home, 'AGENTS.md');
    assert.ok(fs.existsSync(agentsMd));
    const raw = read(agentsMd);
    assert.match(raw, /<!-- caveman-begin -->/);
    assert.match(raw, /<!-- caveman-end -->/);
    assert.match(raw, /Respond terse like smart caveman/);
  } finally {
    fs.rmSync(path.dirname(home), { recursive: true, force: true });
  }
});

test('installDsh is idempotent: re-run leaves one marker block, skills intact', () => {
  const home = freshDshHome();
  try {
    assert.equal(DSH.installDsh({ dshHome: home, repoRoot: REPO_ROOT, log: QUIET }).ok, true);
    const r2 = DSH.installDsh({ dshHome: home, repoRoot: REPO_ROOT, log: QUIET });
    assert.equal(r2.ok, true);
    const raw = read(path.join(home, 'AGENTS.md'));
    assert.equal(raw.split(DSH.MARK_BEGIN).length - 1, 1, 'begin marker duplicated');
    assert.equal(raw.split(DSH.MARK_END).length - 1, 1, 'end marker duplicated');
  } finally {
    fs.rmSync(path.dirname(home), { recursive: true, force: true });
  }
});

test('installDsh without a repo fails cleanly (standalone npx case)', () => {
  const home = freshDshHome();
  try {
    const r = DSH.installDsh({ dshHome: home, repoRoot: '/definitely/not/a/repo', log: QUIET });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'repo not available');
    assert.ok(!fs.existsSync(path.join(home, 'skills')), 'nothing should have been written');
  } finally {
    fs.rmSync(path.dirname(home), { recursive: true, force: true });
  }
});

test('installDsh refuses a missing DSH home without --force, creates it with --force', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caveman-dsh-noforce-'));
  const missing = path.join(root, 'not-here', '.dsh');
  try {
    const refused = DSH.installDsh({ dshHome: missing, repoRoot: REPO_ROOT, log: QUIET });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'dsh home missing');
    assert.ok(!fs.existsSync(missing));

    const forced = DSH.installDsh({ dshHome: missing, repoRoot: REPO_ROOT, force: true, log: QUIET });
    assert.equal(forced.ok, true);
    assert.ok(fs.existsSync(path.join(missing, 'skills', 'caveman', 'SKILL.md')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('upsertAgentsMdBlock preserves user content above and below the block', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caveman-dsh-upsert-'));
  const file = path.join(dir, 'AGENTS.md');
  const userContent = '# My user rules\n\nKeep this line.\n';
  fs.writeFileSync(file, userContent);
  try {
    const block = DSH.fencedBlock('Respond terse like smart caveman.\n');
    const r = DSH.upsertAgentsMdBlock(file, block);
    assert.equal(r.changed, true);
    const raw = read(file);
    assert.equal(raw.startsWith(userContent), true, 'user preamble must survive');
    assert.match(raw, /<!-- caveman-begin -->/);
    assert.match(raw, /Keep this line\./);

    // In-place refresh when the block content changes.
    const r2 = DSH.upsertAgentsMdBlock(file, DSH.fencedBlock('Respond terse v2.\n'));
    assert.equal(r2.refreshed, true);
    const raw2 = read(file);
    assert.match(raw2, /Respond terse v2\./);
    assert.equal(raw2.split(DSH.MARK_BEGIN).length - 1, 1);
    assert.equal(raw2.startsWith(userContent), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('upsertAgentsMdBlock repairs damaged markers without eating user content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caveman-dsh-repair-'));
  const file = path.join(dir, 'AGENTS.md');
  // Orphan begin marker (interrupted write): no matching end. The marker is
  // dropped; the user text around it must survive.
  fs.writeFileSync(file, 'keep me\n<!-- caveman-begin -->\nuser text after stray marker\nand keep me\n');
  try {
    const r = DSH.upsertAgentsMdBlock(file, DSH.fencedBlock('ruleset body\n'));
    assert.equal(r.repaired, true);
    const raw = read(file);
    assert.equal(raw.split(DSH.MARK_BEGIN).length - 1, 1, 'exactly one begin after repair');
    assert.equal(raw.split(DSH.MARK_END).length - 1, 1, 'exactly one end after repair');
    assert.match(raw, /^keep me\n/);
    assert.match(raw, /user text after stray marker\n/);
    assert.match(raw, /and keep me\n/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('upsertAgentsMdBlock refuses a symlinked AGENTS.md', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caveman-dsh-symlink-'));
  const target = path.join(dir, 'real.md');
  const link = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(target, 'content\n');
  fs.symlinkSync(target, link);
  try {
    assert.throws(() => DSH.upsertAgentsMdBlock(link, DSH.fencedBlock('x\n')), /refusing non-regular file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stripAgentsMdBlock removes the file when our block was the only content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caveman-dsh-strip-'));
  const file = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(file, DSH.fencedBlock('ruleset body\n'));
  try {
    const r = DSH.stripAgentsMdBlock(file);
    assert.equal(r.changed, true);
    assert.equal(r.removed, true);
    assert.ok(!fs.existsSync(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stripAgentsMdBlock preserves unrelated content and is a no-op without markers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caveman-dsh-strip2-'));
  const file = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(file, 'user rule one\nuser rule two\n');
  try {
    assert.equal(DSH.stripAgentsMdBlock(file).changed, false, 'no markers → no change');
    fs.writeFileSync(file, 'user rule one\n' + DSH.fencedBlock('ruleset body\n') + 'user rule two\n');
    const r = DSH.stripAgentsMdBlock(file);
    assert.equal(r.changed, true);
    // The stripped block's slot may leave a blank line — same damage
    // tolerance as the OpenClaw helper. User lines must survive verbatim.
    const after = read(file);
    assert.match(after, /^user rule one\n/);
    assert.match(after, /user rule two\n$/);
    assert.doesNotMatch(after, /caveman/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('uninstallDsh prunes journaled skills and strips the AGENTS.md block', () => {
  const home = freshDshHome();
  try {
    assert.equal(DSH.installDsh({ dshHome: home, repoRoot: REPO_ROOT, log: QUIET }).ok, true);
    // User content outside our block must survive the uninstall.
    const file = path.join(home, 'AGENTS.md');
    fs.appendFileSync(file, '\nuser rule kept\n');

    const r = DSH.uninstallDsh({ dshHome: home, log: QUIET });
    assert.equal(r.ok, true);
    assert.equal(r.touched, true);
    for (const name of DSH.DSH_SKILL_DIRS) {
      assert.ok(!fs.existsSync(path.join(home, 'skills', name)), `${name} survived uninstall`);
    }
    assert.equal(read(file).trimEnd(), 'user rule kept');
  } finally {
    fs.rmSync(path.dirname(home), { recursive: true, force: true });
  }
});

test('embedded fallback is byte-equivalent to src/rules/caveman-activate.md', () => {
  const canonical = read(path.join(REPO_ROOT, 'src', 'rules', 'caveman-activate.md')).trimEnd() + '\n';
  assert.equal(DSH.loadRuleBody(null), canonical, 'standalone fallback drifted from the canonical ruleset');
});

test('this suite cannot leak the ambient DSH install (no spawns, no ambient env reads)', () => {
  // The unit layer passes an explicit tmp dshHome to every call. The moment
  // this file spawns the installer (which resolves DSH_HOME from the child's
  // env) or reads the ambient environment, a test could sweep — or be
  // denied by — the developer's real DSH install. The spawn-based suites
  // prevent that leak with isolated-homes.mjs; this file's equivalent
  // guarantee is the absence of both mechanisms, pinned here so a future
  // installer-spawn test fails until it adopts that isolation.
  const src = read(new URL(import.meta.url));
  for (const needle of ['child_' + 'process', 'spawn' + 'Sync', 'exec' + 'File', 'process' + '\\.env']) {
    assert.doesNotMatch(src, new RegExp(needle), `unit.dsh.test.mjs must not reference ${needle}`);
  }
});
