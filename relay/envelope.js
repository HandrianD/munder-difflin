'use strict';

/**
 * The envelope — the only thing the relay ever carries.
 *
 *   { id, fromNode, fromAgent, toAgent|broadcast, kind, payload, ts }
 *
 * The relay is a postbox, not a participant: it validates shape, refuses a
 * sender claiming someone else's node, and routes. It never inspects `payload`
 * — that is the HiveMessage, and it belongs to the machines, not to the relay.
 * Provider keys never reach this process at all.
 */

/** The ONLY kinds allowed to cross machines — plan 001, Track B:
 *  "only whitelisted kinds cross machines (ask, reply, result, board.update).
 *   No shell payloads, no fs primitives, no skill code — the relay is a
 *   mailbox, not an RPC bus."
 *
 * A closed set on purpose: an open-ended `kind` would let a compromised seat
 * invent new protocol messages later. Everything else stays local to a machine. */
const ENVELOPE_KINDS = new Set(['ask', 'reply', 'result', 'board.update']);

/** Cap on the serialized payload. A HiveMessage is a few KB; a megabyte is
 *  already absurd, and unbounded payloads are how a queue becomes a DoS. */
const MAX_PAYLOAD_BYTES = 1024 * 1024;

const MAX_ID_LENGTH = 128;
const MAX_AGENT_LENGTH = 256;

function isPlainString(v, max) {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

function isStringOrNull(v, max) {
  return v === null || (typeof v === 'string' && v.length <= max);
}

/**
 * Validate an envelope claimed by `authenticatedNode`.
 *
 * @param {unknown} raw        decoded JSON from the socket
 * @param {string} authenticatedNode the node id this socket proved it owns
 * @returns {{ok: true, value: object} | {ok: false, code: string, error: string}}
 */
function validateEnvelope(raw, authenticatedNode) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'bad-envelope', error: 'envelope must be an object' };
  }
  const e = /** @type {Record<string, unknown>} */ (raw);

  if (!isPlainString(e.id, MAX_ID_LENGTH)) {
    return { ok: false, code: 'bad-envelope', error: 'id must be a non-empty string' };
  }
  if (!isPlainString(e.fromAgent, MAX_AGENT_LENGTH)) {
    return { ok: false, code: 'bad-envelope', error: 'fromAgent must be a non-empty string' };
  }
  // The forgery guard: a socket may only speak for the node it authenticated as.
  if (e.fromNode !== authenticatedNode) {
    return { ok: false, code: 'not-your-node', error: 'fromNode does not match the authenticated node' };
  }
  // `toAgent === null` is the broadcast form. An empty string is neither.
  if (!isStringOrNull(e.toAgent, MAX_AGENT_LENGTH) || e.toAgent === '') {
    return { ok: false, code: 'bad-envelope', error: 'toAgent must be a string or null' };
  }
  if (typeof e.kind !== 'string' || !ENVELOPE_KINDS.has(e.kind)) {
    return { ok: false, code: 'unknown-kind', error: `kind must be one of ${[...ENVELOPE_KINDS].join(', ')}` };
  }
  if (!Number.isFinite(e.ts) || Number(e.ts) <= 0) {
    return { ok: false, code: 'bad-envelope', error: 'ts must be a positive timestamp' };
  }

  let payload;
  try {
    payload = JSON.stringify(e.payload === undefined ? null : e.payload);
  } catch {
    return { ok: false, code: 'bad-envelope', error: 'payload is not JSON-serializable' };
  }
  if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
    return { ok: false, code: 'payload-too-large', error: 'payload exceeds 1 MiB' };
  }

  return {
    ok: true,
    value: {
      id: e.id,
      fromNode: authenticatedNode,
      fromAgent: e.fromAgent,
      toAgent: e.toAgent === null ? null : e.toAgent,
      kind: e.kind,
      payload: JSON.parse(payload),
      ts: Number(e.ts)
    }
  };
}

module.exports = { ENVELOPE_KINDS, MAX_PAYLOAD_BYTES, validateEnvelope };
