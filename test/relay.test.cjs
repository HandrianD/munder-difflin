'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { WebSocket } = require('ws');

const { openDb } = require('../relay/db');
const { createRelay, CLOSE } = require('../relay/server');
const { newSeat, hashToken, newSeatToken } = require('../relay/auth');
const { validateEnvelope, MAX_PAYLOAD_BYTES, ENVELOPE_KINDS } = require('../relay/envelope');

const NOOP = { info() {}, warn() {}, error() {} };
const CLI = path.join(__dirname, '..', 'relay', 'cli.js');

// ─── helpers ────────────────────────────────────────────────────────────────

/** Mint a seat row directly, the way the CLI does. */
function seedSeat(db, label, opts = {}) {
  const seat = newSeat(label);
  db.prepare('INSERT INTO seats (id, label, token_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?)')
    .run(seat.id, seat.label, seat.token_hash, Date.now(), opts.revokedAt ?? null);
  return seat;
}

/** Run `fn` against a throwaway relay on an ephemeral port, then tear it down.
 *  Each test gets its own database: the broadcast fan-out set is "every node
 *  this relay has ever seen", so shared state would make target counts depend
 *  on test ordering. */
async function withRelay(fn, opts = {}) {
  const db = openDb(opts.file || ':memory:');
  const relay = createRelay({
    db, host: '127.0.0.1', port: 0,
    authTimeoutMs: 2000, heartbeatMs: 60_000, revocationSweepMs: 40,
    logger: NOOP, ...opts.relay
  });
  await relay.start();
  try {
    await fn({ db, relay, port: relay.port() });
  } finally {
    await relay.stop();
    db.close();
  }
}

function connect(port, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const c = { ws, queue: [], waiters: [], closeWaiters: [], closed: null };
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      const i = c.waiters.findIndex((w) => w.match(m));
      if (i >= 0) { const [w] = c.waiters.splice(i, 1); w.resolve(m); }
      else c.queue.push(m);
    });
    ws.on('close', (code, reason) => {
      c.closed = { code, reason: reason.toString() };
      for (const w of c.waiters.splice(0)) w.reject(Object.assign(new Error(`closed ${code}`), { closed: c.closed }));
      for (const w of c.closeWaiters.splice(0)) { clearTimeout(w.t); w.resolve(c.closed); }
    });
    ws.on('error', () => { /* the close handler carries the outcome */ });
    ws.on('open', () => { ws.send(JSON.stringify(hello)); resolve(c); });
    const guard = setTimeout(() => reject(new Error('socket never opened')), 4000);
    guard.unref?.();
  });
}

function waitFor(c, match, ms = 4000) {
  const i = c.queue.findIndex(match);
  if (i >= 0) return Promise.resolve(c.queue.splice(i, 1)[0]);
  if (c.closed) return Promise.reject(Object.assign(new Error('already closed'), { closed: c.closed }));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for message')), ms);
    c.waiters.push({
      match,
      resolve: (m) => { clearTimeout(t); resolve(m); },
      reject: (e) => { clearTimeout(t); reject(e); }
    });
  });
}

function waitForClose(c, ms = 4000) {
  if (c.closed) return Promise.resolve(c.closed);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for close')), ms);
    c.closeWaiters.push({ t, resolve });
  });
}

function sendEnvelope(c, envelope) {
  c.ws.send(JSON.stringify({ type: 'send', envelope }));
}

function envelope(over = {}) {
  return {
    id: `env-${Math.random().toString(36).slice(2, 10)}`,
    fromNode: 'node-a',
    fromAgent: 'god',
    toAgent: 'worker-1',
    kind: 'ask',
    payload: { subject: 'hello', body: 'from a' },
    ts: Date.now(),
    ...over
  };
}

const helloFor = (seat, nodeId, nodeName) => ({ type: 'hello', token: seat.token, nodeId, nodeName });

const rowFor = (db, sql, ...args) => db.prepare(sql).get(...args);
const countFor = (db, sql, ...args) => db.prepare(sql).get(...args).n;

// ─── envelope validation (pure) ─────────────────────────────────────────────

