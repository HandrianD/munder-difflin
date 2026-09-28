'use strict';

/**
 * The relay: a WebSocket postbox between harness machines on a tailnet.
 *
 * Threat model, in one line — the transport IS the security (Tailscale
 * WireGuard), so this process does not terminate TLS, mint identities, or see
 * provider keys. What it does enforce:
 *
 *   1. You may not talk until you present a live seat token.
 *   2. You may only speak for the node id you authenticated as (the forgery
 *      guard in envelope.js).
 *   3. A revoked seat is disconnected and stays disconnected.
 *   4. Nothing is ever silently dropped — it is either handed to a live socket
 *      or left queued for that machine's next connect.
 *
 * Delivery is AT-LEAST-ONCE. A row is marked `delivered_at` only once `ws.send`
 * acknowledges the write, so a socket that dies mid-flight leaves the row
 * pending and the receiver may see it twice across a reconnect. The receiving
 * side is idempotent (the HiveMessage id is the inbox filename), which is what
 * makes duplicates harmless — see the `deliver()` seam in src/main/hive.ts.
 *
 * Routing note: the relay does NOT know which machine hosts which agent. A
 * targeted envelope is fanned out to every live machine except the sender, and
 * each receiver applies `deliver()`, which returns false where the inbox does
 * not exist. Keeping the roster off the relay is deliberate — it means the
 * relay can never be used to enumerate who is in the hive.
 */

const { WebSocketServer, WebSocket } = require('ws');
const { hashToken, safeEqual } = require('./auth');
const { withTransaction } = require('./db');
const { validateEnvelope } = require('./envelope');

/** Close codes. 4xxx is application space; 1xxx/2xxx/3xxx are protocol-owned. */
const CLOSE = {
  PROTOCOL: 4000,
  AUTH_TIMEOUT: 4001,
  BAD_HELLO: 4002,
  NO_SEAT: 4003,
  NODE_CONFLICT: 4004,
  SEAT_REVOKED: 4005
};

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  authTimeoutMs: 10_000,
  heartbeatMs: 15_000,
  /** Sweep cadence for seats revoked by a separate CLI process while we run. */
  revocationSweepMs: 5_000,
  /** How long an undeliverable envelope waits before the queue forgets it. */
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  maxPayload: 2 * 1024 * 1024
};

const silent = { info() {}, warn() {}, error() {} };

/**
 * @param {{db: import('node:sqlite').DatabaseSync} & Partial<typeof DEFAULTS> &
 *         {logger?: {info:Function,warn:Function,error:Function}}} opts
 */
