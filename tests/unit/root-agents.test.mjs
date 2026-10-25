// Workspace-root AGENTS.md seeding, only where absent: seeded, an existing
// file wins (even without the template), template_missing, seed_failed. The
// real template is seeded byte-identical too, so edits that break it show up.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-root-agents-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { seedRootAgentsFile } = await import('../../dist-server/src/lib/platform/root-agents.js');

/** A stand-in template with known content. */
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
  // a second run over the seeded file is a no-op
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
  // The root is under a regular file, so mkdir fails (ENOTDIR): caught, not thrown.
  const notADir = path.join(dir, 'plain-file');
  fs.writeFileSync(notADir, 'x');
  const r = seedRootAgentsFile(path.join(notADir, 'root'), template);
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'seed_failed');
  assert.ok(r.errorMessage?.includes('AGENTS.md'));
});

test("the repo's own template seeds (runtime/workspace-root/AGENTS.md ships the file)", () => {
  const root = path.join(dir, 'root-e');
  const repoTemplate = fileURLToPath(
    new URL('../../runtime/workspace-root/AGENTS.md', import.meta.url),
  );
  const r = seedRootAgentsFile(root, repoTemplate);
  assert.equal(r.ok, true, r.errorMessage);
  assert.equal(r.data.seeded, true);
  const seeded = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.equal(seeded, fs.readFileSync(repoTemplate, 'utf8'));
  // the template's key content: the jobs convention, fired-not-finished,
  // the CLI verbs, the MCP server and /reload, the trust note
  assert.match(seeded, /cybermole jobs/);
  assert.match(seeded, /Fired means started, not finished/);
  assert.match(seeded, /cybermole-cli jobs run <name>/);
  assert.match(seeded, /cybermole-cli jobs runs <name>/);
  assert.match(seeded, /cybermole-cli jobs log <name> <firedAt>/);
  assert.match(seeded, /cybermole-jobs/);
  assert.match(seeded, /\/reload/);
  assert.match(seeded, /upward walk/);
});
