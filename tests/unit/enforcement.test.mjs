// enforcement.test.mjs — THE security property (docs/management-page.md §1):
// the apply step must refuse any patch that changes the protected set.
// Written from the attacker's side: real `git init` fixtures with renames,
// chmods, symlink swaps, newline-in-filename adds, case variants,
// look-alike paths, and rewritten history — plus the pure halves
// (normalization, -z parsing, verdicts) fed hostile strings directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const {
  PROTECTED_ENTRIES, normalizeGitPath, isProtectedPath, protectedHits,
  parseNameStatus, verdictFromRecords, enforceDiff, currentBaseSha,
  readImageVersion, readPointer, writePointer,
} = await import('../../dist-server/src/lib/releases.js');

// ---------- the pure halves ----------

test('the protected set covers the gate, the split, the build inputs and itself', () => {
  const paths = PROTECTED_ENTRIES.map(e => e.path);
  // spot-check every category from docs/management-page.md §1.1
  for (const must of [
    'compose.yaml', 'Dockerfile', 'docker-entrypoint.sh', 'docker-workspace-entrypoint.sh',
    'deploy', '.gitmodules', 'package.json', 'package-lock.json', 'astro.config.mjs',
    'tsconfig.json', 'tsconfig.server.json', 'server/main.ts', 'server/set-password.ts',
    'src/middleware.ts', 'src/lib/auth.ts', 'src/lib/env-schema.ts', 'src/lib/env.ts',
    'src/lib/services.ts', 'src/lib/releases.ts', 'src/schemas/api.ts',
    'src/pages/api/management',
  ]) {
    assert.ok(paths.includes(must), `${must} must be protected`);
  }
  // every entry carries a rationale (the page shows these)
  for (const entry of PROTECTED_ENTRIES) assert.ok(entry.why.length > 10, entry.path);
});

test('normalizeGitPath: shapes git never mints are refused (null), the rest normalized', () => {
  assert.equal(normalizeGitPath('compose.yaml'), 'compose.yaml');
  assert.equal(normalizeGitPath('./compose.yaml'), 'compose.yaml');
  assert.equal(normalizeGitPath('a//b/c'), 'a/b/c');
  assert.equal(normalizeGitPath('a/b/'), 'a/b');
  assert.equal(normalizeGitPath('a/./b'), 'a/b');
  // hostile shapes — all null, all fail closed upstream
  for (const bad of ['', '/', '/etc/passwd', '..', 'a/../b', 'a/..', '\\etc\\x',
    'a\\b', 'C:\\x', '.', '//']) {
    assert.equal(normalizeGitPath(bad), null, JSON.stringify(bad));
  }
  // .git/* is a well-formed path (kept as-is) but one a diff never mints —
  // and never protected, so it could never smuggle a refusal past either.
  assert.equal(normalizeGitPath('.git/config'), '.git/config');
  // case is preserved (case-sensitive matching: Linux fs + exact git paths)
  assert.equal(normalizeGitPath('Compose.yaml'), 'Compose.yaml');
  assert.notEqual(isProtectedPath('Compose.yaml'), true);
});

test('isProtectedPath: exact files and everything under protected dirs', () => {
  for (const p of ['compose.yaml', 'Dockerfile', 'deploy/nginx-webpi.conf', 'deploy/sub/x.conf',
    'src/pages/api/management/index.ts', 'src/lib/releases.ts', 'package.json']) {
    assert.ok(isProtectedPath(p), p);
  }
  // look-alikes are NOT protected (documented boundary, docs §1.1)
  for (const p of ['deploy2/nginx.conf', 'Dockerfile.old', 'src/lib/release.ts',
    'src/pages/api/managements', 'compose.yaml.bak', 'src/pages/api/management-x/y.ts',
    'package-lock.jsonn', 'README.md', 'src/pages/api/management.ts']) {
    assert.equal(isProtectedPath(p), false, p);
  }
});

test('protectedHits: deduped, sorted, never capped', () => {
  assert.deepEqual(protectedHits(['deploy/x', 'compose.yaml', 'deploy/x', 'README.md']),
    ['compose.yaml', 'deploy/x']);
  const many = Array.from({ length: 5000 }, (_, i) => `deploy/f${i}`);
  assert.equal(protectedHits(many).length, 5000);
});

