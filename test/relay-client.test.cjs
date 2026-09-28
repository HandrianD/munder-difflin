'use strict';

/**
 * src/main/relayClient.ts against the REAL relay (relay/server.js), driven
 * through test/load-ts.cjs — no Electron, no display, no keychain, no network.
 *
 * What matters here is the delivery contract, not the socket plumbing:
 *   - an envelope is durable BEFORE it reaches the wire;
 *   - it leaves the outbox only on an ack (at-least-once);
 *   - a refusal the relay can never accept is dropped by id, so one poison
 *     envelope cannot block everything queued behind it;
 *   - a refused seat stops retrying instead of backing off forever.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { WebSocketServer } = require('ws');

const { openDb } = require('../relay/db');
const { createRelay } = require('../relay/server');
const { newSeat } = require('../relay/auth');
const { ENVELOPE_KINDS } = require('../relay/envelope');

const loadTs = require('./load-ts.cjs');
const { RelayClient, RELAY_ENVELOPE_KINDS } = loadTs('src/main/relayClient.ts');

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

/** Poll the client's own view of itself — getStatus() is the contract the UI reads.
 *  Resolves with the matching status, so a caller can assert on its fields. */
const waitStatus = (client, pred, label) =>
  until(() => (pred(client.getStatus()) ? client.getStatus() : false), label);

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'md-relayclient-')), name);
}

function baseClient(overrides = {}) {
  const received = [];
  const statuses = [];
  const client = new RelayClient({
    url: '',
    token: 'mdr_placeholder',
    nodeId: 'node-under-test',
    nodeName: 'test machine',
    onDeliver: (env) => received.push(env),
    onStatus: (s) => statuses.push(s),
    reconnectDelaysMs: [25],
    helloTimeoutMs: 500,
    heartbeatIntervalMs: 200,
    ...overrides
  });
  return { client, received, statuses };
}

// ─── the allowlist is one list, not two ─────────────────────────────────────

test('the client and the relay agree on which kinds may cross machines', () => {
  assert.deepEqual([...RELAY_ENVELOPE_KINDS].sort(), [...ENVELOPE_KINDS].sort());
});

// ─── outbound validation (pure, no socket) ──────────────────────────────────

test('enqueue stamps this machine\'s node id and rejects anything the relay would refuse', (t) => {
  const { client, received } = baseClient();
  t.after(() => client.stop());

  const ok = client.enqueue({
    fromAgent: 'god',
    toAgent: 'worker-1',
    kind: 'ask',
    payload: { subject: 'hi' }
  });
  assert.equal(ok.ok, true);

  // A caller cannot speak for another node — the client owns fromNode.
  const rejected = client.enqueue({ fromAgent: 'god', toAgent: null, kind: 'exec', payload: {} });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /kind must be one of/);

  const big = client.enqueue({ fromAgent: 'god', toAgent: null, kind: 'ask', payload: { pad: 'x'.repeat(1024 * 1024 + 16) } });
  assert.equal(big.ok, false);
  assert.match(big.error, /1 MiB/);

  const unserializable = (() => {
    const cyclic = {};
    cyclic.self = cyclic;
    return client.enqueue({ fromAgent: 'god', toAgent: null, kind: 'ask', payload: cyclic });
  })();
  assert.equal(unserializable.ok, false);
  assert.match(unserializable.error, /JSON-serializable/);

  assert.equal(client.outboxDepth(), 1, 'only the accepted envelope is queued');
  assert.equal(received.length, 0);
  assert.equal(client.getStatus().state, 'idle');
});

test('the outbox is durable before anything reaches the wire', async (t) => {
  const outboxPath = tmpFile('outbox.json');
  const { client } = baseClient({ outboxPath, url: 'ws://127.0.0.1:1' });
  t.after(() => client.stop());

  client.enqueue({ fromAgent: 'god', toAgent: 'worker-1', kind: 'ask', payload: { subject: 'offline mail' } });
  assert.equal(client.outboxDepth(), 1);

  const onDisk = JSON.parse(fs.readFileSync(outboxPath, 'utf8'));
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].payload.subject, 'offline mail');
  assert.equal(onDisk[0].fromNode, 'node-under-test');

  // A second instance over the same file picks the mail up — this is the
  // "quit while the relay was down" path.
  const { client: revived } = baseClient({ outboxPath });
  t.after(() => revived.stop());
  assert.equal(revived.outboxDepth(), 1, 'queued mail survives a restart');
});

// ─── against the real relay ─────────────────────────────────────────────────

