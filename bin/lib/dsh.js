// caveman → DeepSeek Harness (DSH) install / uninstall helper.
//
// DSH (deepseek-harness) is a plugin-based agent host. Two of its extension
// seams map one-to-one onto caveman's architecture:
//
//   1. Skills — DSH's filesystem skill provider scans (in rank order)
//      <project>/.dsh/skills, <project>/.agents/skills, $DSH_HOME/skills,
//      ~/.agents/skills. A skill is <name>/SKILL.md with YAML frontmatter
//      (`name` + `description` required, kebab-case names) — exactly the
//      format caveman's skills already ship, so we copy them verbatim, no
//      frontmatter merge needed. Skills surface in the Web GUI's `/` command
//      menu (user-invocable) and in the model-facing catalog, so a user-typed
//      `/caveman lite` injects the ruleset body for the model to follow.
//   2. User-global instructions — DSH loads $DSH_HOME/AGENTS.md (default
//      ~/.dsh/AGENTS.md) as a durable baseline into every session. A
//      marker-fenced ruleset block there is the always-on driver — the same
//      seam OpenClaw uses via SOUL.md and opencode via its AGENTS.md.
//
// What this does NOT cover (v1): per-session mode state, a statusline-style
// badge, and caveman-stats — those live in Claude Code hooks and have no DSH
// equivalent yet. "stop caveman" works conversationally through the ruleset.
//
// Idempotent on both writes. Uninstall removes only journaled skill bytes
// (ownership journal via owned-install.js, same contract as opencode/hermes)
// and strips the marker block from AGENTS.md while preserving any
// user-authored content.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const OWNED = require('./owned-install');

const MARK_BEGIN = '<!-- caveman-begin -->';
const MARK_END = '<!-- caveman-end -->';
const AGENTS_FILE = 'AGENTS.md';

// The skill subset that works without Claude Code hooks. Deliberately NOT
// here: caveman-stats (its output is delivered by the caveman-stats.js hook,
// so the body is a no-op outside Claude) and cavecrew (delegates to the
// cavecrew-* Claude subagents, which DSH does not define).
const DSH_SKILL_DIRS = [
  'caveman',
  'caveman-commit',
  'caveman-review',
  'caveman-help',
  'caveman-compress',
];

function resolveDshHome(env = process.env) {
  if (env.DSH_HOME) return path.resolve(env.DSH_HOME);
  return path.join(os.homedir(), '.dsh');
}

function countOccurrences(haystack, needle) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
}

// ── Ruleset block ─────────────────────────────────────────────────────────
// The always-on body is the canonical Tier-3 ruleset, the same single source
// opencode's AGENTS.md block and per-repo --with-init use. The standalone
// fallback (curl|npx case with no repo on disk) must stay byte-equivalent to
// src/rules/caveman-activate.md.

function loadRuleBody(repoRoot) {
  if (repoRoot) {
    const body = readIfExists(path.join(repoRoot, 'src', 'rules', 'caveman-activate.md'));
    if (body) return body.trimEnd() + '\n';
  }
  return [
    'Respond terse like smart caveman. All technical substance stay. Only fluff die.',
    '',
    'Rules:',
    '- Drop: articles (a/an/the), filler (just/really/basically), pleasantries, hedging',
    '- Fragments OK. Short synonyms. Technical terms exact. Code unchanged.',
    '- Pattern: [thing] [action] [reason]. [next step].',
    '- Not: "Sure! I\'d be happy to help you with that."',
    '- Yes: "Bug in auth middleware. Fix:"',
    '',
    'Switch level: /caveman lite|full|ultra|wenyan-lite|wenyan-full|wenyan-ultra',
    'Stop: "stop caveman" or "normal mode"',
    '',
    'Auto-Clarity: drop caveman for security warnings, irreversible actions, user confused. Resume after.',
    '',
    'Boundaries: code/commits/PRs written normal.',
    '',
  ].join('\n');
}

function fencedBlock(ruleBody) {
  return `${MARK_BEGIN}\n${ruleBody}${MARK_END}\n`;
}

// ── AGENTS.md marker-block upsert/strip ───────────────────────────────────
//
// Same fence convention as OpenClaw (SOUL.md) and opencode (AGENTS.md), same
// damage tolerance as the OpenClaw helper: a stray or truncated marker
// (interrupted write, partial user edit) must never turn into data loss.
// stripAll blocks pairs each begin with the nearest end BEFORE the next
// begin; an unpaired marker is removed as just the marker itself, never as a
// span over user content.