function createRelay(opts) {
  const cfg = { ...DEFAULTS, ...opts };
  const db = opts.db;
  const log = opts.logger || silent;
  if (!db) throw new Error('createRelay requires a db');

  /** nodeId -> WebSocket */
  const sockets = new Map();
  /** nodeId -> auth context (seat + node identity) */
  const authed = new Map();
  /** nodeId -> Set<messageId> handed to `ws.send` but not yet acknowledged.
   *  Without this, a second flush issued before the first's callbacks land
   *  would re-send rows whose `delivered_at` is still NULL. */
  const inflight = new Map();

  let wss = null;
  let heartbeatTimer = null;
  let sweepTimer = null;

  const stmt = {
    // token_hash is selected even though the WHERE already used it: resolveSeat
    // re-checks the match with timingSafeEqual, which needs both sides.
    seatByHash: db.prepare('SELECT id, label, token_hash, revoked_at FROM seats WHERE token_hash = ?'),
    seatById: db.prepare('SELECT id, label, revoked_at FROM seats WHERE id = ?'),
    upsertNode: db.prepare(`
      INSERT INTO nodes (id, seat_id, name, last_seen)
      VALUES (@id, @seat_id, @name, @last_seen)
      ON CONFLICT(id) DO UPDATE SET
        seat_id = excluded.seat_id,
        name = COALESCE(excluded.name, nodes.name),
        last_seen = excluded.last_seen
    `),
    nodeById: db.prepare('SELECT id, seat_id FROM nodes WHERE id = ?'),
    // The fan-out set: every machine we have ever seen whose seat is still
    // live. A never-seen machine is not a target (it has no mailbox yet) and
    // a revoked seat is deliberately not a target either.
    activeTargets: db.prepare(`
      SELECT n.id FROM nodes n
      JOIN seats s ON s.id = n.seat_id
      WHERE s.revoked_at IS NULL AND n.id <> ?
    `),
    insertMessage: db.prepare(`
      INSERT OR IGNORE INTO messages
        (id, from_node, from_agent, to_node, to_agent, kind, payload, ts, queued_at, delivered_at)
      VALUES (@id, @from_node, @from_agent, @to_node, @to_agent, @kind, @payload, @ts, @queued_at, NULL)
    `),
    pendingFor: db.prepare(
      'SELECT * FROM messages WHERE to_node = ? AND delivered_at IS NULL ORDER BY queued_at, id'
    ),
    markDelivered: db.prepare('UPDATE messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL'),
    touchNode: db.prepare('UPDATE nodes SET last_seen = ? WHERE id = ?'),
    seatRevoked: db.prepare('SELECT revoked_at FROM seats WHERE id = ?'),
    purgeOld: db.prepare('DELETE FROM messages WHERE queued_at < ?'),
    stats: db.prepare(`
      SELECT
        (SELECT count(*) FROM seats WHERE revoked_at IS NULL)       AS live_seats,
        (SELECT count(*) FROM seats)                                AS total_seats,
        (SELECT count(*) FROM nodes)                                AS nodes,
        (SELECT count(*) FROM messages WHERE delivered_at IS NULL)  AS queued,
        (SELECT count(*) FROM messages)                             AS total
    `)
  };

  // ── delivery ─────────────────────────────────────────────────────────────

  /** Hand every queued envelope for `nodeId` to its live socket, oldest first.
   *  A row is only marked delivered once `ws.send` confirms the write. */
  function flush(nodeId) {
    const ws = sockets.get(nodeId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    let pendingIds = inflight.get(nodeId);
    if (!pendingIds) { pendingIds = new Set(); inflight.set(nodeId, pendingIds); }

    for (const row of stmt.pendingFor.all(nodeId)) {
      if (pendingIds.has(row.id)) continue;   // already handed to the socket
      if (ws.readyState !== WebSocket.OPEN) break;

      let data;
      try {
        data = JSON.stringify({
          type: 'deliver',
          envelope: {
            id: row.id,
            fromNode: row.from_node,
            fromAgent: row.from_agent,
            toAgent: row.to_agent,
            kind: row.kind,
            payload: JSON.parse(row.payload),
            ts: row.ts
          }
        });
      } catch (err) {
        // A row we cannot even parse will never be deliverable; clear it so it
        // stops blocking everything queued behind it.
        log.error('[relay] dropping unreadable message', row.id, err);
        stmt.markDelivered.run(Date.now(), row.id);
        continue;
      }

      pendingIds.add(row.id);
      ws.send(data, (err) => {
        pendingIds.delete(row.id);
        if (err) {
          // Socket died mid-write: leave the row pending for the next connect.
          log.warn('[relay] send failed for', nodeId, (err && err.message) || err);
          return;
        }
        try { stmt.markDelivered.run(Date.now(), row.id); } catch { /* db closed */ }
      });
    }
  }

  /** Persist one envelope to every eligible machine and flush what is live. */
  function route(env) {
    const targets = stmt.activeTargets.all(env.fromNode).map((r) => r.id);
    const now = Date.now();

    const insert = () => withTransaction(db, () => {
      for (const to of targets) {
        stmt.insertMessage.run({
          id: env.id,
          from_node: env.fromNode,
          from_agent: env.fromAgent,
          to_node: to,
          to_agent: env.toAgent,
          kind: env.kind,
          payload: JSON.stringify(env.payload),
          ts: env.ts,
          queued_at: now
        });
      }
    });
    // Keyed on (id, to_node), so a retried envelope id cannot multiply across
    // the fan-out, and an identical retry from the sender is a no-op.
    insert();

    for (const to of targets) flush(to);
    return targets;
  }

  // ── auth ─────────────────────────────────────────────────────────────────

  function resolveSeat(token) {
    if (typeof token !== 'string' || token.length === 0 || token.length > 512) return null;
    const hash = hashToken(token);
    const row = stmt.seatByHash.get(hash);
    if (!row) return null;
    if (!safeEqual(row.token_hash, hash)) return null;
    if (row.revoked_at !== null && row.revoked_at !== undefined) return null;
    return row;
  }

  function handshake(ws, hello, timer) {
    if (typeof hello !== 'object' || hello === null) {
      ws.close(CLOSE.BAD_HELLO, 'expected a hello');
      return;
    }
    const seat = resolveSeat(hello.token);
    if (!seat) { ws.close(CLOSE.NO_SEAT, 'no live seat for that token'); return; }

    const nodeId = hello.nodeId;
    if (typeof nodeId !== 'string' || nodeId.length === 0 || nodeId.length > 128) {
      ws.close(CLOSE.BAD_HELLO, 'nodeId must be a non-empty string');
      return;
    }
    // A node id is a mailbox address. If another seat already owns it, letting
    // this one claim it would hand it that seat's queued mail — so refuse.
    const owner = stmt.nodeById.get(nodeId);
    if (owner && owner.seat_id !== seat.id) {
      ws.close(CLOSE.NODE_CONFLICT, 'nodeId is already registered to another seat');
      return;
    }

    stmt.upsertNode.run({
      id: nodeId,
      seat_id: seat.id,
      name: typeof hello.nodeName === 'string' ? hello.nodeName.slice(0, 256) : null,
      last_seen: Date.now()
    });

    clearTimeout(timer);
    sockets.set(nodeId, ws);
    authed.set(ws, { nodeId, seatId: seat.id });
    ws.isAlive = true;

    ws.send(JSON.stringify({
      type: 'welcome',
      nodeId,
      seatId: seat.id,
      seatLabel: seat.label,
      serverTs: Date.now()
    }));
    log.info('[relay] node connected', nodeId, `(${seat.label})`);
    flush(nodeId);
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  function start() {
    if (wss) throw new Error('relay already started');
    stmt.purgeOld.run(Date.now() - cfg.retentionMs);

    wss = new WebSocketServer({ host: cfg.host, port: cfg.port, maxPayload: cfg.maxPayload });
    wss.on('error', (err) => log.error('[relay] server error', (err && err.message) || err));

    // Bind is asynchronous. Resolving on 'listening' rather than on return is
    // what makes port() meaningful immediately after await — with port 0 the
    // real port is only known once the OS has handed one over.
    const ready = new Promise((resolve, reject) => {
      const onOk = () => { cleanup(); resolve(); };
      const onErr = (err) => { cleanup(); reject(err); };
      const cleanup = () => { wss.off('listening', onOk); wss.off('error', onErr); };
      wss.once('listening', onOk);
      wss.once('error', onErr);
    });
    wss.on('listening', () => log.info('[relay] listening on', cfg.host, port()));

    wss.on('connection', (ws) => {
      ws.isAlive = false;
      const timer = setTimeout(() => {
        if (!authed.has(ws)) ws.close(CLOSE.AUTH_TIMEOUT, 'no hello in time');
      }, cfg.authTimeoutMs);

      ws.on('pong', () => { ws.isAlive = true; });

      ws.on('message', (buf) => {
        let msg;
        try { msg = JSON.parse(buf.toString()); } catch {
          ws.close(CLOSE.PROTOCOL, 'not JSON');
          return;
        }
        const ctx = authed.get(ws);
        if (!ctx) {
          if (msg && msg.type === 'hello') handshake(ws, msg, timer);
          else ws.close(CLOSE.BAD_HELLO, 'first message must be hello');
          return;
        }

        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          return;
        }
        if (msg.type !== 'send') return;

        const checked = validateEnvelope(msg.envelope, ctx.nodeId);
        if (!checked.ok) {
          ws.send(JSON.stringify({ type: 'error', code: checked.code, message: checked.error }));
          return;
        }
        // Re-check the seat on every message: revocation is issued by a
        // separate CLI process, so the sweep interval alone would leave a
        // window in which a revoked machine keeps posting.
        const seat = stmt.seatRevoked.get(ctx.seatId);
        if (!seat || seat.revoked_at) {
          ws.close(CLOSE.SEAT_REVOKED, 'seat revoked');
          return;
        }
        stmt.touchNode.run(Date.now(), ctx.nodeId);
        const targets = route(checked.value);
        ws.send(JSON.stringify({ type: 'ack', id: checked.value.id, targets: targets.length }));
      });

      ws.on('close', () => {
        clearTimeout(timer);
        const ctx = authed.get(ws);
        authed.delete(ws);
        if (ctx) {
          if (sockets.get(ctx.nodeId) === ws) sockets.delete(ctx.nodeId);
          inflight.delete(ctx.nodeId);
        }
      });
      ws.on('error', () => { /* the close handler does the cleanup */ });
    });

    heartbeatTimer = setInterval(() => {
      for (const ws of wss.clients) {
        if (ws.isAlive === false) { ws.terminate(); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch { /* racing close */ }
      }
    }, cfg.heartbeatMs);
    heartbeatTimer.unref?.();

    sweepTimer = setInterval(() => {
      for (const [nodeId, ws] of sockets) {
        const ctx = authed.get(ws);
        if (!ctx) continue;
        const seat = stmt.seatRevoked.get(ctx.seatId);
        if (!seat || seat.revoked_at) {
          log.info('[relay] dropping revoked seat', ctx.seatId, 'node', nodeId);
          ws.close(CLOSE.SEAT_REVOKED, 'seat revoked');
        }
      }
    }, cfg.revocationSweepMs);
    sweepTimer.unref?.();

    return ready.then(() => api);
  }

  async function stop() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (sweepTimer) clearInterval(sweepTimer);
    heartbeatTimer = sweepTimer = null;
    const server = wss;
    wss = null;
    if (!server) { sockets.clear(); authed.clear(); inflight.clear(); return; }
    for (const ws of [...server.clients]) ws.terminate();
    await new Promise((resolve) => server.close(() => resolve()));
    sockets.clear();
    authed.clear();
    inflight.clear();
  }

  function port() {
    const addr = wss && wss.address();
    return addr && typeof addr === 'object' ? addr.port : cfg.port;
  }

  const api = { start, stop, port, flush, route, stats: () => stmt.stats.get(), closeCodes: CLOSE };
  return api;
}

module.exports = { createRelay, CLOSE, DEFAULTS };
