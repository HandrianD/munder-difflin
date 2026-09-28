'use strict';

/**
 * src/main/relayRuntime.ts — the reconcile logic between HarnessConfig and the
 * one live connection. Electron-free by construction (paths, credentials and
 * status fan-out are injected), so it loads through test/load-ts.cjs and runs
 * against the real relay with no display, keychain or network.
 *
 * The rules under test are the ones that are easy to get subtly wrong:
 *   - nothing runs until config asks for it, in all three "off" shapes;
 *   - an unrelated settings save must NOT tear down a healthy socket;
 *   - revoking this machine's own credential disconnects it;
 *   - refused seats stay parked until an operator forces a retry.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { WebSocket } = require('ws');

const { openDb } = require('../relay/db');
const { createRelay } = require('../relay/server');
const { newSeat } = require('../relay/auth');

const loadTs = require('./load-ts.cjs');
const { createRelayRuntime } = loadTs('src/main/relayRuntime.ts');

const NOOP = { info() {}, warn() {}, error() {} };

// ─── helpers ────────────────────────────────────────────────────────────────

function seedSeat(db, label) {
  const seat = newSeat(label);
  db.prepare('INSERT INTO seats (id, label, token_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?)')
    .run(seat.id, seat.label, seat.token_hash, Date.now(), null);
  return seat;
}

async function withRelay(fn) {
  const db = openDb(':memory:');
  const relay = createRelay({
    db, host: '127.0.0.1', port: 0,
    authTimeoutMs: 2000, heartbeatMs: 60_000, revocationSweepMs: 40,
    logger: NOOP
  });
  await relay.start();
  try {
    await fn({ db, relay, port: relay.port() });
  } finally {
    await relay.stop();
    db.close();
  }
}

async function until(fn, label, ms = 4000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Stand-in for HiveManager: records which seam callbacks were attached. */
function fakeHive() {
  const state = { mirror: null, received: [] };
  return {
    state,
    setRelayMirror(cb) { state.mirror = cb; },
    receiveRemote(partial, from) {
      state.received.push({ partial, from });
      return partial;
    }
  };
}

function runtime(hive, opts = {}) {
  const broadcasts = [];
  const holder = {
    token: opts.token,
    outboxPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'md-relay-rt-')), 'outbox.json')
  };
  const rt = createRelayRuntime(hive, {
    outboxPath: () => holder.outboxPath,
    getToken: () => holder.token,
    nodeId: () => 'node-runtime',
    nodeName: () => 'runtime machine',
    broadcast: (s) => broadcasts.push(s),
    log: () => {}
  });
  return { rt, broadcasts, holder };
}

const cfg = (enabled, url) => ({ relay: { enabled, url } });

// ─── reconcile ──────────────────────────────────────────────────────────────

test('every shape of "off" leaves the hive with no mirror attached', async (t) => {
  const hive = fakeHive();
  const { rt, holder } = runtime(hive, { token: undefined });
  t.after(() => rt.stop());

  // Off because switched off — even with a URL and a credential ready.
  holder.token = 'mdr_sometoken';
  rt.sync(cfg(false, 'ws://example'));
  assert.equal(hive.state.mirror, null, 'disabled');
  assert.equal(rt.status().enabled, false);

  // On, but nothing to connect TO.
  rt.sync(cfg(true, ''));
  assert.equal(hive.state.mirror, null, 'enabled but no URL');
  assert.equal(rt.status().enabled, false);

  rt.sync(cfg(true, '   '));
  assert.equal(hive.state.mirror, null, 'enabled but a blank URL is not a URL');

  // On with a URL, but nothing to authenticate WITH.
  holder.token = undefined;
  rt.sync(cfg(true, 'ws://example'));
  assert.equal(hive.state.mirror, null, 'enabled with a URL but no seat token');
  assert.equal(rt.status().enabled, false);
  assert.equal(rt.status().hasSeatToken, false);

  assert.equal(rt.status().state, 'idle', 'never connected at any point');
});

test('a configured relay connects, attaches the mirror, and reports online', () => withRelay(async ({ db, port }) => {
  const seat = seedSeat(db, 'runtime');
  const hive = fakeHive();
  const { rt } = runtime(hive, { token: seat.token });

  rt.sync(cfg(true, `ws://127.0.0.1:${port}`));
  await until(() => rt.status().state === 'online', 'runtime online');

  assert.equal(rt.status().enabled, true);
  assert.equal(rt.status().hasSeatToken, true);
  assert.equal(rt.status().nodeId, 'node-runtime');
  assert.equal(typeof hive.state.mirror, 'function', 'the hive seam is installed while connected');

  // The mirror must be live for mail: declining it would silently route
  // cross-machine mail back into the "undeliverable" branch.
  const taken = hive.state.mirror(
    { id: 'm1', from: 'god-1', act: 'request', subject: 's', body: 'b' },
    'someone-else'
  );
  assert.equal(taken, true, 'the envelope was queued');
  await until(() => rt.status().outboxDepth === 0, 'outbox drained');
  rt.stop();
}));

test('an unrelated config save leaves the connection alone', () => withRelay(async ({ db, port }) => {
  const seat = seedSeat(db, 'stable');
  const hive = fakeHive();
  const { rt, broadcasts } = runtime(hive, { token: seat.token });
  const url = `ws://127.0.0.1:${port}`;

  rt.sync(cfg(true, url));
  await until(() => rt.status().state === 'online', 'runtime online');
  const mirrorDuringOnline = hive.state.mirror;
  broadcasts.length = 0;

  // Same relay, same credential — the shape of every unrelated settings save.
  rt.sync(cfg(true, url));
  await sleep(60);

  assert.equal(rt.status().state, 'online', 'still online, no re-handshake');
  assert.equal(broadcasts.length, 0, 'a no-op reconcile must not churn status');
  assert.equal(hive.state.mirror, mirrorDuringOnline, 'the same mirror instance is still attached');
  rt.stop();
}));

