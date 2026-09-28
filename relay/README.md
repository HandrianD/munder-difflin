# Relay

A seat-token message relay that lets two or more harness machines on the same
tailnet exchange hive envelopes. It is **not** a git sync, not a chat server, and
not an account system — it is a postbox.

```
Machine A (harness)  <--ws-->  relay (localhost + tailscale serve)  <--ws-->  Machine B (harness)
   hive/ (single committer)                                              hive/ (single committer)
```

## Security posture

- **Transport = Tailscale WireGuard.** There is no TLS in this process and none
  is wanted. The relay binds `127.0.0.1` and is exposed to the tailnet with
  `tailscale serve`, so nothing is reachable off-tailnet even if the bind is
  wrong.
- **Credential = one opaque seat token per machine.** Minted by you, shown once,
  stored on the machine with `safeStorage`. The relay keeps only a SHA-256 hash,
  so a leaked `relay.db` cannot be replayed. Revoking a seat cuts that machine
  off without touching the others.
- **The relay never sees provider keys** and never reads `payload` — it validates
  envelope shape, refuses a sender claiming someone else's node id, and routes.
- **Do NOT git-sync the hive.** Two committers on one repo breaks the contract
  (see `HIVE.md`). Each machine's `hive/` git stays single-writer; only messages
  cross the wire.

## Requirements

- Node **24+** (uses the built-in `node:sqlite`; on Node 22 pass
  `--experimental-sqlite`).
- `ws` — the only dependency, already in the app's `package.json`.
- A tailnet, with the relay host and the clients in it.

## Quick start

```bash
# 1. Mint a seat for each machine. The token prints once — paste it straight
#    into that machine's config and forget it.
node relay/cli.js seat create laptop
node relay/cli.js seat create desktop

# 2. Run the relay on the machine that will host it.
node relay/cli.js serve --host 127.0.0.1 --port 8787

# 3. Expose it to the tailnet only.
tailscale serve --bg --https=443 http://127.0.0.1:8787
```

Database defaults to `relay/relay.db` (gitignored — it holds credential hashes
and message history). Override with `--db <path>` on any command, or
`MD_RELAY_DB`.

## Commands

| Command | Effect |
| --- | --- |
| `serve [--host] [--port]` | run the WebSocket relay |
| `seat create <label>` | mint a seat token (printed once) |
| `seat list` | seats, creation time, live/revoked state |
| `seat revoke <seat-id \| label>` | cut a machine off; its queued mail stays, it just stops receiving |
| `node list` | machines seen and when they last checked in |
| `stats` | seat counts and queue depth |

## Protocol

Client → relay:

| Message | Meaning |
| --- | --- |
| `{type:'hello', token, nodeId, nodeName}` | authenticate; must be first |
| `{type:'send', envelope}` | hand over an envelope |
| `{type:'ping'}` | liveness |

Relay → client:

| Message | Meaning |
| --- | --- |
| `{type:'welcome', nodeId, seatId, seatLabel, serverTs}` | accepted |
| `{type:'ack', id, targets}` | persisted to `targets` machines |
| `{type:'deliver', envelope}` | mail for you (may repeat — at-least-once) |
| `{type:'error', code, message}` | envelope refused, socket stays open |
| `{type:'pong', ts}` | liveness |

Close codes: `4000` protocol, `4001` no hello in time, `4002` malformed hello,
`4003` no live seat, `4004` node id owned by another seat, `4005` seat revoked.

## Envelope

```jsonc
{
  "id":        "env-…",       // unique; the queue keys on (id, to_node)
  "fromNode":  "node-a",      // must match the socket's authenticated node
  "fromAgent": "god",
  "toAgent":   "worker-1",    // null = broadcast
  "kind":      "ask",  // one of ask | reply | result | board.update
  "payload":   { … },         // the HiveMessage; opaque to the relay
  "ts":        1730000000000
}
```

The relay does **not** know which machine hosts which agent. Both a targeted
envelope and a broadcast fan out to every live machine except the sender; each
receiver applies `deliver()`, which no-ops where the inbox does not exist.
Keeping the roster off the relay is deliberate — it means the relay cannot be
used to enumerate the hive.

## Delivery guarantees

At-least-once. A row is marked `delivered_at` only once `ws.send` acknowledges
the write, so a socket that dies mid-flight leaves it queued for the next
connect. The receiving side is idempotent: the HiveMessage id is the inbox
filename, so a duplicate is an overwrite rather than a second message.

## Status

This directory is the relay server and its CLI (plan 001, Track B step 1). Not
yet wired to the app:

- `src/main/relayClient.ts` — the outbound client (connect, authenticate,
  heartbeat, buffer while offline).
- the `deliver()` seam in `src/main/hive.ts` — mirror outbound envelopes, and
  feed inbound ones into the local inbox plus a hive commit.
- the Teams UI.