test('validateEnvelope accepts an envelope claiming the socket identity', () => {
  const r = validateEnvelope(envelope({ fromNode: 'node-a' }), 'node-a');
  assert.equal(r.ok, true);
  assert.equal(r.value.fromNode, 'node-a');
  assert.equal(r.value.fromAgent, 'god');
  assert.equal(r.value.toAgent, 'worker-1');
});

test('validateEnvelope refuses a sender claiming another node id', () => {
  const r = validateEnvelope(envelope({ fromNode: 'node-b' }), 'node-a');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not-your-node');
});

test('validateEnvelope refuses unknown kinds, blank agents and bad timestamps', () => {
  assert.equal(validateEnvelope(envelope({ kind: 'admin' }), 'node-a').code, 'unknown-kind');
  assert.equal(validateEnvelope(envelope({ fromAgent: '' }), 'node-a').code, 'bad-envelope');
  assert.equal(validateEnvelope(envelope({ toAgent: '' }), 'node-a').code, 'bad-envelope');
  assert.equal(validateEnvelope(envelope({ ts: 0 }), 'node-a').code, 'bad-envelope');
  assert.equal(validateEnvelope('nope', 'node-a').code, 'bad-envelope');
  assert.equal(validateEnvelope(null, 'node-a').code, 'bad-envelope');
});

test('validateEnvelope allows a broadcast (toAgent null) and caps payload size', () => {
  assert.equal(validateEnvelope(envelope({ toAgent: null }), 'node-a').ok, true);
  const huge = { ...envelope(), payload: { blob: 'x'.repeat(MAX_PAYLOAD_BYTES + 1024) } };
  assert.equal(validateEnvelope(huge, 'node-a').code, 'payload-too-large');
  for (const k of ['ask', 'reply', 'result', 'board.update']) {
    assert.ok(ENVELOPE_KINDS.has(k), `${k} must be allowed to cross machines`);
  }
  assert.ok(!ENVELOPE_KINDS.has('exec'), 'the relay is a mailbox, not an RPC bus');
});

test('validateEnvelope rejects a payload that is not JSON-serializable', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(validateEnvelope(envelope({ payload: cyclic }), 'node-a').code, 'bad-envelope');
});

// ─── auth material ──────────────────────────────────────────────────────────

test('a seat token is 256 bits of randomness behind a grep-able prefix', () => {
  const token = newSeatToken();
  assert.match(token, /^mdr_[0-9a-f]{64}$/);
  assert.notEqual(newSeatToken(), token, 'tokens must not collide');
});

test('the relay stores only a hash of the token, never the token', () => {
  const db = openDb(':memory:');
  try {
    const seat = seedSeat(db, 'alpha');
    const row = db.prepare('SELECT token_hash FROM seats WHERE id = ?').get(seat.id);
    assert.equal(row.token_hash, hashToken(seat.token));
    assert.notEqual(row.token_hash, seat.token);

    const dump = db.prepare('SELECT * FROM seats').all().map((r) => JSON.stringify(r)).join('');
    assert.ok(!dump.includes(seat.token), 'the plaintext token must not appear anywhere in the table');
  } finally {
    db.close();
  }
});

// ─── server behaviour ───────────────────────────────────────────────────────

test('a live seat completes the handshake and is recorded as a node', () => withRelay(async ({ db, port }) => {
  const seat = seedSeat(db, 'alpha');
  const c = await connect(port, helloFor(seat, 'node-a', 'machine A'));
  const welcome = await waitFor(c, (m) => m.type === 'welcome');
  assert.equal(welcome.nodeId, 'node-a');
  assert.equal(welcome.seatLabel, 'alpha');

  const node = rowFor(db, 'SELECT * FROM nodes WHERE id = ?', 'node-a');
  assert.ok(node, 'the machine is registered');
  assert.equal(node.seat_id, seat.id);
  assert.equal(node.name, 'machine A');
  c.ws.close();
}));

test('an unknown token is refused with NO_SEAT', () => withRelay(async ({ db, port }) => {
  const c = await connect(port, { type: 'hello', token: 'mdr_' + 'f'.repeat(64), nodeId: 'node-bad' });
  assert.equal((await waitForClose(c)).code, CLOSE.NO_SEAT);
  assert.equal(rowFor(db, 'SELECT 1 AS n FROM nodes WHERE id = ?', 'node-bad'), undefined);
}));

