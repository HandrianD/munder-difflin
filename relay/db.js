'use strict';

/**
 * Relay storage — SQLite through Node's built-in `node:sqlite`.
 *
 * Deliberately NOT better-sqlite3, which the app itself uses: the harness's
 * copy is compiled for the Electron ABI (NODE_MODULE_VERSION 128), so it will
 * not load in the plain Node process the relay runs as. `node:sqlite` is
 * built into the runtime, which also means the relay adds zero dependencies
 * beyond `ws`. Requires Node 24+ (on Node 22 pass --experimental-sqlite).
 *
 * Three tables and nothing else:
 *   seats    — one row per issued credential. THE TOKEN IS NEVER STORED; only
 *              a SHA-256 hash, so a leaked database file cannot be replayed as
 *              a live credential. Seat tokens are 256 bits of CSPRNG output, so
 *              an unsalted hash is not a weakness here — there is no dictionary
 *              to run against it, and a salt would break lookup-by-hash.
 *   nodes    — every machine that has ever completed a handshake. Audit only:
 *              authorization comes from the seat, not from this table. It is
 *              also the fan-out set for delivery, which is what makes mail to
 *              an offline machine survive until it comes back.
 *   messages — the envelope queue. delivered_at IS NULL is the offline buffer;
 *              the row is written before routing, so a crash between persist
 *              and send loses nothing.
 */

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS seats (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS seats_by_token_hash ON seats(token_hash);

CREATE TABLE IF NOT EXISTS nodes (
  id        TEXT PRIMARY KEY,
  seat_id   TEXT NOT NULL,
  name      TEXT,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS nodes_by_seat ON nodes(seat_id);

-- Keyed on (id, to_node): one logical envelope fans out to every machine, so
-- id alone is not unique here. The composite key is what makes a retried
-- envelope a no-op instead of a duplicate row per target.
CREATE TABLE IF NOT EXISTS messages (
  id           TEXT NOT NULL,
  from_node    TEXT NOT NULL,
  from_agent   TEXT NOT NULL,
  to_node      TEXT NOT NULL,
  to_agent     TEXT,
  kind         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  queued_at    INTEGER NOT NULL,
  delivered_at INTEGER,
  PRIMARY KEY (id, to_node)
);
CREATE INDEX IF NOT EXISTS messages_pending ON messages(to_node) WHERE delivered_at IS NULL;
`;

/**
 * `node:sqlite` has no `db.transaction(fn)` helper the way better-sqlite3
 * does, and the fan-out insert must not leave half a broadcast committed.
 */
function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

/**
 * @param {string} file filesystem path to the database, or ':memory:' for tests
 * @returns {import('node:sqlite').DatabaseSync}
 */
function openDb(file) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new DatabaseSync(file);
  // WAL keeps the CLI (seat create) from blocking a running server. NORMAL is
  // the right durability trade for an append-only queue whose rows are
  // rewritten once (delivered_at) and never again.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb, SCHEMA, withTransaction };
