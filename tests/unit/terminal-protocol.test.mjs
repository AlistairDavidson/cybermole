// The WS client-frame gate: malformed frames answer null (dropped), never thrown on.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as frames from '../../dist-server/packages/app-kit/src/terminal-protocol.js';
const { parseClientMsg } = frames;

test('accepts each frame shape, stripping unknown extra keys', () => {
  assert.deepEqual(parseClientMsg('{"type":"input","data":"hi"}'), { type: 'input', data: 'hi' });
  // extra keys are tolerated (stripped)
  assert.deepEqual(parseClientMsg('{"type":"input","data":"hi","junk":1}'), {
    type: 'input',
    data: 'hi',
  });
  assert.deepEqual(parseClientMsg('{"type":"input","data":""}'), { type: 'input', data: '' });
  assert.deepEqual(parseClientMsg('{"type":"resize","cols":120,"rows":40}'), {
    type: 'resize',
    cols: 120,
    rows: 40,
  });
  // fractional sizes are numbers; clamping happens downstream
  assert.deepEqual(parseClientMsg('{"type":"resize","cols":1.5,"rows":40.5}'), {
    type: 'resize',
    cols: 1.5,
    rows: 40.5,
  });
  // Attach has two modes: 'terminal' (a tab's uuid) and 'run' (a live run's
  // session). Both stay plain strings, since main.ts brands them to answer
  // an error frame, so even a non-uuid id parses here.
  assert.deepEqual(
    parseClientMsg(
      '{"type":"attach","mode":"terminal","id":"123e4567-e89b-42d3-a456-426614174000"}',
    ),
    { type: 'attach', mode: 'terminal', id: '123e4567-e89b-42d3-a456-426614174000' },
  );
  assert.deepEqual(parseClientMsg('{"type":"attach","mode":"terminal","id":"junk-still-parses"}'), {
    type: 'attach',
    mode: 'terminal',
    id: 'junk-still-parses',
  });
  assert.deepEqual(parseClientMsg('{"type":"attach","mode":"run","target":"cybermole-nightly"}'), {
    type: 'attach',
    mode: 'run',
    target: 'cybermole-nightly',
  });
  // a stray target on terminal, or id on run, is ignored
  assert.deepEqual(
    parseClientMsg('{"type":"attach","mode":"run","target":"cybermole-nightly","id":"x"}'),
    { type: 'attach', mode: 'run', target: 'cybermole-nightly' },
  );
});

test('rejects non-objects, bad JSON, unknown types and mistyped fields — null, never a throw', () => {
  const junk = [
    'not json',
    '',
    'null',
    '[]',
    '"x"',
    '5',
    'true',
    '{}',
    '{"type":"nope"}',
    '{"type":5}',
    '{"type":null}',
    '{"type":"input"}',
    '{"type":"input","data":5}',
    '{"type":"input","data":null}',
    '{"type":"resize","cols":"wide"}',
    '{"type":"resize","cols":120}',
    '{"type":"resize","rows":40}',
    '{"type":"resize","cols":"120","rows":40}',
    '{"type":"attach","mode":"live","target":"dev"}',
    '{"type":"attach","mode":"resume","id":"019f4706-0000-7000-8000-000000000001"}',
    '{"type":"attach","mode":"terminal"}',
    '{"type":"attach","mode":"other","target":"t"}',
    '{"type":"attach","target":"t"}',
    // a missing or mistyped id/target
    '{"type":"attach","mode":"terminal","id":7}',
    '{"type":"attach","mode":"run","target":9}',
    // a mode with no type is junk
    '{"mode":"terminal","id":"123e4567-e89b-42d3-a456-426614174000"}',
  ];
  for (const f of junk) {
    assert.doesNotThrow(() => parseClientMsg(f), f);
    assert.equal(parseClientMsg(f), null, f);
  }
});

test('input frames carry 64 KiB paste chunks (the hot path)', () => {
  const data = 'x'.repeat(65536);
  const msg = parseClientMsg(JSON.stringify({ type: 'input', data }));
  assert.deepEqual(msg, { type: 'input', data });
  assert.equal(msg && msg.type === 'input' && msg.data.length === 65536, true);
});

// ---------- the backfill server frame ----------
// The one server frame the browser validates: junk is dropped, never written.
test('parseBackfillMsg: accepts a well-formed capture, rejects junk with null', () => {
  const { parseBackfillMsg } = frames;
  assert.equal(typeof parseBackfillMsg, 'function');
  const capture = 'line 1\nline 2\n';
  assert.deepEqual(parseBackfillMsg(JSON.stringify({ type: 'backfill', data: capture })), {
    type: 'backfill',
    data: capture,
  });
  // an empty capture is legal (the client skips the write)
  assert.deepEqual(parseBackfillMsg('{"type":"backfill","data":""}'), {
    type: 'backfill',
    data: '',
  });
  // extra keys tolerated (stripped)
  assert.deepEqual(parseBackfillMsg('{"type":"backfill","data":"x","junk":1}'), {
    type: 'backfill',
    data: 'x',
  });
  for (const f of [
    'not json',
    '',
    'null',
    '[]',
    '5',
    '{}',
    '{"type":"backfill"}',
    '{"type":"backfill","data":5}',
    '{"type":"backfill","data":null}',
    '{"type":"backfill","data":["x"]}',
    '{"type":"output","data":"x"}',
    '{"type":"BACKFILL","data":"x"}',
  ]) {
    assert.doesNotThrow(() => parseBackfillMsg(f), f);
    assert.equal(parseBackfillMsg(f), null, f);
  }
});
