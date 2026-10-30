// Default pi packages seeding (settings.json `packages` from the template),
// merged at the KEY level: seeded when the runtime settings.json has no
// packages key, any existing list wins (including the [] `pi remove`
// persists), malformed files are never touched. The real template ships the
// pinned default, and the compiled CLI (the entrypoint's half) is exercised
// by spawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-agent-packages-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { seedAgentPackages } = await import('../../dist-server/src/lib/platform/agent-packages.js');

/** A template carrying the default packages. */
const template = path.join(dir, 'template-settings.json');
const DEFAULTS = ['npm:pi-hermes-memory@0.9.11'];
fs.writeFileSync(
  template,
  `${JSON.stringify({ quietStartup: 'header', packages: DEFAULTS }, null, 2)}\n`,
);

/** An agent dir whose settings.json is `content` (a JS value or raw string). */
function agentWith(name, content) {
  const agent = path.join(dir, name);
  fs.mkdirSync(agent, { recursive: true });
  const raw = typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`;
  fs.writeFileSync(path.join(agent, 'settings.json'), raw);
  return agent;
}
const readSettings = agent => fs.readFileSync(path.join(agent, 'settings.json'), 'utf8');

test('seeds the defaults when the packages key is absent, preserving the rest', () => {
  const agent = agentWith('a', { quietStartup: 'header' });
  const r = seedAgentPackages(agent, template);
  assert.equal(r.ok, true, r.errorMessage);
  assert.deepEqual(r.data, { target: path.join(agent, 'settings.json'), seeded: true });
  assert.deepEqual(JSON.parse(readSettings(agent)), { quietStartup: 'header', packages: DEFAULTS });
  // pi's own format: 2-space JSON with a trailing newline
  assert.ok(readSettings(agent).endsWith('}\n'));
  // idempotent: the key exists now, a second run is a no-op
  const again = seedAgentPackages(agent, template);
  assert.equal(again.ok, true, again.errorMessage);
  assert.equal(again.data.seeded, false);
});

test("an existing packages key always wins — the operator's list, or pi remove's []", () => {
  const cases = [
    ['operator-list', ['npm:other']],
    ['pi-remove-empty', []],
  ];
  for (const [name, packages] of cases) {
    const agent = agentWith(`kept-${name}`, { quietStartup: 'header', packages });
    const before = readSettings(agent);
    const r = seedAgentPackages(agent, template);
    assert.equal(r.ok, true, r.errorMessage);
    assert.equal(r.data.seeded, false);
    assert.equal(readSettings(agent), before); // byte-identical, not rewritten
  }
});

test('a missing runtime settings.json is nothing to do — the file walk owns creation', () => {
  const agent = path.join(dir, 'no-settings');
  fs.mkdirSync(agent);
  const r = seedAgentPackages(agent, template);
  assert.equal(r.ok, true, r.errorMessage);
  assert.equal(r.data.seeded, false);
  assert.equal(fs.existsSync(path.join(agent, 'settings.json')), false);
});

test('a template without packages (or an empty list) seeds nothing', () => {
  const noKey = path.join(dir, 'template-no-packages.json');
  fs.writeFileSync(noKey, '{"quietStartup":"header"}\n');
  const empty = path.join(dir, 'template-empty-packages.json');
  fs.writeFileSync(empty, '{"packages":[]}\n');
  for (const tpl of [noKey, empty]) {
    const agent = agentWith(`none-${path.basename(tpl)}`, { theme: 'dark' });
    const r = seedAgentPackages(agent, tpl);
    assert.equal(r.ok, true, r.errorMessage);
    assert.equal(r.data.seeded, false);
    assert.equal(JSON.parse(readSettings(agent)).theme, 'dark'); // untouched
  }
});

test('template_missing / template_invalid', () => {
  const agent = agentWith('tpl', {});
  const missing = seedAgentPackages(agent, path.join(dir, 'no-such-template.json'));
  assert.equal(missing.ok, false);
  assert.equal(missing.errorCode, 'template_missing');
  assert.ok(missing.errorMessage && !missing.errorMessage.includes('\n'));

  const bad = path.join(dir, 'template-bad.json');
  fs.writeFileSync(bad, '{not json');
  const invalid = seedAgentPackages(agent, bad);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.errorCode, 'template_invalid');
  // a non-array packages value is malformed the same way
  const notArray = path.join(dir, 'template-not-array.json');
  fs.writeFileSync(notArray, '{"packages":"npm:x"}');
  assert.equal(seedAgentPackages(agent, notArray).errorCode, 'template_invalid');
});

test('settings_invalid: a runtime settings.json that is not a JSON object is never touched', () => {
  for (const [name, content] of [
    ['unparseable', '{oops'],
    ['array', '[]'],
    ['string', '"x"'],
  ]) {
    const agent = agentWith(`bad-${name}`, content);
    const r = seedAgentPackages(agent, template);
    assert.equal(r.ok, false, name);
    assert.equal(r.errorCode, 'settings_invalid');
    assert.equal(readSettings(agent), content); // byte-identical
  }
});

test('seed_failed on an unwritable settings.json, with the path and cause', () => {
  // Read-only but readable: the merge reads it, has something to seed, and
  // the write fails (EACCES) — caught, not thrown. (existsSync under a
  // non-directory just reads as absent, so ENOTDIR cannot reach here.)
  const agent = path.join(dir, 'locked');
  fs.mkdirSync(agent);
  const settings = path.join(agent, 'settings.json');
  fs.writeFileSync(settings, '{"quietStartup":"header"}\n');
  fs.chmodSync(settings, 0o444);
  const r = seedAgentPackages(agent, template);
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'seed_failed');
  assert.ok(r.errorMessage?.includes('settings.json'));
  assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).packages, undefined); // untouched
});

test("the repo's own template ships the pinned default (runtime/pi-agent-dir/settings.json)", () => {
  const repoTemplate = fileURLToPath(
    new URL('../../runtime/pi-agent-dir/settings.json', import.meta.url),
  );
  const shipped = JSON.parse(fs.readFileSync(repoTemplate, 'utf8'));
  assert.deepEqual(shipped.packages, [
    'npm:pi-hermes-memory@0.9.11',
    'npm:@juicesharp/rpiv-ask-user-question@2.15.0',
    'npm:pi-web-access@0.46.0',
  ]); // bump deliberately
  for (const spec of shipped.packages) assert.match(spec, /^npm:[@a-z0-9-/~._]+@\d+\.\d+\.\d+$/); // exact pins

  const agent = agentWith('repo-template', { quietStartup: 'header' });
  const r = seedAgentPackages(agent, repoTemplate);
  assert.equal(r.ok, true, r.errorMessage);
  assert.equal(r.data.seeded, true);
  assert.deepEqual(JSON.parse(readSettings(agent)).packages, shipped.packages);
});

test('the compiled CLI: seeds with a line on stdout, exits 1 on usage and failure', () => {
  const agent = agentWith('cli', { quietStartup: 'header' });
  const cli = path.join('dist-server', 'server', 'seed-agent-packages.js');
  const run = (...args) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
    });

  const seeded = run(agent, template);
  assert.equal(seeded.status, 0, seeded.stderr?.toString());
  assert.match(seeded.stdout?.toString() ?? '', /seeded the default pi packages/);
  assert.deepEqual(JSON.parse(readSettings(agent)).packages, DEFAULTS);

  const again = run(agent, template);
  assert.equal(again.status, 0, again.stderr?.toString());
  assert.equal(again.stdout?.toString(), ''); // silent no-op

  const usage = run(agent);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr?.toString() ?? '', /usage:/);

  const failure = run(agent, path.join(dir, 'no-such-template.json'));
  assert.equal(failure.status, 1);
  assert.match(failure.stderr?.toString() ?? '', /template/);
});
