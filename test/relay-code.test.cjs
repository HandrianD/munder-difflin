'use strict';

/**
 * src/shared/relayCode.ts — the join code: a bearer credential in one pasteable
 * string. The properties that matter are the boring ones: it round-trips, it
 * survives being wrapped by a terminal, and every way of getting it wrong fails
 * closed with a code the UI can translate instead of a stack trace.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const loadTs = require('./load-ts.cjs');
const relayCode = loadTs('src/shared/relayCode.ts');

const { encodeJoinCode, decodeJoinCode, isValidSeatToken, isValidRelayUrl, JOIN_CODE_PREFIX } = relayCode;

const TOKEN = `mdr_${'ab12'.repeat(16)}`; // mdr_ + 64 hex
const URL = 'wss://relay.example:8787';

test('a join code round-trips the URL and seat token', () => {
  const code = encodeJoinCode({ url: URL, token: TOKEN });
  assert.equal(typeof code, 'string');
  assert.ok(code.startsWith(JOIN_CODE_PREFIX), 'the format marker is visible, not hidden');
  const r = decodeJoinCode(code);
  assert.equal(r.ok, true);
  assert.deepEqual(r.payload, { url: URL, token: TOKEN });
});

test('whitespace, wrapping and a trailing newline are ignored', () => {
  const code = encodeJoinCode({ url: URL, token: TOKEN });
  const wrapped = `${code.slice(0, 20)}\r\n  ${code.slice(20, 50)}\n${code.slice(50)}\t`;
  const r = decodeJoinCode(wrapped);
  assert.equal(r.ok, true);
  assert.deepEqual(r.payload, { url: URL, token: TOKEN });
});

test('a URL with surrounding spaces still decodes, trimmed', () => {
  const r = decodeJoinCode(encodeJoinCode({ url: `  ${URL}  `, token: TOKEN }));
  assert.equal(r.ok, true);
  assert.equal(r.payload.url, URL);
});

test('each way of getting it wrong reports its own stable error', () => {
  const cases = [
    ['', 'empty'],
    ['   ', 'empty'],
    ['not a code at all', 'unknownPrefix'],
    ['mdr2.AAAA', 'unknownPrefix'],
    [JOIN_CODE_PREFIX, 'malformed'],
    [`${JOIN_CODE_PREFIX}~~~~`, 'malformed'],
    [`${JOIN_CODE_PREFIX}AAAA`, 'malformed'],
    [null, 'empty'],
    [42, 'empty'],
    ['x'.repeat(5000), 'tooLong'],
    [encodeJoinCode({ url: URL, token: TOKEN }).slice(0, -3), 'malformed'],
    [encodeJoinCode({ url: URL, token: TOKEN }) + 'Q', 'malformed']
  ];
  for (const [input, expected] of cases) {
    const r = decodeJoinCode(input);
    assert.equal(r.ok, false, `expected ${JSON.stringify(input)} to be refused`);
    assert.equal(r.error, expected, `wrong error for ${JSON.stringify(input)}`);
  }
});

test('the payload is validated field by field, not just parsed', () => {
  const base = { v: 1, url: URL, token: TOKEN };

  // Built with Buffer rather than encodeJoinCode on purpose: encodeJoinCode can
  // only ever emit a valid payload, and a hand-built code is also an independent
  // check that the module's own base64url agrees with the standard library.
  const bad = (obj) =>
    decodeJoinCode(JOIN_CODE_PREFIX + Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url'));

  assert.equal(bad({ ...base, token: 'mdr_short' }).error, 'badToken');
  assert.equal(bad({ ...base, token: TOKEN.toUpperCase() }).error, 'badToken');
  assert.equal(bad({ ...base, token: TOKEN.replace(/.$/, 'z') }).error, 'badToken');
  assert.equal(bad({ ...base, token: 12345 }).error, 'badToken');
  assert.equal(bad({ ...base, url: 'https://relay.example' }).error, 'badUrl');
  assert.equal(bad({ ...base, url: 'relay.example:8787' }).error, 'badUrl');
  assert.equal(bad({ ...base, url: '' }).error, 'badUrl');
  assert.equal(bad({ ...base, url: 7 }).error, 'badUrl');
  assert.equal(bad({ ...base, v: 2 }).error, 'unsupportedVersion');
  assert.equal(bad({ ...base, v: '1' }).error, 'unsupportedVersion');
  assert.equal(bad({ url: URL, token: TOKEN }).error, 'unsupportedVersion', 'a code with no version is not ours');
  assert.equal(bad({ ...base, extra: 'field' }).ok, true, 'unknown keys are ignored, not fatal');
});

test('an http URL is refused up front rather than failing at the socket', () => {
  assert.equal(isValidRelayUrl('http://relay.example:8787'), false);
  assert.equal(isValidRelayUrl('wss://relay.example:8787'), true);
  assert.equal(isValidRelayUrl('ws://127.0.0.1:8787'), true);
  assert.equal(isValidRelayUrl('ws://'), false);
  assert.equal(isValidRelayUrl(undefined), false);
});

test('seat tokens are recognised by shape, without the relay', () => {
  assert.equal(isValidSeatToken(TOKEN), true);
  assert.equal(isValidSeatToken(`mdr_${'AB'.repeat(32)}`), false, 'uppercase hex is not what newSeatToken emits');
  assert.equal(isValidSeatToken(`mdr_${'ab'.repeat(31)}`), false, 'wrong length');
  assert.equal(isValidSeatToken('Bearer abc'), false);
  assert.equal(isValidSeatToken(null), false);
});

test('the format marker keeps a code from a future format readable as garbage', () => {
  const code = encodeJoinCode({ url: URL, token: TOKEN });
  assert.equal(decodeJoinCode(code.slice(JOIN_CODE_PREFIX.length)).ok, false);
  assert.equal(decodeJoinCode(`v2.${code.slice(JOIN_CODE_PREFIX.length)}`).error, 'unknownPrefix');
});
