'use strict';

/**
 * The Track B seam in src/main/hive.ts.
 *
 * Chosen model: mail this machine CANNOT deliver locally — because the target
 * id has no inbox here — is handed to the relay instead of being dropped and
 * bounced. Mail that lands locally never crosses. Mail that ARRIVED from the
 * relay is never echoed back, which is the difference between a working link
 * and two machines mirroring one message between themselves forever.
 *
 * Everything here runs with no relay installed (the default) and with one
 * attached, because the guarantee is that local routing is identical either
 * way except for the one branch that used to report "undeliverable".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { envelopeKindForAct } = loadTs('src/main/relayClient.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-relay-seam-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  return { home, hive };
}

/** Install a spy mirror. `take` decides whether the mail is accepted. */
function attachMirror(hive, take = () => true) {
  const sent = [];
  hive.setRelayMirror((msg, toAgent) => {
    sent.push({ id: msg.id, from: msg.from, subject: msg.subject, toAgent });
    return take(msg, toAgent);
  });
  return sent;
}

const entries = (hive, kind) => hive.logTail(500).filter((e) => e.kind === kind);

const inbound = (over = {}) => ({
  id: 'env-from-peer-1',
  conversation: 'conv-peer',
  in_reply_to: null,
  from: 'peer-agent',
  to: 'jim-1',
  act: 'request',
  subject: 'from the other machine',
  body: 'please take this',
  hops: 0,
  requires_reply: true,
  needs_human: false,
  created_at: '2026-09-28T00:00:00.000Z',
  ...over
});

// ─── outbound ───────────────────────────────────────────────────────────────

test('mail with no local inbox goes to the relay instead of being called undeliverable', async (t) => {
  const { hive } = await floor(t);
  const sent = attachMirror(hive);

  hive.send({ to: 'remote-1', act: 'request', subject: 'over the wire', body: 'go' }, 'god-1');

  assert.equal(sent.length, 1, 'exactly one envelope for the other machine');
  assert.equal(sent[0].toAgent, 'remote-1');
  assert.equal(sent[0].subject, 'over the wire');

  // The whole point: with a relay attached this is NOT a failure.
  assert.equal(entries(hive, 'drop').filter((e) => e.reason === 'no-inbox').length, 0);
  assert.equal(hive.inbox('god-1').length, 0, 'no bounce — the mail left on the wire');

  const [msg] = entries(hive, 'message');
  assert.deepEqual(msg.delivered, ['remote-1'], 'the log reports the machine that took it');
});

test('mail that lands locally never crosses', async (t) => {
  const { hive } = await floor(t);
  const sent = attachMirror(hive);

  hive.send({ to: 'jim-1', act: 'inform', subject: 'stay here' }, 'god-1');

  assert.equal(sent.length, 0, 'a local recipient must not be mirrored');
  assert.equal(hive.inbox('jim-1').length, 1);
});

test('a broadcast is delivered locally AND mirrored exactly once', async (t) => {
  const { hive } = await floor(t);
  const sent = attachMirror(hive);

  hive.send({ to: 'broadcast', act: 'inform', subject: 'all hands' }, 'god-1');

  assert.equal(hive.inbox('jim-1').length, 1, 'the local agent still gets it');
  assert.equal(sent.length, 1, 'one envelope for the peer machines, not one per local target');
  assert.equal(sent[0].toAgent, null, 'broadcast crosses as the broadcast form');
});

