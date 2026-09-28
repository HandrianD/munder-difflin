# Plan 001 — Workspace sidebar + Tailscale Teams, in one release

Fork: `HandrianD/munder-difflin` (upstream `chaitanyagiri/munder-difflin`, tag `v0.5.3` / `package.json` 0.4.6).
Local checkout: `F:\Munder Muffin`, branch `work`, baseline commit `cd8e9e5`.
Push target: `fork/work` (branch `work`). Never force-push. `fork/main` stays as the plain upstream import.

## Why this fork

- MIT code (`LICENSE`), pixel art under `LICENSE-ASSETS` (LimeZu credit required via
  `src/renderer/src/assets/ATTRIBUTION.md` — must ship with every build).
- Public source contains **no sign-in or paywall code** — `src/` and
  `i18n/locales/en.json` have no signIn/email/Pro/Stapler strings. The login wall in the
  official installer comes from a private build tree; nothing to rip out, only outbound
  phone-home to disable.
- Pro features are (A) a sidebar workspace — Agents, Tasks, Inbox, Automations, Memory,
  Capabilities, Temps — and (B) Teams multi-machine sync. The public code already ships
  the building blocks for both; this plan re-hosts them as first-class screens and adds a
  self-hosted Tailscale relay.

## Current-state map (verified in this checkout)

| Want | Already exists at |
| --- | --- |
| Tasks screen | `src/renderer/src/components/TasksKanban.tsx`, `CommandCenterPanel.tsx:323` |
| Inbox / human screen | `AskMeTab.tsx`, `CommandCenterPanel.tsx:324` |
| Automations screen | `TriggersTab.tsx` + `TriggerHistoryTab.tsx`, `CommandCenterPanel.tsx:325-326` |
| Memory screen | `MemoryPanel.tsx` + `MemoryGraphPanel.tsx`, `CommandCenterPanel.tsx:327,330` |
| Capabilities screen | `SkillsTab.tsx`, `CommandCenterPanel.tsx:338` |
| Agents screen | `ThreadsPanel.tsx`, `AgentStrip`, `store.ts:41` `Agent` |
| Temps screen | `WorkersTab.tsx` + `src/main/workerLaunch.ts`, `hireQueue.ts`, `palaceReap.ts` (god-triggered ephemeral workers already work) |
| Shell to hang screens off | `App.tsx:401-477` (OfficeFloor + `SidebarSplitter` + `AgentDetailPanel` + `AgentStrip`), `SidebarTab` at `store.ts:162` |
| Cross-agent message transport | `src/main/hive.ts` — single-committer git repo at `<harnessHome>/hive` (`hive.ts:4-17`), `HiveManager.deliver()` `hive.ts:1541` writes atomic JSON to `agents/<id>/inbox/`, `board.md` single-writer blackboard (`HIVE.md:159`), god prompt `hive.ts:1487` |
| Secret storage | `src/main/integrations.ts:82-106` — Electron `safeStorage`, fails closed (reuse for seat token) |
| Dictation / voice | `src/main/freeflow.ts` + `src/renderer/src/freeflow/` (Groq Whisper), `src/main/realtime.ts` — already free, no Stapler work needed |
| Webhook API | `src/main/webhook.ts:244` `server.listen(this.port)` → binds 0.0.0.0, secret-gated |
| i18n | `i18n/locales/en.json`, `ar.json`, `zh-CN.json` — every new string goes in all three |

## P0 — hardening (do first, no feature work on an unforked tree)

Outbound callers to neutralize:

1. `src/main/updater.ts:47` — `const REPO = 'chaitanyagiri/munder-difflin'`. Point at the
   fork or short-circuit the check so a private build never pulls upstream binaries.
2. `src/main/modelCatalog.ts:19` — `CATALOG_URL` off `raw.githubusercontent.com`.
   Ship the catalog inline / local file; keep the fetch as an optional refresh.
3. `src/main/hero.ts:16` — same host, `docs/hero.json`. Inline it.
4. `src/main/webhook.ts:244` — `server.listen(this.port, cb)` →
   `server.listen(this.port, '127.0.0.1', cb)`. Relay/trigger traffic goes over Tailscale,
   not a LAN-wide bind.
5. Drop `tunnelmole` / `localtunnel` from `package.json` (public tunneling is the opposite
   of "private build"); remove the code paths that shell out to them.
6. PostHog: `src/main/analytics.ts` is a no-op without `POSTHOG_KEY` in the build env —
   just never set it; add a guard so it cannot be enabled by accident.
7. Rebrand leftovers: `README.md`/`RELEASE.md` badges and download links point at the
   upstream repo (they also still say 0.5.3 / 0.4.6 inconsistently). Leave the upstream
   attribution text intact, but no build of ours should link to upstream releases.