test('mail queued while offline is delivered on reconnect, then acked out of the outbox', () => withRelay(async ({ db, port }) => {
  const receiverSeat = seedSeat(db, 'receiver');
  const senderSeat = seedSeat(db, 'sender');

  const received = [];
  const peer = new RelayClient({
    url: `ws://127.0.0.1:${port}`,
    token: receiverSeat.token,
    nodeId: 'node-peer',
    nodeName: 'peer machine',
    onDeliver: (env) => received.push(env),
    reconnectDelaysMs: [25],
    heartbeatIntervalMs: 60_000
  });
  t_after.push(() => peer.stop());
  peer.start();
  await waitStatus(peer, (s) => s.state === 'online', 'peer online');

  const outboxPath = tmpFile('outbox.json');
  const sender = new RelayClient({
    url: `ws://127.0.0.1:${port}`,
    token: senderSeat.token,
    nodeId: 'node-sender',
    nodeName: 'sender machine',
    onDeliver: () => {},
    outboxPath,
    reconnectDelaysMs: [25],
    heartbeatIntervalMs: 60_000
  });
  t_after.push(() => sender.stop());

  // Deliberately NOT started: this is the "relay was down / app was quit" case.
  const queued = sender.enqueue({
    id: 'env-queued-1',
    fromAgent: 'god',
    toAgent: 'worker-1',
    kind: 'ask',
    payload: { subject: 'from before the reboot', body: 'still here' }
  });
  assert.equal(queued.ok, true);
  assert.equal(sender.outboxDepth(), 1);

  sender.start();
  await waitStatus(sender, (s) => s.state === 'online', 'sender online');
  await until(() => sender.outboxDepth() === 0, 'sender outbox drained');

  await until(() => received.length === 1, 'peer received the envelope');
  assert.equal(received[0].id, 'env-queued-1');
  assert.equal(received[0].fromNode, 'node-sender');
  assert.equal(received[0].kind, 'ask');
  assert.deepEqual(received[0].payload, { subject: 'from before the reboot', body: 'still here' });

  const rows = db.prepare('SELECT to_node, delivered_at FROM messages').all();
  assert.equal(rows.length, 1, 'the relay queued it for exactly the other machine');
  assert.equal(rows[0].to_node, 'node-peer');
  assert.notEqual(rows[0].delivered_at, null, 'acked only after the write completed');
}));

test('a refused seat is reported as rejected, and does not retry forever', () => withRelay(async ({ port }) => {
  const { client } = baseClient({
    url: `ws://127.0.0.1:${port}`,
    token: 'mdr_0000000000000000000000000000000000000000000000000000000000000000',
    nodeId: 'node-bogus',
    reconnectDelaysMs: [20]
  });
  t_after.push(() => client.stop());

  client.start();
  const s = await waitStatus(client, (x) => x.state === 'rejected', 'seat refused');
  assert.match(s.lastError ?? '', /no live seat/);

  // If this were treated as a transient failure it would be in `backoff`
  // climbing toward a retry. It must stay parked.
  await sleep(250);
  assert.equal(client.getStatus().state, 'rejected');
  assert.equal(client.getStatus().attempt, 0, 'no backoff was scheduled');

  // …and start() is the way back, once the operator fixes the credential.
  client.stop();
  assert.equal(client.getStatus().state, 'idle');
}));

test('stop() clears in-flight envelopes so a restart actually re-sends them', () => withRelay(async ({ db, port }) => {
  const receiverSeat = seedSeat(db, 'receiver');
  const senderSeat = seedSeat(db, 'sender');

  const received = [];
  const peer = new RelayClient({
    url: `ws://127.0.0.1:${port}`,
    token: receiverSeat.token,
    nodeId: 'node-peer2',
    onDeliver: (env) => received.push(env),
    reconnectDelaysMs: [25],
    heartbeatIntervalMs: 60_000
  });
  t_after.push(() => peer.stop());
  peer.start();
  await waitStatus(peer, (s) => s.state === 'online', 'peer online');

  const sender = new RelayClient({
    url: `ws://127.0.0.1:${port}`,
    token: senderSeat.token,
    nodeId: 'node-sender2',
    onDeliver: () => {},
    reconnectDelaysMs: [25],
    heartbeatIntervalMs: 60_000
  });
  t_after.push(() => sender.stop());
  sender.start();
  await waitStatus(sender, (s) => s.state === 'online', 'sender online');

  // Enqueue and stop in the SAME tick: no ack can have landed yet, so the
  // in-flight slot is genuinely occupied when we pull the plug.
  sender.enqueue({ fromAgent: 'god', toAgent: 'worker-1', kind: 'ask', payload: { subject: 'cut mid-flight' } });
  assert.equal(sender.getStatus().inflight, 1, 'written to the socket, not yet acked');
  sender.stop();
  assert.equal(sender.getStatus().inflight, 0, 'a closed socket holds nothing in flight');

  sender.start();
  await waitStatus(sender, (s) => s.state === 'online', 'sender back online');
  // The discriminating assertion: if the stale in-flight id survived stop(),
  // flush() would skip this envelope forever and the outbox would never drain.
  await until(() => sender.outboxDepth() === 0, 'outbox drained after a restart');
  assert.ok(received.length >= 1, 'the envelope reached the other machine');
}));