test('when the mirror declines, the drop and the bounce are still there', async (t) => {
  const { hive } = await floor(t);
  // A mirror that refuses is indistinguishable from "relay misbehaving" — the
  // pre-Track B safety net must not disappear just because we tried to send.
  const sent = attachMirror(hive, () => false);

  hive.send({ to: 'nobody', act: 'request', subject: 'T15 — start the build', body: 'go' }, 'god-1');

  assert.equal(sent.length, 1, 'the attempt was made');
  const dropped = entries(hive, 'drop').filter((e) => e.reason === 'no-inbox');
  assert.equal(dropped.length, 1, 'a refused mirror still leaves a drop record');
  const bounced = hive.inbox('god-1');
  assert.equal(bounced.length, 1);
  assert.match(bounced[0].subject, /^\[undeliverable — no agent "nobody"/);
});

test('with no mirror installed the behavior is exactly the pre-Track B one', async (t) => {
  const { hive } = await floor(t);

  hive.send({ to: 'jim', act: 'request', subject: 'T15 — start the build', body: 'go' }, 'god-1');

  assert.equal(entries(hive, 'drop').filter((e) => e.reason === 'no-inbox').length, 1);
  assert.equal(hive.inbox('god-1').length, 1);
  assert.match(hive.inbox('god-1')[0].subject, /^\[undeliverable — no agent "jim"/);
});

test('a mirror that throws cannot break local routing', async (t) => {
  const { hive } = await floor(t);
  hive.setRelayMirror(() => { throw new Error('relay exploded'); });

  assert.doesNotThrow(() => {
    hive.send({ to: 'jim-1', act: 'inform', subject: 'still lands' }, 'god-1');
  });
  assert.equal(hive.inbox('jim-1').length, 1);
});

// ─── inbound ────────────────────────────────────────────────────────────────

test('inbound mail lands in the local inbox, keeping the peer\'s identity', async (t) => {
  const { hive } = await floor(t);
  const sent = attachMirror(hive);

  const msg = hive.receiveRemote(inbound());

  assert.equal(hive.inbox('jim-1').length, 1, 'delivered to the local agent');
  const [landed] = hive.inbox('jim-1');
  assert.equal(landed.id, 'env-from-peer-1', 'the peer\'s id survives, so a resend overwrites');
  assert.equal(landed.conversation, 'conv-peer');
  assert.equal(landed.from, 'peer-agent');
  assert.equal(landed.created_at, '2026-09-28T00:00:00.000Z');
  assert.equal(msg.from, 'peer-agent');

  assert.equal(sent.length, 0, 'inbound mail must never be mirrored back out');
  assert.ok(entries(hive, 'message').length >= 1, 'and it is still recorded in hive history');
});

test('inbound mail to an id we do not host is dropped locally, not echoed back', async (t) => {
  const { hive } = await floor(t);
  const sent = attachMirror(hive);

  hive.receiveRemote(inbound({ to: 'not-here' }));

  assert.equal(sent.length, 0, 'echoing it would bounce between the two machines forever');
  assert.equal(entries(hive, 'drop').filter((e) => e.reason === 'no-inbox').length, 1);
  assert.equal(hive.inbox('god-1').length, 1, 'and the local god is told');
});

test('a repeated inbound delivery overwrites instead of duplicating', async (t) => {
  const { hive } = await floor(t);

  hive.receiveRemote(inbound());
  hive.receiveRemote(inbound());

  assert.equal(hive.inbox('jim-1').length, 1, 'one file, one message — at-least-once is safe');
});

test('an inbound broadcast reaches the local agents but does not leave again', async (t) => {
  const { hive } = await floor(t);
  const sent = attachMirror(hive);

  hive.receiveRemote(inbound({ to: 'broadcast' }));

  assert.equal(hive.inbox('jim-1').length, 1, 'the local roster is addressed');
  assert.equal(sent.length, 0, 'broadcasts are not re-broadcast to the peer');
});

// ─── capability classes ─────────────────────────────────────────────────────

test('every hive act maps onto a kind the relay will carry', () => {
  const acts = ['request', 'inform', 'propose', 'query', 'agree', 'refuse', 'done'];
  for (const act of acts) {
    assert.equal(typeof envelopeKindForAct(act), 'string', `${act} must map to a kind`);
  }
  assert.equal(envelopeKindForAct('request'), 'ask');
  assert.equal(envelopeKindForAct('query'), 'ask');
  assert.equal(envelopeKindForAct('propose'), 'ask');
  assert.equal(envelopeKindForAct('agree'), 'reply');
  assert.equal(envelopeKindForAct('refuse'), 'reply');
  assert.equal(envelopeKindForAct('done'), 'result');
  assert.equal(envelopeKindForAct('inform'), 'board.update', 'the default act is a notice');
});