test('clearing the credential disconnects an already-running relay', () => withRelay(async ({ db, port }) => {
  const seat = seedSeat(db, 'revoked');
  const hive = fakeHive();
  const { rt, holder } = runtime(hive, { token: seat.token });
  const url = `ws://127.0.0.1:${port}`;

  rt.sync(cfg(true, url));
  await until(() => rt.status().state === 'online', 'runtime online');

  holder.token = undefined; // the operator cleared the seat token
  rt.sync(cfg(true, url));

  assert.equal(rt.status().state, 'idle');
  assert.equal(rt.status().enabled, false);
  assert.equal(hive.state.mirror, null, 'the hive stops offering mail to a dead seat');
}));

test('changing the relay URL restarts onto the new one', () => withRelay(async ({ db, port }) => {
  const seat = seedSeat(db, 'moved');
  const hive = fakeHive();
  const { rt } = runtime(hive, { token: seat.token });

  rt.sync(cfg(true, 'ws://127.0.0.1:9'));
  await until(() => rt.status().attempt >= 1, 'first relay failing');

  rt.sync(cfg(true, `ws://127.0.0.1:${port}`));
  await until(() => rt.status().state === 'online', 'second relay online');
  assert.equal(rt.status().url, `ws://127.0.0.1:${port}`);
  rt.stop();
}));

test('restart() is the way out of a refused seat', () => withRelay(async ({ db, port }) => {
  const hive = fakeHive();
  const { rt, holder } = runtime(hive, { token: 'mdr_0000000000000000000000000000000000000000000000000000000000000000' });
  const url = `ws://127.0.0.1:${port}`;

  rt.sync(cfg(true, url));
  await until(() => rt.status().state === 'rejected', 'seat refused');

  // A repeated reconcile must NOT auto-retry — that would hammer the relay
  // with a credential that is known bad.
  rt.sync(cfg(true, url));
  await sleep(120);
  assert.equal(rt.status().state, 'rejected');

  // …but an operator who fixes the credential can force a fresh handshake.
  holder.token = seedSeat(db, 'fixed').token;
  rt.restart(cfg(true, url));
  await until(() => rt.status().state === 'online', 'reconnected with the fixed seat');
  rt.stop();
}));

// ─── the two seams ──────────────────────────────────────────────────────────

test('inbound envelopes from a peer reach the hive with their origin intact', () => withRelay(async ({ db, port }) => {
  const seat = seedSeat(db, 'receiver');
  const peerSeat = seedSeat(db, 'peer');
  const hive = fakeHive();
  const { rt } = runtime(hive, { token: seat.token });

  rt.sync(cfg(true, `ws://127.0.0.1:${port}`));
  await until(() => rt.status().state === 'online', 'runtime online');

  const peer = new WebSocket(`ws://127.0.0.1:${port}`);
  const send = (obj) => peer.send(JSON.stringify(obj));
  await new Promise((resolve, reject) => {
    peer.on('error', reject);
    peer.on('open', resolve);
  });
  send({ type: 'hello', token: peerSeat.token, nodeId: 'node-peer', nodeName: 'peer' });

  const message = {
    id: 'm-inbound-1', conversation: 'c', in_reply_to: null,
    from: 'peer-agent', to: 'jim-1', act: 'request',
    subject: 'hello from over there', body: 'body',
    hops: 0, requires_reply: true, needs_human: false,
    created_at: '2026-09-28T00:00:00.000Z'
  };
  send({
    type: 'send',
    envelope: {
      id: 'env-1', fromNode: 'node-peer', fromAgent: 'peer-agent',
      toAgent: 'jim-1', kind: 'ask', payload: message, ts: Date.now()
    }
  });

  await until(() => hive.state.received.length === 1, 'the hive took the inbound mail');
  assert.equal(hive.state.received[0].partial.id, 'm-inbound-1');
  assert.equal(hive.state.received[0].partial.from, 'peer-agent');
  assert.equal(hive.state.received[0].from, 'node-peer', 'the sending machine is attributed');

  peer.close();
  rt.stop();
}));

test('a payload that is not a hive message is dropped without killing the connection', () => withRelay(async ({ db, port }) => {
  const seat = seedSeat(db, 'picky');
  const hive = fakeHive();
  const { rt } = runtime(hive, { token: seat.token });
  const url = `ws://127.0.0.1:${port}`;

  rt.sync(cfg(true, url));
  await until(() => rt.status().state === 'online', 'runtime online');

  // The relay only checks that the payload is JSON, so a scalar sails through
  // it — refusing it is this runtime's job.
  const peer = new WebSocket(url);
  await new Promise((resolve, reject) => { peer.on('error', reject); peer.on('open', resolve); });
  peer.send(JSON.stringify({ type: 'hello', token: seedSeat(db, 'bad-payload').token, nodeId: 'node-bad', nodeName: 'bad' }));
  peer.send(JSON.stringify({
    type: 'send',
    envelope: { id: 'env-bad', fromNode: 'node-bad', fromAgent: 'a', toAgent: 'jim-1', kind: 'ask', payload: 'not-an-object', ts: Date.now() }
  }));

  await until(() => rt.status().state === 'online', 'runtime still online after a bad frame', 5000);
  await sleep(150);
  assert.equal(hive.state.received.length, 0, 'a scalar payload is never handed to the hive');
  peer.close();
  rt.stop();
}));