test('one refused envelope is dropped by id; an unattributed refusal leaves the queue alone', () => {
  // A stand-in relay that refuses the first envelope as poison and the second
  // with no id at all — the difference is what stops (or does not stop) a
  // queue from wedging on a single bad message.
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const errors = [];
  wss.on('connection', (ws) => {
    let greeted = false;
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'hello') {
        greeted = true;
        ws.send(JSON.stringify({ type: 'welcome', nodeId: msg.nodeId, seatId: 'seat_x', seatLabel: 'stub', serverTs: Date.now() }));
        return;
      }
      if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', ts: Date.now() })); return; }
      if (msg.type !== 'send' || !greeted) return;
      const env = msg.envelope;
      const index = errors.length;
      errors.push(env.id);
      ws.send(JSON.stringify({
        type: 'error',
        code: 'unknown-kind',
        message: 'kind must be one of ask, reply, result, board.update',
        // First refusal names its envelope; the second is deliberately anonymous.
        id: index === 0 ? env.id : null
      }));
    });
  });

  return new Promise((resolve, reject) => {
    wss.on('error', reject);
    wss.on('listening', () => {
      const port = wss.address().port;
      const { client } = baseClient({ url: `ws://127.0.0.1:${port}`, token: 'mdr_stub', nodeId: 'node-stub' });
      const done = (fn) => { try { fn(); } catch (e) { reject(e); return; } client.stop(); wss.close(() => resolve()); };
      client.start();
      waitStatus(client, (s) => s.state === 'online', 'stub online')
        .then(async () => {
          client.enqueue({ fromAgent: 'god', toAgent: null, kind: 'ask', payload: { n: 1 } });
          await until(() => errors.length === 1, 'first refusal');
          await until(() => client.outboxDepth() === 0, 'poison envelope dropped');

          client.enqueue({ fromAgent: 'god', toAgent: null, kind: 'ask', payload: { n: 2 } });
          await until(() => errors.length === 2, 'second refusal');
          // Give any (wrong) drop a moment to happen.
          await sleep(60);
          assert.equal(client.outboxDepth(), 1, 'an unattributed refusal must NOT discard queued mail');
          done(() => {});
        })
        .catch((e) => { client.stop(); wss.close(() => reject(e)); });
    });
  });
});

test('a relay that disappears is retried with backoff, and queued mail goes with it', () => {
  // No server on this port at all: the client must land in `backoff`, keep
  // the outbox, and keep trying — never lose the mail to a failed connect.
  const outboxPath = tmpFile('outbox.json');
  const { client, statuses } = baseClient({
    url: 'ws://127.0.0.1:9',
    token: 'mdr_x',
    nodeId: 'node-offline',
    outboxPath,
    reconnectDelaysMs: [20]
  });
  t_after.push(() => client.stop());

  client.enqueue({ fromAgent: 'god', toAgent: 'worker-1', kind: 'reply', payload: { subject: 'never lost' } });
  client.start();

  return until(() => client.getStatus().attempt >= 2, 'reconnect attempts climbing', 6000)
    .then(() => {
      assert.ok(statuses.some((s) => s.state === 'backoff'),
        'a failed connect parks in backoff instead of giving up');
      assert.equal(client.outboxDepth(), 1, 'a failed connect must not discard queued mail');
      assert.notEqual(client.getStatus().state, 'rejected', 'an unreachable relay is not a refused seat');
      client.stop();
      assert.equal(client.getStatus().state, 'idle');
      const onDisk = JSON.parse(fs.readFileSync(outboxPath, 'utf8'));
      assert.equal(onDisk.length, 1, 'the queue outlives a stop');
    });
});

// `t.after` hooks collected per test run — the helpers above push teardown
// work here so a failing assertion still closes its sockets.
let t_after = [];
test.beforeEach(() => { t_after = []; });
test.afterEach(async () => {
  for (const fn of t_after.splice(0)) {
    try { fn(); } catch { /* teardown is best-effort */ }
  }
});