8. Keep `LICENSE`, `LICENSE-ASSETS`, `src/renderer/src/assets/ATTRIBUTION.md` untouched.

Verify: `npm ci && npm run typecheck && npm run dev`, plus a grep gate
(`grep -r "chaitanyagiri/munder-difflin" src/` → only `ATTRIBUTION`/legal mentions) and a
`netstat`-style check that the webhook port is `127.0.0.1` after boot.

## Track A — Workspace sidebar

Goal: one toggle in the app chrome switching between the pixel office floor ("Classic")
and a Pro-style workspace shell. No gate, no seat check — it is a UI mode, not a tier.

1. `src/renderer/src/store/config.ts` — add `uiMode: 'floor' | 'workspace'` to
   `HarnessConfig` (persisted, `config:update` IPC already exists at `src/main/index.ts`).
2. New `src/renderer/src/components/workspace/WorkspaceShell.tsx` — left nav with the
   seven screens, right content pane. Reuse existing panels as-is first
   (`TasksKanban`, `AskMeTab`, `TriggersTab`, `TriggerHistoryTab`, `MemoryPanel`,
   `MemoryGraphPanel`, `SkillsTab`, `WorkersTab`, `ThreadsPanel`); no rewrites in this
   milestone.
3. `App.tsx:401-477` — wrap the existing layout in a `uiMode` switch; add a control to the
   existing settings/top bar. Floor mode must be byte-identical to today's behavior.
4. Screens wiring that needs real work:
   - **Agents**: list from `store` agents, open `AgentDetailPanel` in place of the floor.
   - **Temps**: surface `workers:list` / `hireQueue` state — hired, queued, reaped — instead
     of only the god-trigger view.
   - **Inbox**: `AskMeTab` already renders asks; make the badge count drive the nav item.
5. `SidebarTab` (`store.ts:162`) stays as-is — workspace nav is separate state so the
   existing right-hand sidebar (terminal/messages/traces/git) is untouched.
6. i18n: add nav labels to `en.json`, `ar.json`, `zh-CN.json`.

Exit criteria: toggle works, all seven screens render from live IPC data, floor mode
regression-free (`npm run typecheck`, manual click-through).

### Status — Track A

Built on `work` in `8921d08` (shell, `uiMode` wiring, i18n) plus the hire-queue
section on the Temps screen. All six items above are done:

- `uiMode` lives in all three `HarnessConfig` declarations (`store/config.ts`,
  `main/config.ts`, `preload/index.ts`) so Settings writes and `config:update`
  round-trip without one of them dropping the field.
- `App.tsx` switches on it as a **sibling** of the floor block, not a wrapper
  around it — floor mode renders byte-identical markup, which is what the
  "regression-free" half of the exit criteria actually needs.
- `MemoryTab` is exported rather than copied, so the Memory screen and the
  Command Center's memory tab are one implementation.
- `useRestoreTeam` is mounted in the shell as well as `AgentStrip`. The floor
  strip is hidden while the shell is up, and the hook's boot auto-restore is
  driven from whichever component is mounted — without this the restore would
  have silently stopped firing at startup.

Not yet done: the manual click-through. `npm run typecheck`, `npm run build` and
the full suite are green (849/821/17/11 — the 17 are the pre-existing symlink
and worktree environment failures), but nothing here has been eyeballed running.

## Track B — Teams over Tailscale

Model: **join codes, not accounts.** The relay never sees provider keys; it only routes
message envelopes.

### Security posture (decided)

- Transport security = Tailscale WireGuard. No DIY X25519 sealing, no TLS cert management.
- Seat credential = single opaque **seat token**, issued by the relay operator (you),
  stored client-side via the existing `safeStorage` path (`integrations.ts:82-106`),
  sent once per handshake, **stored hashed on the relay**. Revoking a seat invalidates it
  without touching other machines.
- Relay listens on `127.0.0.1` and is exposed to the tailnet with
  `tailscale serve` (or run it as a tailnet service on a Tailscale IP).
  Nothing is reachable off-tailnet even if the bind is wrong.

### Architecture

```
Machine A (harness)  <--ws-->  relay (localhost + tailscale serve)  <--ws-->  Machine B (harness)
   hive/ (single committer)                                              hive/ (single committer)
```

- **New `relay/`** — Node + `ws` + SQLite: tables `seats`, `nodes`, `messages`.
  `relay/cli.js` for `seat create|revoke`, `node register`. Envelope =
  `{id, fromNode, fromAgent, toAgent|broadcast, kind, payload, ts}`.
- **New `src/main/relayClient.ts`** — outbound `ws` client (add `ws` to `package.json`;
  it is not a dependency today). Connects, authenticates with seat token, heartbeats,
  buffers offline while disconnected.