test('a revoked seat cannot connect', () => withRelay(async ({ db, port }) => {
  const seat = seedSeat(db, 'dead', { revokedAt: Date.now() - 1000 });
  const c = await connect(port, helloFor(seat, 'node-dead'));
  assert.equal((await waitForClose(c)).code, CLOSE.NO_SEAT);
}));

test('a second seat cannot claim a node id already owned by another seat', () => withRelay(async ({ db, port }) => {
  const alpha = seedSeat(db, 'alpha-owner');
  const thief = seedSeat(db, 'thief');

  // Own the mailbox first — each test starts from an empty database, so the
  // registration has to happen here rather than being inherited.
  const owner = await connect(port, helloFor(alpha, 'node-a'));
  await waitFor(owner, (m) => m.type === 'welcome');
  owner.ws.close();
  await waitForClose(owner);

  const c = await connect(port, helloFor(thief, 'node-a'));
  assert.equal((await waitForClose(c)).code, CLOSE.NODE_CONFLICT);
  assert.equal(rowFor(db, 'SELECT seat_id FROM nodes WHERE id = ?', 'node-a').seat_id, alpha.id,
    'the original seat still owns the mailbox');
}));

test('the first message must be a hello', () => withRelay(async ({ port }) => {
  const c = await connect(port, { type: 'nonsense' });
  assert.equal((await waitForClose(c)).code, CLOSE.BAD_HELLO);
}));

test('an envelope addressed to a live peer arrives intact', () => withRelay(async ({ db, port }) => {
  const seat = seedSeat(db, 'router');
  const a = await connect(port, helloFor(seat, 'node-route-a'));
  const b = await connect(port, helloFor(seat, 'node-route-b'));
  await waitFor(a, (m) => m.type === 'welcome');
  await waitFor(b, (m) => m.type === 'welcome');

  const env = envelope({ fromNode: 'node-route-a', payload: { subject: 'spec', body: 'word' } });
  sendEnvelope(a, env);

  const ack = await waitFor(a, (m) => m.type === 'ack');
  assert.equal(ack.id, env.id);
  assert.equal(ack.targets, 1, 'only node-route-b is a target of node-route-a');

  const got = await waitFor(b, (m) => m.type === 'deliver');
  assert.equal(got.envelope.id, env.id);
  assert.equal(got.envelope.fromNode, 'node-route-a');
  assert.equal(got.envelope.fromAgent, 'god');
  assert.equal(got.envelope.toAgent, 'worker-1');
  assert.deepEqual(got.envelope.payload, { subject: 'spec', body: 'word' });
}));

test('broadcast fan-out reaches all peer machines but not the sender', () => withRelay(async ({ db, port }) => {
  const seat = seedSeat(db, 'fan');
  const sender = await connect(port, helloFor(seat, 'node-fan-src'));
  const r1 = await connect(port, helloFor(seat, 'node-fan-1'));
  const r2 = await connect(port, helloFor(seat, 'node-fan-2'));
  await Promise.all([sender, r1, r2].map((c) => waitFor(c, (m) => m.type === 'welcome')));

  sendEnvelope(sender, envelope({ fromNode: 'node-fan-src', toAgent: null }));
  const ack = await waitFor(sender, (m) => m.type === 'ack');
  assert.equal(ack.targets, 2, 'both peers are targets, the sender is not');

  const one = await waitFor(r1, (m) => m.type === 'deliver');
  const two = await waitFor(r2, (m) => m.type === 'deliver');
  assert.equal(one.envelope.toAgent, null, 'broadcast survives the hop');
  assert.equal(two.envelope.toAgent, null);
  assert.equal(
    countFor(db, 'SELECT count(*) AS n FROM messages WHERE id = ? AND to_node = ?', one.envelope.id, 'node-fan-src'),
    0, 'the sender never gets its own mail back'
  );
}));

