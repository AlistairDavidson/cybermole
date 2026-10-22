// root-agents.test.mjs — the workspace-root AGENTS.md seeding
// (src/lib/root-agents.ts, docs/jobs-agent-plan.md §9): the
// only-where-absent policy in one function, so the server boot (single
// user — server/main.ts, next to seedAgentDir) and the split's
// workspace entrypoint (docker-workspace-entrypoint.sh, uid 2000 — a
// shell script, not unit-testable) run the same logic. Every Result
// family member gets a case: seeded, already-present wins (even without
// the template — the policy is satisfied), template_missing, and
// seed_failed (an unwritable target). The real template ships beside
// this test's cases: the repo's root-agents/AGENTS.md is seeded
// byte-identical, so template edits that break the seeding's shape
// surface here too.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpi-root-agents-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { seedRootAgentsFile } = await import('../../dist-server/src/lib/root-agents.js');

/** A stand-in template file with known content. */
const template = path.join(dir, 'template.md');
fs.writeFileSync(template, 'the standing instructions\n');

test('seeds the template byte-identical into an empty workspace root', () => {
  const root = path.join(dir, 'root-a');
  const r = seedRootAgentsFile(root, template);
  assert.equal(r.ok, true, r.errorMessage);
  assert.deepEqual(r.data, { target: path.join(root, 'AGENTS.md'), seeded: true });
  assert.equal(
    fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'),
    'the standing instructions\n',
  );
});

test('creates the workspace root when it does not exist yet', () => {
  const root = path.join(dir, 'made', 'deep', 'root');
  const r = seedRootAgentsFile(root, template);
  assert.equal(r.ok, true, r.errorMessage);
  assert.equal(r.data.seeded, true);
  assert.ok(fs.existsSync(path.join(root, 'AGENTS.md')));
});

test('only-where-absent: an existing AGENTS.md always wins, untouched', () => {
  const root = path.join(dir, 'root-b');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'the operator wrote this first\n');
  const r = seedRootAgentsFile(root, template);
  assert.equal(r.ok, true, r.errorMessage);
  assert.deepEqual(r.data, { target: path.join(root, 'AGENTS.md'), seeded: false });
  assert.equal(
    fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'),
    'the operator wrote this first\n',
  );
  // and a second run over the seeded file is the same no-op
  const again = seedRootAgentsFile(root, template);
  assert.equal(again.ok, true, again.errorMessage);
  assert.equal(again.data.seeded, false);
});

test('an existing target is success even without the template — nothing to do', () => {
  const root = path.join(dir, 'root-c');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'custom\n');
  const r = seedRootAgentsFile(root, path.join(dir, 'no-such-template'));
  assert.equal(r.ok, true, r.errorMessage);
  assert.equal(r.data.seeded, false);
});

test('template_missing when the template is absent (and nothing is seeded)', () => {
  const root = path.join(dir, 'root-d');
  const r = seedRootAgentsFile(root, path.join(dir, 'no-such-template'));
  assert.equal(r.ok, false);
  assert.equal(r.resultType, 'seed_root_agents');
  assert.equal(r.errorCode, 'template_missing');
  assert.ok(r.errorMessage && !r.errorMessage.includes('\n'));
  assert.ok(!fs.existsSync(path.join(root, 'AGENTS.md'))); // nothing written
});

test('seed_failed on an unwritable target, with the path and cause', () => {
  // a workspace root UNDER a regular file: mkdir fails (ENOTDIR), so the
  // cp never happens — the caught fs failure, not a throw.
  const notADir = path.join(dir, 'plain-file');
  fs.writeFileSync(notADir, 'x');
  const r = seedRootAgentsFile(path.join(notADir, 'root'), template);
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'seed_failed');
  assert.ok(r.errorMessage?.includes('AGENTS.md'));
});

test("the repo's own template seeds (root-agents/AGENTS.md ships the file)", () => {
  const root = path.join(dir, 'root-e');
  const repoTemplate = fileURLToPath(new URL('../../root-agents/AGENTS.md', import.meta.url));
  const r = seedRootAgentsFile(root, repoTemplate);
  assert.equal(r.ok, true, r.errorMessage);
  assert.equal(r.data.seeded, true);
  const seeded = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.equal(seeded, fs.readFileSync(repoTemplate, 'utf8'));
  // the template's load-bearing claims (plan §9's content): the jobs
  // convention, the fired-not-finished line, the CLI verbs, the MCP
  // server + /reload, the trust note.
  assert.match(seeded, /web-pi jobs/);
  assert.match(seeded, /Fired means started, not finished/);
  assert.match(seeded, /webpi jobs run <name>/);
  assert.match(seeded, /webpi jobs runs <name>/);
  assert.match(seeded, /webpi jobs log <name> <firedAt>/);
  assert.match(seeded, /webpi-jobs/);
  assert.match(seeded, /\/reload/);
  assert.match(seeded, /upward walk/);
});