- **Integration seam: `hive.ts:1541` `deliver()`** — after the local write, mirror the
  envelope to the relay. Inbound: relay → `deliver()` into the local inbox dir, **plus**
  a local git commit so hive history stays append-only and single-committer per machine.
- **Do NOT git-sync the hive.** Two committers on one repo breaks the contract
  (`hive.ts:4-17`, `HIVE.md:159`). The relay carries messages only; each machine's hive
  git remains single-writer.
- **Capability scoping**: only whitelisted kinds cross machines (`ask`, `reply`,
  `result`, `board.update`). No shell payloads, no `fs` primitives, no skill code —
  the relay is a mailbox, not an RPC bus.

### Status — Track B, step 1 (relay + CLI) done

`relay/` is built and tested: `db.js`, `auth.js`, `envelope.js`, `server.js`,
`cli.js`, `README.md`, with `test/relay.test.cjs` (24 tests) covering handshake,
forgery, offline buffering, broadcast fan-out, dedupe, revocation and the CLI as
a subprocess. `ws` and `@types/ws` were added to `package.json`.

Three decisions worth recording:

- **Storage is `node:sqlite`, not better-sqlite3.** The app's copy is compiled
  for the Electron ABI (`NODE_MODULE_VERSION 128`) and will not load in the
  plain Node process the relay runs as. `node:sqlite` is built into Node 24, so
  the relay still adds exactly one dependency (`ws`). Requires Node 24+; Node 22
  needs `--experimental-sqlite`.
- **No `node register` subcommand.** A machine registers itself on handshake,
  authenticated by its seat — an unauthenticated pre-registration command would
  be a second, weaker path into `nodes`. The CLI has `node list`.
- **Routing fans out to every live machine except the sender**, for targeted and
  broadcast envelopes alike. The relay does not carry the roster, so it cannot
  be used to enumerate who is in the hive; the receiver's `deliver()` no-ops
  where the inbox does not exist. Delivery is at-least-once and the receiver is
  idempotent (HiveMessage id = inbox filename).

### Status — Track B, steps 2–4 (client, seam, wiring) done

Built and tested on top of the relay:

- **`src/main/relayIdentity.ts`** — seat token in `safeStorage` behind its own
  file (`relay-seat-token.json`, atomic tmp+rename, fail-closed when the OS keychain
  is unavailable), plus a stable mailbox address (`node-<16 hex>`) at
  `relay-node.json`. Mirrors the audited pattern in `integrations.ts:82-156`.
- **`src/main/relayClient.ts`** — one connection with a durable, ack-gated
  outbox (`relay-outbox.json`, cap 5000), reconnect on
  `[1s,2s,5s,10s,20s,30s]` ± 25% jitter, 25s heartbeat with a 2× silence
  kill, and a 10s hello timeout. Fatal close codes (4002–4005) park the client
  in `rejected` with no retry. Exports `RELAY_ENVELOPE_KINDS` and
  `envelopeKindForAct()`.
- **The seam in `src/main/hive.ts`** — after `routeMessage`, any target with
  no local inbox is handed to the relay mirror, plus one envelope per
  broadcast (`toAgent: null`). Inbound mail enters through `receiveRemote()`,
  which marks the id foreign-origin so it is never echoed back to its own
  sender. Declining the mirror falls through to the original drop+bounce.
- **`src/main/relayRuntime.ts`** — the reconcile loop. `sync(cfg)` is
  idempotent: an unrelated settings save does not tear down a healthy socket;
  only a URL/token change does. Boot, config-write and quit call it; status is
  pushed to the renderer as `relay:status`.

Two design decisions worth recording:

- **Cross-machine send is "mirror remote targets", not the plan's literal
  `deliver()` mirror.** Local routing is untouched; only undeliverable-local
  targets cross the relay. No roster replication, so the relay still cannot
  enumerate the hive.
- **Error frames carry the envelope id.** A refusal names exactly the envelope
  it rejects, so a poison message can be dropped without stalling the outbox;
  unattributable refusals report `null` rather than a guess.

### Status — Track B, step 5a (join code + Team screen) done

- **`src/shared/relayCode.ts`** — the join code: `mdr1.` + base64url JSON
  carrying only `{url, token}`. Pure (no Buffer, no DOM) so main, renderer and
  `node --test` all run the same code. Version-marked so a code from a later
  format fails as `unknownPrefix` instead of half-parsing; whitespace is
  stripped because people paste codes out of wrapped terminals; every field is
  validated on the way out (`ws(s)://` only, `mdr_ + 64 hex`).
  Documented plainly as a bearer credential — encoding is not secrecy.
- **Two IPC handlers** in `src/main/index.ts`: `relay:joinCode` mints a code
  only from this machine's own URL and stored token, and `relay:applyJoinCode`
  stores the token *first* so the config write that follows — which fires the
  listener that reconciles the runtime — always sees a complete pair. Both
  reachable through the preload as `relayJoinCode` / `relayApplyJoinCode`.