test('mail sent while a machine is away is waiting when it comes back', () => withRelay(async ({ db, port }) => {
  const seat = seedSeat(db, 'offline');
  const a = await connect(port, helloFor(seat, 'node-off-a'));
  const b = await connect(port, helloFor(seat, 'node-off-b'));
  await waitFor(a, (m) => m.type === 'welcome');
  await waitFor(b, (m) => m.type === 'welcome');
  b.ws.close();
  await waitForClose(b);

  const env = envelope({ fromNode: 'node-off-a', payload: { subject: 'while you were out' } });
  sendEnvelope(a, env);
  const ack = await waitFor(a, (m) => m.type === 'ack');
  assert.equal(ack.targets, 1, 'the offline machine is still a target');
  assert.equal(
    countFor(db, 'SELECT count(*) AS n FROM messages WHERE id = ? AND delivered_at IS NULL', env.id),
    1, 'the envelope is queued, not dropped'
  );

  const b2 = await connect(port, helloFor(seat, 'node-off-b'));
  const got = await waitFor(b2, (m) => m.type === 'deliver');
  assert.equal(got.envelope.id, env.id);
  assert.equal(
    countFor(db, 'SELECT count(*) AS n FROM messages WHERE id = ? AND delivered_at IS NULL', env.id),
    0, 'delivery marks the row so it is not sent twice'
  );
}));

test('re-sending the same envelope id does not multiply rows', () => withRelay(async ({ db, port }) => {
  const seat = seedSeat(db, 'dedupe');
  const a = await connect(port, helloFor(seat, 'node-dup-a'));
  const b = await connect(port, helloFor(seat, 'node-dup-b'));
  await waitFor(a, (m) => m.type === 'welcome');
  await waitFor(b, (m) => m.type === 'welcome');

  const env = envelope({ fromNode: 'node-dup-a' });
  sendEnvelope(a, env);
  const first = await waitFor(a, (m) => m.type === 'ack');
  const rowsAfterFirst = countFor(db, 'SELECT count(*) AS n FROM messages WHERE id = ?', env.id);
  assert.equal(rowsAfterFirst, first.targets);

  sendEnvelope(a, env);
  await waitFor(a, (m) => m.type === 'ack' && m.id === env.id);
  assert.equal(
    countFor(db, 'SELECT count(*) AS n FROM messages WHERE id = ?', env.id),
    rowsAfterFirst, 'the retry is a no-op at the queue level'
  );
}));

test('a forged envelope is reported and never reaches the queue', () => withRelay(async ({ db, port }) => {
  const seat = seedSeat(db, 'forge');
  const a = await connect(port, helloFor(seat, 'node-forge-a'));
  const b = await connect(port, helloFor(seat, 'node-forge-b'));
  await waitFor(a, (m) => m.type === 'welcome');
  await waitFor(b, (m) => m.type === 'welcome');

  sendEnvelope(a, envelope({ id: 'forged-1', fromNode: 'node-forge-b' }));
  const err = await waitFor(a, (m) => m.type === 'error');
  assert.equal(err.code, 'not-your-node');
  assert.equal(rowFor(db, 'SELECT 1 AS n FROM messages WHERE id = ?', 'forged-1'), undefined);
}));

test('an unknown envelope kind is refused', () => withRelay(async ({ db, port }) => {
  const seat = seedSeat(db, 'kinds');
  const a = await connect(port, helloFor(seat, 'node-kind-a'));
  await waitFor(a, (m) => m.type === 'welcome');
  sendEnvelope(a, envelope({ fromNode: 'node-kind-a', kind: 'admin' }));
  assert.equal((await waitFor(a, (m) => m.type === 'error')).code, 'unknown-kind');
}));

test('a live socket answers protocol pings', () => withRelay(async ({ db, port }) => {
  const seat = seedSeat(db, 'pings');
  const a = await connect(port, helloFor(seat, 'node-ping-a'));
  await waitFor(a, (m) => m.type === 'welcome');
  a.ws.send(JSON.stringify({ type: 'ping' }));
  const pong = await waitFor(a, (m) => m.type === 'pong');
  assert.ok(pong.ts > 0);
}));

