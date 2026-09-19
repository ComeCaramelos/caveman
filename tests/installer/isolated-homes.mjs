// Shared env isolation for installer tests that run the full `--uninstall`.
//
// `bin/install.js --uninstall` is a global sweep: after the claude/gemini
// cleanup it also runs every native-integration cleanup (OpenClaw workspace,
// DSH home, Hermes home), each resolved from `process.env`. A test that
// spawns the full uninstall must therefore point every one of those homes at
// an isolated tmp path — otherwise the sweep reaches (and on a machine where
// that integration is actually installed, silently deletes) the developer's
// real files.
//
// This module is the single place that enumerates the homes the sweep
// touches. When a new native integration joins the uninstall sweep, add its
// home here — every existing caller gets the isolation for free instead of
// each test file re-remembering the list.

import path from 'node:path';

/**
 * Pin the global homes that `bin/install.js --uninstall` sweeps.
 *
 * @param {Record<string, string>} baseEnv - the env to extend (typically
 *   `{ ...process.env, NO_COLOR: '1' }` plus the test's own pins).
 * @param {string} homeRoot - isolated tmp root; each home is pinned under it.
 * @param {object} [overrides] - explicit home paths for an integration the
 *   test under test actually exercises (pass its own fixture path there).
 * @returns {Record<string, string>} the extended env.
 */
export function withIsolatedUninstallHomes(baseEnv, homeRoot, overrides = {}) {
  return {
    ...baseEnv,
    HERMES_HOME: overrides.HERMES_HOME ?? path.join(homeRoot, '.hermes'),
    OPENCLAW_WORKSPACE: overrides.OPENCLAW_WORKSPACE ?? path.join(homeRoot, '.openclaw', 'workspace'),
    // Default is an ABSENT path so that integration's cleanup no-ops. A test
    // that exercises the DSH integration passes its own DSH_HOME.
    DSH_HOME: overrides.DSH_HOME ?? path.join(homeRoot, 'no-dsh'),
  };
}