function stripAllBlocks(text) {
  let result = '';
  let found = false;
  let i = 0;
  while (i < text.length) {
    const b = text.indexOf(MARK_BEGIN, i);
    if (b === -1) { result += text.slice(i); break; }
    result += text.slice(i, b);
    found = true;
    const nextB = text.indexOf(MARK_BEGIN, b + MARK_BEGIN.length);
    const e = text.indexOf(MARK_END, b + MARK_BEGIN.length);
    if (e !== -1 && (nextB === -1 || e < nextB)) {
      i = e + MARK_END.length; // well-formed block — drop begin..end inclusive
    } else {
      i = b + MARK_BEGIN.length; // orphan begin — drop only the marker itself
    }
    result = result.replace(/\n+$/, '\n');
    const lead = /^\n+/.exec(text.slice(i));
    if (lead) i += lead[0].length - (result ? 1 : 0);
  }
  // Orphan end markers (begin already gone or never written) — drop marker only.
  while (result.includes(MARK_END)) { found = true; result = result.replace(MARK_END, ''); }
  return { next: result, found };
}

function writeFileAtomic(p, content, expectedMode) {
  const dir = path.dirname(p);
  const mode = expectedMode !== undefined ? expectedMode : 0o644;
  const tmp = path.join(dir, `.${path.basename(p)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, p);
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

// Upsert our fenced block in the user-global AGENTS.md. Returns
// { changed, created?, refreshed?, repaired? }.
function upsertAgentsMdBlock(agentsMd, block) {
  let existing = null;
  let existingMode;
  try {
    const st = fs.lstatSync(agentsMd);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error(`refusing non-regular file ${agentsMd}`);
    existing = fs.readFileSync(agentsMd, 'utf8');
    existingMode = st.mode & 0o777;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (existing === null) {
    fs.mkdirSync(path.dirname(agentsMd), { recursive: true });
    writeFileAtomic(agentsMd, block);
    return { changed: true, created: true };
  }

  const nb = countOccurrences(existing, MARK_BEGIN);
  const ne = countOccurrences(existing, MARK_END);
  const b = existing.indexOf(MARK_BEGIN);
  const e = b === -1 ? -1 : existing.indexOf(MARK_END, b);
  if (nb === 1 && ne === 1 && e > b) {
    // One well-formed block. Refresh it in place when the shipped ruleset
    // has changed — a presence-only check left the block stale forever.
    // Only the bytes between our own markers move; user content preserved.
    const currentBlock = existing.slice(b, e + MARK_END.length + 1);
    if (currentBlock === block) return { changed: false, reason: 'already present' };
    const refreshed = existing.slice(0, b) + block + existing.slice(e + MARK_END.length + 1);
    writeFileAtomic(agentsMd, refreshed, existingMode);
    return { changed: true, refreshed: true };
  }

  let base = existing;
  let repaired = false;
  if (nb > 0 || ne > 0) {
    // Damaged markers — strip them safely first, then append one clean block.
    base = stripAllBlocks(existing).next;
    repaired = true;
  }
  const trimmed = base.trimEnd();
  const sep = trimmed === '' ? '' : (trimmed.endsWith('\n') ? '\n' : '\n\n');
  writeFileAtomic(agentsMd, trimmed + sep + block, existingMode);
  return repaired ? { changed: true, repaired: true } : { changed: true };
}

// Strip our fenced block. Returns { changed, removed? }.
function stripAgentsMdBlock(agentsMd) {
  const opened = readIfExists(agentsMd);
  if (opened === null) return { changed: false, reason: 'no AGENTS.md' };
  const { next: stripped, found } = stripAllBlocks(opened);
  if (!found) return { changed: false, reason: 'no marker block' };
  let next = stripped.trimEnd();
  next = next ? next + '\n' : '';
  if (next === '') {
    // Only our block was there — remove the file so DSH doesn't load an
    // empty user-global instructions chain every session.
    try { fs.unlinkSync(agentsMd); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return { changed: true, removed: true };
  }
  let mode;
  try { mode = fs.lstatSync(agentsMd).mode & 0o777; } catch (_) {}
  writeFileAtomic(agentsMd, next, mode);
  return { changed: true };
}

// ── Public API ────────────────────────────────────────────────────────────
function installDsh({ dshHome, repoRoot, dryRun = false, force = false, log = noopLog() } = {}) {
  const home = dshHome || resolveDshHome();
  const skillsSrc = repoRoot ? path.join(repoRoot, 'skills') : null;
  const available = skillsSrc
    ? DSH_SKILL_DIRS.filter((name) => fs.existsSync(path.join(skillsSrc, name, 'SKILL.md')))
    : [];
  if (available.length === 0) {
    log.warn('  dsh install requires the caveman repo on disk (skills/ missing).');
    log.note('  Re-run from a clone or via `npx -y github:JuliusBrussee/caveman -- --only dsh`.');
    return { ok: false, reason: 'repo not available' };
  }

  const agentsMd = path.join(home, AGENTS_FILE);
  if (!fs.existsSync(home)) {
    if (!force) {
      log.warn(`  DSH home not found at ${home}.`);
      log.note('  Either install DeepSeek Harness and re-run, or pass --force to create it.');
      return { ok: false, reason: 'dsh home missing' };
    }
    if (!dryRun) fs.mkdirSync(home, { recursive: true });
  }

  if (dryRun) {
    for (const name of available) {
      log.note(`  would copy skills/${name}/ into ${path.join(home, 'skills', name)}/`);
    }
    log.note(`  would ${fs.existsSync(agentsMd) ? 'update' : 'create'} ${agentsMd} (caveman ruleset block)`);
    return { ok: true, dryRun: true, skills: available };
  }

  try {
    // Skills are journaled as whole directories under the DSH home root, so
    // uninstall removes only bytes this installer wrote. A same-named
    // directory the user owns blocks install unless --force backs it up.
    const operations = available.map((name) => ({
      relativePath: `skills/${name}`,
      write: (stage) => OWNED.copyPath(path.join(skillsSrc, name), stage),
    }));
    OWNED.installOwned({
      root: home,
      integration: 'dsh',
      operations,
      force,
      note: (s) => log.write(s + '\n'),
    });

    const r = upsertAgentsMdBlock(agentsMd, fencedBlock(loadRuleBody(repoRoot)));
    if (r.refreshed) log.write(`  refreshed caveman ruleset in ${agentsMd}\n`);
    else if (r.repaired) log.write(`  repaired damaged caveman markers and wrote ruleset to ${agentsMd}\n`);
    else if (r.created) log.write(`  installed: ${agentsMd}\n`);
    else if (r.changed) log.write(`  appended caveman ruleset to ${agentsMd}\n`);
    else log.note(`  ${agentsMd} already contains the current caveman ruleset`);

    return { ok: true, skills: available };
  } catch (error) {
    // Ownership conflicts surface as installOwned throwing before any write.
    // If the AGENTS.md step failed after the skills were journaled, the
    // journal stays authoritative — --uninstall cleans both up.
    return { ok: false, reason: (error && error.message) || 'unknown error' };
  }
}

function uninstallDsh({ dshHome, dryRun = false, log = noopLog() } = {}) {
  const home = dshHome || resolveDshHome();
  let touched = false;

  if (!fs.existsSync(home)) return { ok: true, touched };

  // 1. Journaled skills — ownership journal is authority, never a path guess.
  let ownership = { hadJournal: false, changed: [] };
  try {
    ownership = OWNED.uninstallOwned({
      root: home,
      integration: 'dsh',
      dryRun,
      note: (s) => log.note(s),
      warn: (s) => log.warn(s),
    });
    if (ownership.hadJournal && ownership.changed.length > 0) touched = true;
  } catch (error) {
    log.warn(`  dsh ownership journal invalid; left skills untouched: ${error.message}`);
  }

  // 2. AGENTS.md — strip the fenced block (preserves user content above and
  // below). If the file is empty after the strip, remove it.
  const agentsMd = path.join(home, AGENTS_FILE);
  if (fs.existsSync(agentsMd)) {
    if (dryRun) {
      const { found } = probeBlock(agentsMd);
      if (found) { log.note(`  would strip caveman block from ${agentsMd}`); touched = true; }
    } else {
      const r = stripAgentsMdBlock(agentsMd);
      if (r.changed) {
        log.note(r.removed ? `  removed ${agentsMd}` : `  stripped caveman block from ${agentsMd}`);
        touched = true;
      }
    }
  }

  return { ok: true, touched };
}

function probeBlock(agentsMd) {
  const content = readIfExists(agentsMd) || '';
  return { found: content.includes(MARK_BEGIN) || content.includes(MARK_END) };
}

function noopLog() {
  return {
    write: (_) => {},
    note: (_) => {},
    warn: (_) => {},
  };
}

module.exports = {
  installDsh,
  uninstallDsh,
  resolveDshHome,
  // exported for tests
  DSH_SKILL_DIRS,
  MARK_BEGIN,
  MARK_END,
  AGENTS_FILE,
  loadRuleBody,
  fencedBlock,
  upsertAgentsMdBlock,
  stripAgentsMdBlock,
  stripAllBlocks,
};