test('revoking a seat disconnects the machine and blocks it from returning', () => withRelay(async ({ db, port }) => {
  const seat = seedSeat(db, 'temp');
  const c = await connect(port, helloFor(seat, 'node-temp'));
  await waitFor(c, (m) => m.type === 'welcome');

  db.prepare('UPDATE seats SET revoked_at = ? WHERE id = ?').run(Date.now(), seat.id);
  assert.equal((await waitForClose(c)).code, CLOSE.SEAT_REVOKED);

  const again = await connect(port, helloFor(seat, 'node-temp-2'));
  assert.equal((await waitForClose(again)).code, CLOSE.NO_SEAT);
}));

test('stats reports queue depth and start() purges envelopes past retention', () => withRelay(async ({ db, relay }) => {
  seedSeat(db, 'stats-seat');
  const s = relay.stats();
  assert.ok(s.total_seats >= 1, 'the seat minted above is counted');
  assert.equal(typeof s.queued, 'number');

  db.prepare(`INSERT INTO messages (id, from_node, from_agent, to_node, to_agent, kind, payload, ts, queued_at, delivered_at)
              VALUES ('old-1','node-a','god','node-b','worker-1','ask','{}',1,1,NULL)`).run();
  assert.ok(rowFor(db, 'SELECT 1 AS n FROM messages WHERE id = ?', 'old-1'), 'the row exists before the purge');

  // A second relay on the same database runs the retention sweep on start().
  const r2 = createRelay({ db, port: 0, logger: NOOP });
  await r2.start();
  try {
    assert.equal(rowFor(db, 'SELECT 1 AS n FROM messages WHERE id = ?', 'old-1'), undefined, 'the stale row is gone');
  } finally {
    await r2.stop();
  }
}));

// ─── CLI (subprocess) ───────────────────────────────────────────────────────

test('the CLI mints, lists and revokes seats against a file database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-relay-'));
  const file = path.join(dir, 'relay.db');
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 20_000 });

  try {
    const created = run('seat', 'create', 'laptop', '--db', file);
    assert.equal(created.status, 0, created.stderr);
    assert.match(created.stdout, /seat created/);
    const token = (created.stdout.match(/mdr_[0-9a-f]{64}/) || [])[0];
    assert.ok(token, 'the token is printed exactly once, at mint time');

    const listed = run('seat', 'list', '--db', file);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /laptop/);
    assert.match(listed.stdout, /live/);
    assert.ok(!listed.stdout.includes(token), 'listing must never echo a token');

    const seatId = (listed.stdout.match(/seat_[0-9a-f]{16}/) || [])[0];
    assert.ok(seatId, 'a seat id is printed');

    const revoked = run('seat', 'revoke', seatId, '--db', file);
    assert.equal(revoked.status, 0, revoked.stderr);
    assert.match(revoked.stdout, new RegExp(`revoked ${seatId}`));
    assert.match(run('seat', 'list', '--db', file).stdout, /revoked/);

    const stats = run('stats', '--db', file);
    assert.equal(stats.status, 0, stats.stderr);
    assert.match(stats.stdout, /seats\s+0 live \/ 1 total/);

    assert.equal(run('--help').status, 0);
    assert.match(run('--help').stdout, /seat create <label>/);

    const bad = run('seat');
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /usage: seat create/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a seat revoked through the CLI stops a machine that already connected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-relay-'));
  const file = path.join(dir, 'relay.db');
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 20_000 });
  try {
    // withRelay closes the database before we can delete the directory, so the
    // teardown has to sit OUTSIDE it — Windows will not unlink an open file.
    await withRelay(async ({ port }) => {
      const created = run('seat', 'create', 'x', '--db', file);
      const token = (created.stdout.match(/mdr_[0-9a-f]{64}/) || [])[0];
      assert.ok(token);

      const ok = await connect(port, { type: 'hello', token, nodeId: 'node-cli', nodeName: 'cli' });
      await waitFor(ok, (m) => m.type === 'welcome');
      ok.ws.close();

      const seatId = (run('seat', 'list', '--db', file).stdout.match(/seat_[0-9a-f]{16}/) || [])[0];
      assert.equal(run('seat', 'revoke', seatId, '--db', file).status, 0);

      const denied = await connect(port, { type: 'hello', token, nodeId: 'node-cli-2' });
      assert.equal((await waitForClose(denied)).code, CLOSE.NO_SEAT);
    }, { file });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