- **An eighth screen, `team`**, in the workspace shell: live status chip with a
  retry affordance on a refused seat, this machine's node identity, URL + seat
  token fields (token write-only, masked, never seeded from config), and the
  invite/join panels. New `team.*` and `workspace.nav.team` strings in
  en/ar/zh.
- **`test/relay-code.test.cjs`** (8) round-trips, wraps, and fails each field
  independently, with Buffer as an independent base64url oracle.
  **`test/workspace-team.test.cjs`** (6) keeps the nav union, the nav entries
  and the locale key trees in step, asserts every IPC error has a translated
  line, and pins the write-only property of the seat token.

### Status — Track B, step 5b (DM archive + Inbox) done

- **`src/main/remoteThreads.ts`** — a durable archive at
  `<hive>/dm/<node>/<peer>/<messageId>.json`, plus `src/shared/remoteDm.ts`
  for the shapes. Separate from the inbox on purpose: an agent drains
  `inbox/` into `.done/`, so the inbox is a queue of what is still owed,
  while a conversation with another machine has to still be readable after
  BOTH sides have handled everything in it.
- **Two hooks in `hive.ts`**: `receiveRemote` archives before routing (so mail
  addressed to an id this machine lacks is not lost with it), and the
  no-local-inbox mirror site archives what actually left. Local mail is never
  archived — it never crossed anything.
- **The key is `node:peer`.** Inbound mail knows its node from the envelope;
  outbound does not, because the relay fans out to every machine, so the node
  is recovered from where that peer's mail has come from and falls back to
  `unknown` rather than being guessed onto a machine that may host a
  different copy of the same agent id.
- **`hive:remoteDms`** over the bridge; `RemoteDmsPanel` sits at the top of the
  Track A Inbox screen with a per-thread unread badge, and the shell's nav
  badge counts questions owed here plus unread remote mail.
- **Replying uses the ordinary `hiveSend` path** — there is no "remote send";
  mail with no local recipient is what the seam already picks up. What matters
  is the SENDING id: it must be a real local agent id, because the other
  machine resolves `human`/`god` to ITS orchestrator and a reply would end
  there instead of coming back over the wire.

`test/remote-dms.test.cjs` (15) covers the archive and both hooks;
`test/remote-dms-ui.test.cjs` (8) covers the badge bookkeeping, the bridge and
the locale keys.

Still to do for Track B: `Agent.remote?`/`node?` badges, file attachments,
then the two-machine end-to-end pass with a seat-revoke check.

### Teams UI (reuses Track A shell)

1. **Invite**: settings screen shows a join code (relay + seat token encoded); other
   machine pastes it once.
2. **Remote agents**: `Agent` interface (`store.ts:41`) gains `remote?: boolean` /
   `node?: string`; remote agents appear read-only-ish on the floor/workspace with a
   distinct badge. Same for `AgentDetailPanel` (no terminal attach initially — message
   only).
3. **DMs**: new store slice for conversations keyed by `nodeId:agentId`; badge feeds the
   Track A Inbox screen.
4. **Files**: v1 = payload attachments routed by the relay with a size cap, stored under
   the local workspace; no sync engine.

### Config

`HarnessConfig` gains `relay: { enabled, url, seatToken? }` (token written via
`safeStorage`, never stored in the plain JSON config).

## Sequencing

| # | Step | Depends on |
| --- | --- | --- |
| 1 | Plan file (this file) + register in `plans/README.md` | — |
| 2 | `work` branch + baseline commit, push to `fork/work` | 1 |
| 3 | P0 hardening + `npm ci/typecheck/dev` verify | 2 |
| 4 | Track A: config `uiMode` → `WorkspaceShell` → screen wiring → i18n | 3 |
| 5 | Track B: relay server + seat CLI → `relayClient` → `deliver()` seam → UI | 4 |
| 6 | End-to-end: two machines, tailnet only, seat revoke test | 5 |

Roughly 3–4 weeks of part-time work; steps 3 and 4 are independently shippable, step 5
is the one that makes it "Teams".

## Non-goals

- No circumvention of any third-party service's terms — BYO keys and local models only
  (the harness is explicitly built for that).
- No reimplementation of Stapler billing/dictation — dictation is already free in-tree.
- No multi-committer hive git, no relay-side model/key custody, no public internet exposure.

## Open questions

- Relay persistence: SQLite file (chosen) vs. Postgres — revisit only if seat count > 10.
- Should remote agents be visible on the pixel floor or workspace-only? Floor rendering
  needs a decision before Track B UI work.
- Whether `fork/main` ever receives sync commits from upstream (probably: merge upstream
  into `main` periodically, rebase `work` on top).
