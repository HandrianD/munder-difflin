#!/usr/bin/env node
'use strict';

/**
 * Relay operator CLI — everything the person running the relay does by hand.
 *
 *   node relay/cli.js serve               start the WebSocket relay
 *   node relay/cli.js seat create <label> mint a seat token (printed once)
 *   node relay/cli.js seat list           show seats and their state
 *   node relay/cli.js seat revoke <id|label>
 *   node relay/cli.js node list           machines seen, and when
 *   node relay/cli.js stats               queue depth / seat counts
 *
 * Tokens are printed exactly once, at mint time, and never stored anywhere in
 * plaintext — the database keeps only the SHA-256. Losing a token means
 * minting a new seat; there is no recovery path, which is the point.
 *
 * `--db <path>` on every command, or MD_RELAY_DB in the environment.
 * Default database: relay/relay.db (gitignored — it holds credentials' hashes
 * and message history, neither of which belongs in a public fork).
 */

const path = require('node:path');
const { openDb } = require('./db');
const { newSeat } = require('./auth');
const { createRelay, DEFAULTS } = require('./server');

const DEFAULT_DB = path.join(__dirname, 'relay.db');

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

const USAGE = `relay — a seat-token message relay for machines on a tailnet

  node relay/cli.js serve [--host 127.0.0.1] [--port 8787]
  node relay/cli.js seat create <label>
  node relay/cli.js seat list
  node relay/cli.js seat revoke <seat-id | label>
  node relay/cli.js node list
  node relay/cli.js stats

Every command accepts --db <path> (default ${DEFAULT_DB}),
or set MD_RELAY_DB.

The relay must be reachable only from your tailnet. Bind to 127.0.0.1 and use
\`tailscale serve\` to expose it, which is the default posture for a reason:
nothing here authenticates anyone except the seat token.
`;

function fmtTime(ms) {
  return ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '—';
}

function table(rows, columns) {
  if (rows.length === 0) return console.log('  (none)');
  const widths = columns.map((c) => Math.max(c.h.length, ...rows.map((r) => String(c.get(r) ?? '').length)));
  console.log('  ' + columns.map((c, i) => c.h.padEnd(widths[i])).join('  '));
  console.log('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) {
    console.log('  ' + columns.map((c, i) => String(c.get(r) ?? '').padEnd(widths[i])).join('  '));
  }
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0];

  if (!command || flags.help || command === 'help') {
    console.log(USAGE);
    // `--help` is a request, not a failure; a bare invocation with no command is.
    process.exit(flags.help || command === 'help' ? 0 : 1);
  }

  const dbFile = flags.db || process.env.MD_RELAY_DB || DEFAULT_DB;

  if (command === 'serve') {
    const db = openDb(dbFile);
    const relay = createRelay({
      db,
      host: flags.host || DEFAULTS.host,
      port: flags.port === undefined ? DEFAULTS.port : Number(flags.port),
      logger: console
    });
    await relay.start();
    console.log(`[relay] database ${dbFile}`);
    const bye = () => { relay.stop().then(() => { db.close(); process.exit(0); }); };
    process.on('SIGINT', bye);
    process.on('SIGTERM', bye);
    return;
  }

  const db = openDb(dbFile);
  try {
    switch (command) {
      case 'init':
        console.log(`initialized ${dbFile}`);
        break;

      case 'seat': {
        const sub = positional[1];
        if (!sub) throw new Error('usage: seat create <label> | seat list | seat revoke <seat-id | label>');
        if (sub === 'create') {
          const label = positional[2];
          if (!label) throw new Error('usage: seat create <label>');
          const seat = newSeat(label);
          db.prepare('INSERT INTO seats (id, label, token_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)')
            .run(seat.id, seat.label, seat.token_hash, Date.now());
          console.log('seat created');
          console.log(`  id     ${seat.id}`);
          console.log(`  label  ${seat.label}`);
          console.log(`  hash   ${seat.token_hash}`);
          console.log('');
          console.log('  TOKEN (shown once — hand it to the machine, then forget it):');
          console.log(`  ${seat.token}`);
          break;
        }
        if (sub === 'list') {
          const rows = db.prepare('SELECT id, label, token_hash, created_at, revoked_at FROM seats ORDER BY created_at').all();
          table(rows, [
            { h: 'ID', get: (r) => r.id },
            { h: 'LABEL', get: (r) => r.label },
            { h: 'CREATED', get: (r) => fmtTime(r.created_at) },
            { h: 'STATE', get: (r) => (r.revoked_at ? `revoked ${fmtTime(r.revoked_at)}` : 'live') },
            { h: 'TOKEN HASH', get: (r) => r.token_hash.slice(0, 16) + '…' }
          ]);
          break;
        }
        if (sub === 'revoke') {
          const key = positional[2];
          if (!key) throw new Error('usage: seat revoke <seat-id | label>');
          const seat = db.prepare('SELECT id FROM seats WHERE id = ? OR label = ?').get(key, key);
          if (!seat) throw new Error(`no seat matches "${key}"`);
          // Only the seat is revoked — the machines it owns keep their rows so
          // their queued mail stays inspectable, they just stop receiving.
          const info = db.prepare('UPDATE seats SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
            .run(Date.now(), seat.id);
          console.log(info.changes ? `revoked ${seat.id}` : `${seat.id} was already revoked`);
          break;
        }
        throw new Error(`unknown seat subcommand "${sub}"`);
      }

      case 'node': {
        const sub = positional[1];
        if (sub !== 'list') throw new Error('usage: node list');
        const rows = db.prepare(`
          SELECT n.id, n.name, n.last_seen, s.label, s.revoked_at
          FROM nodes n JOIN seats s ON s.id = n.seat_id
          ORDER BY n.last_seen DESC
        `).all();
        table(rows, [
          { h: 'NODE', get: (r) => r.id },
          { h: 'NAME', get: (r) => r.name || '' },
          { h: 'SEAT', get: (r) => r.label },
          { h: 'LAST SEEN', get: (r) => fmtTime(r.last_seen) },
          { h: 'STATE', get: (r) => (r.revoked_at ? 'seat revoked' : 'live') }
        ]);
        break;
      }

      case 'stats': {
        const s = db.prepare(`
          SELECT
            (SELECT count(*) FROM seats WHERE revoked_at IS NULL)      AS live_seats,
            (SELECT count(*) FROM seats)                               AS total_seats,
            (SELECT count(*) FROM nodes)                               AS nodes,
            (SELECT count(*) FROM messages WHERE delivered_at IS NULL) AS queued,
            (SELECT count(*) FROM messages)                            AS total
        `).get();
        console.log(`database       ${dbFile}`);
        console.log(`seats          ${s.live_seats} live / ${s.total_seats} total`);
        console.log(`nodes seen     ${s.nodes}`);
        console.log(`envelopes      ${s.queued} queued / ${s.total} total`);
        break;
      }

      default:
        console.error(`unknown command "${command}"\n`);
        console.log(USAGE);
        process.exit(1);
    }
  } finally {
    db.close();
  }
}

// Only run when invoked as a program: `require('./cli.js')` from a test must
// not start parsing argv or opening databases.
if (require.main === module) {
  main().catch((err) => {
    console.error(`relay: ${err.message || err}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, fmtTime, table };