test('parseNameStatus: -z records, including hostile path CONTENT', () => {
  const rec = (letter, p) => `${letter}\0${p}\0`;
  // A/D/M/T take one path; spaces, newlines, dashes and unicode are data
  const raw = rec('M', 'compose.yaml') + rec('A', 'weird file\nname') + rec('D', '-leading-dash') + rec('T', 'ünïcode');
  assert.deepEqual(parseNameStatus(raw), [
    { letter: 'M', path: 'compose.yaml', oldPath: null },
    { letter: 'A', path: 'weird file\nname', oldPath: null },
    { letter: 'D', path: '-leading-dash', oldPath: null },
    { letter: 'T', path: 'ünïcode', oldPath: null },
  ]);
  // R/C are accepted defensively (both ends kept) though --no-renames never emits them
  assert.deepEqual(parseNameStatus('R100\0old\0new\0'), [{ letter: 'R100', path: 'new', oldPath: 'old' }]);
  // empty input = no changes (base === target)
  assert.deepEqual(parseNameStatus(''), []);
  // fail closed: unknown letters, truncated records
  for (const bad of ['M', 'M\0', 'X\0file\0', 'U\0file\0', 'R100\0only-one\0', 'C\0a\0b\0extra\0'.replace('C', 'C5')]) {
    const out = parseNameStatus(bad);
    if (out !== null) assert.fail(`parsed hostile record ${JSON.stringify(bad)} into ${JSON.stringify(out)}`);
  }
});

test('verdictFromRecords: an unparsable path can never be allowed', () => {
  const v = verdictFromRecords('b', 't', [{ letter: 'M', path: '/etc/passwd', oldPath: null }]);
  assert.equal(v.allowed, false);
  assert.ok(v.protectedChanged.some(p => p.includes('unparsable')), JSON.stringify(v.protectedChanged));
});

// ---------- real git fixtures, attacked like the sessions' uid would ----------

/** A repo whose BASE commit contains every protected path (plus filler),
 *  so deletes/renames/type-changes are expressible. */
function fixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webpi-enforce-'));
  const run = (cmd, opts = {}) => execFileSync('git', cmd, { cwd: root, stdio: 'ignore', ...opts });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 't@t']);
  run(['config', 'user.name', 't']);
  const base = [];
  for (const entry of PROTECTED_ENTRIES) {
    if (entry.path === 'deploy' || entry.path === 'src/pages/api/management') {
      fs.mkdirSync(path.join(root, entry.path, 'x'), { recursive: true });
      fs.writeFileSync(path.join(root, entry.path, 'x', 'keep'), 'x');
      base.push(path.join(entry.path, 'x', 'keep'));
    } else {
      fs.mkdirSync(path.dirname(path.join(root, entry.path)), { recursive: true });
      fs.writeFileSync(path.join(root, entry.path), `# ${entry.path}\n`);
      base.push(entry.path);
    }
  }
  fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
  base.push('README.md');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'base']);
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
  return { root, run, base, sha };
}

/** Commit the current tree state and return its sha. */
function commit(run, cwd, message) {
  run(['add', '-A']);
  run(['commit', '-q', '--allow-empty', '-m', message]);
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd }).toString().trim();
}

/** base..target verdict for a mutated fixture. */
async function verdict(mutate) {
  const f = fixtureRepo();
  mutate(f);
  const target = commit(f.run, f.root, 'target');
  const r = await enforceDiff(f.root, f.sha, target);
  assert.ok(r.ok, JSON.stringify(r));
  return r.data;
}

test('no changes → allowed, nothing changed', async () => {
  const v = await verdict(() => {});
  assert.equal(v.allowed, true);
  assert.equal(v.changedCount, 0);
});

test('an unprotected edit → allowed, listed', async () => {
  const v = await verdict(f => fs.writeFileSync(path.join(f.root, 'README.md'), 'edited\n'));
  assert.equal(v.allowed, true);
  assert.equal(v.changedCount, 1);
  assert.deepEqual(v.changed, [{ path: 'README.md', status: 'M', protectedPath: false }]);
});

