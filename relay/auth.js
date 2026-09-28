'use strict';

/**
 * Seat credentials.
 *
 * A seat token is the ONLY thing that authenticates a machine to the relay.
 * There are no accounts, no emails, no provider keys — the operator mints a
 * token, hands it to a machine once, and the relay stores only its hash.
 * Revoking the seat kills that machine's access without touching the others.
 */

const crypto = require('node:crypto');

/** Human-recognisable prefix so a leaked token is grep-able as ours. */
const TOKEN_PREFIX = 'mdr_';

/** 256 bits of CSPRNG output — the whole security model rests on this. */
function newSeatToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
}

/** SHA-256 hex. Unsalted on purpose (see db.js): the token is not a password. */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/** Constant-time string compare. Length is not secret; a mismatch there can
 *  return early, everything else must not. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** A fresh seat row plus the plaintext token that mints it. The token is the
 *  one value that must be shown to the operator and then dropped — everything
 *  downstream (server, CLI, database) only ever sees `token_hash`. */
function newSeat(label) {
  const token = newSeatToken();
  return {
    id: `seat_${crypto.randomBytes(8).toString('hex')}`,
    label: String(label),
    token_hash: hashToken(token),
    token
  };
}

module.exports = { TOKEN_PREFIX, newSeatToken, hashToken, safeEqual, newSeat };