for (const [name, mutate] of /** @type {Array<[string, (f: any) => void]>} */ ([
  ['modifying compose.yaml', f => fs.writeFileSync(path.join(f.root, 'compose.yaml'), 'evil\n')],
  ['modifying the gate (server/main.ts)', f => fs.writeFileSync(path.join(f.root, 'server/main.ts'), 'evil\n')],
  ['modifying the enforcement itself (src/lib/releases.ts)', f => fs.writeFileSync(path.join(f.root, 'src/lib/releases.ts'), 'export const PROTECTED_ENTRIES = [];\n')],
  ['modifying package.json (build scripts)', f => fs.writeFileSync(path.join(f.root, 'package.json'), '{}\n')],
  ['modifying package-lock.json', f => fs.writeFileSync(path.join(f.root, 'package-lock.json'), '{}\n')],
  ['deleting Dockerfile', f => fs.rmSync(path.join(f.root, 'Dockerfile'))],
  ['deleting the login schema (src/schemas/api.ts)', f => fs.rmSync(path.join(f.root, 'src/schemas/api.ts'))],
  ['chmod +x docker-entrypoint.sh (mode-only change)', f => fs.chmodSync(path.join(f.root, 'docker-entrypoint.sh'), 0o755)],
  ['adding deploy/nginx2.conf (into a protected dir)', f => fs.writeFileSync(path.join(f.root, 'deploy', 'nginx2.conf'), 'x')],
  ['adding .gitmodules (external code sources)', f => fs.writeFileSync(path.join(f.root, '.gitmodules'), '[submodule "x"]\n')],
  ['replacing docker-workspace-entrypoint.sh with a symlink (type change)', f => {
    fs.rmSync(path.join(f.root, 'docker-workspace-entrypoint.sh'));
    fs.symlinkSync('/tmp/evil', path.join(f.root, 'docker-workspace-entrypoint.sh'));
  }],
  ['replacing src/lib/env.ts with a symlink', f => {
    fs.rmSync(path.join(f.root, 'src/lib/env.ts'));
    fs.symlinkSync('/tmp/evil', path.join(f.root, 'src/lib/env.ts'));
  }],
  ['renaming compose.yaml away (delete side of a move)', f => {
    fs.renameSync(path.join(f.root, 'compose.yaml'), path.join(f.root, 'compose-moved.yaml'));
  }],
  ['renaming README.md INTO deploy/ (add side of a move)', f => {
    fs.renameSync(path.join(f.root, 'README.md'), path.join(f.root, 'deploy', 'README.md'));
  }],
  ['a newline-named file moved into deploy/', f => {
    fs.writeFileSync(path.join(f.root, 'weird\nname'), 'x');
    fs.renameSync(path.join(f.root, 'weird\nname'), path.join(f.root, 'deploy', 'weird\nname'));
  }],
])) {
  test(`attacker: ${name} → REFUSED, the offending path named`, async () => {
    const v = await verdict(mutate);
    assert.equal(v.allowed, false, JSON.stringify(v.changed));
    assert.ok(v.protectedChanged.length > 0);
    // the refusal names at least one real protected path (not the weird-path placeholder)
    assert.ok(v.protectedChanged.some(p => PROTECTED_ENTRIES.some(e => p === e.path || p.startsWith(e.path + '/'))),
      JSON.stringify(v.protectedChanged));
  });
}

test('attacker: look-alike paths are allowed (the documented boundary)', async () => {
  const v = await verdict(f => {
    fs.mkdirSync(path.join(f.root, 'deploy2'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'deploy2', 'x.conf'), 'x');
    fs.mkdirSync(path.join(f.root, 'Dockerfile.d'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'Dockerfile.d', 'x'), 'x');
  });
  assert.equal(v.allowed, true);
  assert.equal(v.protectedChanged.length, 0);
});

test('attacker: a case-VARIANT rename is caught on the protected side (Linux is case-sensitive)', async () => {
  // git records this as D compose.yaml + A COMPOSE.YAML under --no-renames
  const v = await verdict(f => {
    fs.renameSync(path.join(f.root, 'compose.yaml'), path.join(f.root, 'COMPOSE.YAML'));
  });
  assert.equal(v.allowed, false);
  assert.ok(v.protectedChanged.includes('compose.yaml'), JSON.stringify(v.protectedChanged));
});

test('attacker: adding an unrelated case-variant file is allowed (exact match, by design)', async () => {
  const v = await verdict(f => fs.writeFileSync(path.join(f.root, 'COMPOSE.YAML'), 'x'));
  assert.equal(v.allowed, true);
});

test('base not in the checkout (rewritten history / wrong repo) → refused, never guessed', async () => {
  const f = fixtureRepo();
  const missing = '0'.repeat(40);
  const r = await enforceDiff(f.root, missing, f.sha);
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'base_not_in_checkout');
});

test('target not found → refused', async () => {
  const f = fixtureRepo();
  const r = await enforceDiff(f.root, f.sha, '1'.repeat(40));
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'target_not_found');
});

// ---------- the base chain ----------

test('currentBaseSha: pointer file wins, else the image\'s baked sha, else null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpi-base-'));
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ git: 'a'.repeat(40), builtAt: '2026-01-01T00:00:00Z' }));
  assert.equal(currentBaseSha(dir, null), 'a'.repeat(40));
  const releases = path.join(dir, 'releases');
  writePointer(releases, 'b'.repeat(40));
  assert.equal(currentBaseSha(dir, releases), 'b'.repeat(40));
  writePointer(releases, null); // rolled back to image
  assert.equal(currentBaseSha(dir, releases), 'a'.repeat(40));
  // garbage pointer / unknown image sha / no version.json → null (refuse)
  fs.writeFileSync(path.join(releases, 'pointer', 'current'), 'not-a-sha');
  assert.equal(currentBaseSha(dir, releases), 'a'.repeat(40));
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ git: 'unknown' }));
  fs.rmSync(path.join(releases, 'pointer', 'current'));
  assert.equal(currentBaseSha(dir, releases), null);
  assert.equal(readImageVersion(path.join(dir, 'nope')), null);
  assert.equal(readPointer(null), null);
});
