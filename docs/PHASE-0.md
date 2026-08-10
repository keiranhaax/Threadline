# Threadline — Phase 0 feasibility record

**Status:** IN PROGRESS — offline harness complete and passing; **live external
gates BLOCKED** (no OpenAI Business workspace or Photon test credentials available
to the implementation environment).
**Prepared by:** Threadline implementation agent (Phase 0 authorization only).
**Date:** 2026-08-10.
**Branch:** `phase-0/feasibility-spike` (off `main` @ `5da4e831`). No changes to `main`.
**Scope guard:** This authorizes Phase 0 only. The production gateway, host
bridges, local-PC integration, Codex runtime, and `/vps` / `/local` routing were
**not** started.

---

## 0. What Phase 0 must answer

Does Threadline's architectural spine work?

```
iMessage → one gateway-owned Photon/Spectrum connection → Workspace Agent trigger API
→ published hosted Workspace Agent → private Threadline MCP callback → gateway reply
queue → the same Photon conversation
```

Primary question: **can an API-triggered published Workspace Agent reliably call
the private callback MCP and cause a correctly bound reply to reach the owner's
iMessage conversation?** A received iMessage alone is **not** sufficient evidence;
trigger, run, callback, logical-reply, and delivery states are recorded separately.

---

## 1. Sources and versions

All external claims re-verified against **current official documentation** on
2026-08-10. Audit conclusions were treated as hypotheses; official docs, the
installed package interfaces, and (where available) live evidence take precedence.

### OpenAI (official)
- `https://developers.openai.com/workspace-agents/trigger-runs` (`.md` variant fetched; Last-Modified 2026-08-10) — trigger endpoint, 202 + `conversation_url`, `conversation_key`, `Idempotency-Key`, beta run polling.
- `https://developers.openai.com/workspace-agents/authentication` — admin enablement + Workspace Agents access token.
- `https://developers.openai.com/api/docs/guides/secure-mcp-tunnels` (`.md`; Last-Modified 2026-08-10) — Secure MCP Tunnel.
- `https://github.com/openai/tunnel-client` — the tunnel client (outbound-only).
- `learn.chatgpt.com` confirmed a genuine OpenAI docs domain (mirror infra); the codex audit's `learn.chatgpt.com/...` citations are trustworthy, though canonical is `developers.openai.com` (`/codex/app-server` 308-redirects to `/docs/app-server`).

### Photon / Spectrum (official)
- `https://docs.photon.codes` (Mintlify; pages undated) — webhooks, messages, spaces, reactions-and-replies, connection-and-routing.
- `https://docs.photon.codes/webhooks/delivery` — retry/DLQ/ordering contract.
- `https://photon.codes/pricing` — Business dedicated line = **$250/line/mo**.
- npm `spectrum-ts@12.7.0` (published 2026-07-31) and `@photon-ai/advanced-imessage@2.0.2` — send-API type signatures (primary evidence for idempotency).

### Spike toolchain (pinned; `package-lock.json` lockfileVersion 3 committed)
- Node.js ≥ 22.5 (built/tested on 24.14.1); `node:sqlite`, `node:test`, `node:crypto` (stdlib).
- `@modelcontextprotocol/sdk@1.30.0`, `spectrum-ts@12.7.0`, `zod@3.25.76`.
- dev: `typescript@5.9.3`, `@types/node@26.2.0`.

---

## 2. Assumptions table

Statuses: **Confirmed (docs)** · **Confirmed (live prototype)** · **Partially
confirmed** · **Requires prototype** · **Unsupported** · **Incorrect** ·
**Documentation unavailable**. "Live prototype" is used only where this spike's
executing code proved the property in-sandbox; all OpenAI/Photon *service*
behaviors remain offline-unproven (BLOCKED live gate).

| # | Assumption | Status | Evidence / required action |
|---|---|---|---|
| OA-1 | Published Workspace Agents are externally triggerable | **Confirmed (docs)** | `POST {base}/workspace_agents/{agtch_id}/trigger`; base `api.chatgpt.com/v1`. |
| OA-2 | Trigger is async `202` + `conversation_url`; answer not retrievable | **Confirmed (docs)** | Explicit in trigger-runs. Output must arrive via callback/destination. |
| OA-3 | `conversation_key` continues a conversation | **Confirmed (docs)** | Optional, caller-defined. Retention/isolation depth **not** documented → still test. |
| OA-4 | `Idempotency-Key` dedupes trigger retries | **Partially confirmed** | Header documented; **retention window Documentation unavailable**. |
| OA-5 | Completed output retrievable via API | **Incorrect** | Explicitly not retrievable (spine relies on callback — correct). |
| OA-6 | Run-status polling exists | **Partially confirmed (beta)** | `OpenAI-Beta: workspace_agent_runs=v1`; `agent_trigger_run_id` (`apirun_…`); status only. |
| OA-7 | API-triggered runs retain configured apps/skills/MCP/web/approvals | **Requires prototype** | **No official page enumerates capability parity for triggered runs.** Live G6. |
| OA-8 | Per-trigger model/reasoning/personality/plugin override | **Unsupported** | Body is `input` + `conversation_key` only. |
| OA-9 | A custom private MCP is callable by a triggered run | **Requires prototype** | MCP tools supported generally; this exact triggered-agent callback path is undocumented end-to-end. Live G3–G4. **The go/no-go gate.** |
| OA-10 | Secure MCP Tunnel provides outbound-only private MCP connectivity | **Confirmed (docs)** | Real product + OSS `tunnel-client`; needs `tunnel_id`, runtime API key, Tunnels RBAC, running client. |
| OA-TUNNEL-WA | Secure MCP Tunnel supports a **Workspace Agent's** custom MCP (trigger path) | **Documentation unavailable → Requires prototype** | Tunnel doc names ChatGPT (dev-mode apps), Codex, Responses API — **not** Workspace Agents. Prove in G3; fallback = public HTTPS + OAuth 2.1. |
| OA-11 | Suspended runs can be approved/resumed via API | **Documentation unavailable** | Only a `suspended` status row; no resume/approve endpoint. Keep V1 tools non-destructive. |
| OA-12 | Plan/admin prerequisites | **Partially confirmed** | Business/Enterprise + admin enable + personal access tokens. Regional/quota **Documentation unavailable**. |
| OA-MCP-STRICT | The MCP SDK rejects unknown callback fields | **Incorrect (live prototype)** | The high-level `McpServer` validates against the schema **shape** and **strips** unknown keys; `.strict()` is not enforced as a hard reject. Safe here (no destination field exists) but record it; strict *rejection* needs the low-level server API or a raw-args check. |
| PH-1 | Spectrum TS receives inbound with stable message/sender/space IDs | **Confirmed (docs)** | `app.messages` stream + signed webhooks; `message.id`, `sender.id`, `space.id`. |
| PH-2 | Inbound webhooks are HMAC-signed with replay protection | **Confirmed (docs)** | HMAC-SHA256 over raw bytes (`v0:<ts>:<body>`), `webhookSecret`, 5-min window. |
| PH-3 | Webhook delivery: bounded retries, no DLQ | **Confirmed (docs)** | "Up to 6 attempts", "~3.5 min" backoff, "no dead-letter queue today"; at-least-once. |
| PH-4 | Webhook per-space ordering guarantee | **Incorrect (as stated)** | Docs state at-least-once **in-order per project**; "no per-space ordering" was an audit inference. Serialize per session regardless. |
| PH-5 | Photon has **no** public HTTP send endpoint | **Partially confirmed** | True for **Spectrum cloud runtime** (send = SDK/gRPC). **But** the low-level Advanced iMessage **HTTP Proxy** (`imessage-swagger.photon.codes`) exposes `POST /send`. Don't state "no HTTP send" absolutely. |
| PH-6 | Spectrum `space.send`/`reply` expose a client idempotency key | **Incorrect (package evidence)** | `spectrum-ts@12.7.0`: `send(content)` / `reply(content)` only — no `clientMessageId`. Idempotency (`clientMessageId`, `generateIdempotencyKey()`, `duplicateMessage`) lives ONLY in `@photon-ai/advanced-imessage@2.0.2`. |
| PH-7 | Outbound recovery via `sequence`/`catchUp` | **Confirmed (docs)** — scope split | On the low-level SDK stream path. Webhook-only consumers get no cursor → reconcile by listing messages on the space. |
| PH-8 | Existing line mode is determinable | **Confirmed (docs)** | Runtime `space.phone` (`"shared"` vs E.164); dashboard Lines tab; by plan. Dedicated = $250/mo (owner approval needed). |
| PH-9 | Exactly one live Spectrum client per line is required/enforced | **Requires prototype** | One client auto-discovers lines; single-consumer-per-stream documented, but no explicit multi-client-on-a-line rule. |
| SP-CORE | At-most-one logical reply; idempotent duplicate callback; capability binding | **Confirmed (live prototype)** | This spike's `store.ts` + tests (§3) prove it in-sandbox with executing code. |

---

## 3. Test matrix

### 3A. Offline — proven in this environment (17/17 passing)

Run: `npm test` (`node --test`). Core suite imports only Node stdlib; MCP suite
uses the real `@modelcontextprotocol/sdk` in-memory transport.

| Test | Property proven | State exercised |
|---|---|---|
| capability entropy/url-safe | ≥256-bit, hashed, plaintext≠hash | capability |
| 1000 mints no collision | uniqueness | capability |
| constant-time verify | right accepts / wrong rejects | capability |
| garbage rejected pre-DB | fail-fast shape check | callback |
| happy path | one event → one accepted reply | logical-reply=accepted, delivery=pending |
| duplicate callback | returns original; single outbox row; first text kept | logical-reply=already_accepted |
| no destination arg | destination only from server state | routing |
| expired capability | rejected(expired) | callback |
| unknown capability | rejected(unknown) | callback |
| cross-session capability | resolves only to its own destination | routing/isolation |
| malformed capability | rejected(invalid) before lookup | callback |
| empty/oversize text | rejected / text_too_large | callback |
| unknown fields ignored | injected keys have no effect | callback |
| delivery independent of acceptance | uncertain state; later callback = already_accepted+current delivery | delivery vs run |
| MCP: single tool, no destination field | tool schema = {reply_capability, text} | contract |
| MCP: accept + duplicate | accepted then already_accepted via real SDK | callback |
| MCP: smuggled destination no effect | rogue keys stripped; destination stays server-bound | routing/OA-MCP-STRICT |

`npm run typecheck` (tsc 5.9.3, `--noEmit`) passes over **all** modules including
the live trigger client, MCP server, and Spectrum gateway.

### 3B. Live — BLOCKED (operator must run; see `spikes/.../OPERATOR-CHECKLIST.md`)

For each, record the tuple **trigger → run → callback → logical-reply → delivery**.

| Gate | What it proves | Status |
|---|---|---|
| G1 Photon round-trip on one Spectrum client | inbound+outbound, single owner | **BLOCKED — no Photon test creds** |
| G2 Publish agent + API channel + token | trigger prerequisites | **BLOCKED — no Business workspace** |
| G3 Attach one-tool MCP via Secure MCP Tunnel | **OA-9 / OA-TUNNEL-WA — the gate** | **BLOCKED** |
| G4 Closed-loop trigger → submit_reply → bound reply | the spine | **BLOCKED** |
| G5 Idempotency/failure matrix (dup trigger, dup callback, missing/late, expired, tunnel-down, suspended, send-idempotency, crash windows) | operational guarantees | **BLOCKED** |
| G6 Capability probes (web, GitHub read, skill, PDF/docx, artifact transfer) | OA-7 parity | **BLOCKED** |

---

## 4. Exact manual setup steps

See `spikes/phase-0-workspace-agent-callback/OPERATOR-CHECKLIST.md` (G0–G6) and
`.env.example`. Summary of unavoidable UI/credential steps: enable Workspace
Agents + personal access tokens in a **test** Business/Enterprise workspace;
publish a test agent with an API channel; mint a Workspace Agents-scoped token;
create a Photon **test** line/space; install/run the OpenAI `tunnel-client`.

---

## 5. Evidence and sanitized observations

- The spine's async/no-output shape and the `conversation_key` + `Idempotency-Key`
  cornerstones are **confirmed in current docs** and match the design exactly.
- **Secure MCP Tunnel materially reduces the public-endpoint concern** (outbound-only)
  — a real improvement over the earlier "must expose a public MCP" worry — **but its
  applicability to a Workspace Agent trigger run is undocumented** and is now the
  single gating unknown (OA-9 / OA-TUNNEL-WA).
- **Physical exactly-once is not promised.** `spectrum-ts` `space.send` exposes no
  client idempotency key (package-verified); the outbox therefore promises
  **at-most-one logical acceptance** and records `sent | failed | uncertain | expired`,
  never blind-retrying an ambiguous send. Physical dedup, if required, means using
  `@photon-ai/advanced-imessage` (`clientMessageId`) on the send path — to be decided/tested in G5.
- **MCP unknown-field handling is strip-not-reject** (live-proven). Safe because
  `submit_reply` has no destination parameter; recorded as OA-MCP-STRICT.
- The `submit_reply` contract, capability lifecycle, and single-acceptance invariant
  are **proven with executing code** (17 tests), independent of any live service.
- No secrets are committed; `.env` and `*.sqlite` are git-ignored; the only tokens
  in-repo are `replace_me` placeholders in `.env.example`.

---

## 6. Unresolved questions (for the owner / live gate)

1. **OA-9 / OA-TUNNEL-WA:** can a Workspace Agent's builder attach a tunneled custom
   MCP, and will a *triggered* run call it? (If not: fallback public HTTPS + OAuth 2.1,
   or reconsider the hosted brain.) — **the go/no-go gate.**
2. **OA-7:** which configured capabilities (web, apps, skills, custom MCP, approvals)
   actually run during API-triggered runs?
3. **OA-4:** Idempotency-Key retention window.
4. **OA-11:** is any approval satisfiable for a triggered run, or must V1 stay non-destructive? (Working assumption: non-destructive only.)
5. **PH-6 decision:** accept `uncertain` delivery, or adopt low-level `advanced-imessage` for `clientMessageId` physical dedup?
6. **Ingress choice:** Spectrum SDK stream (has `sequence`/`catchUp`) vs signed webhooks (+ reconciliation). Recommendation: **SDK stream as primary** for a one-owner MVP.
7. **Line tier:** is the existing shared-pool assignment sufficient for a single-owner DM, or is a $250/mo dedicated line required? (Owner approval before any purchase.)

---

## 7. Go / No-Go status

**Phase 0 result: BLOCKED (not passed, not failed).**

- **Offline architectural core:** PASS — capability binding, single logical
  acceptance, idempotent duplicate callbacks, and no-model-destination-authority are
  proven with executing, typechecked code and current-doc-verified assumptions.
- **Live spine (OA-9 / G3–G4):** BLOCKED — cannot be exercised without a Business
  workspace + Photon test line. The harness and an exact operator runbook are ready
  so the owner (or a credentialed session) can execute the live gates unchanged.

**Production-MVP planning remains a NO-GO until the live gates pass.** Do not
silently replace the hosted brain if the callback path fails; documented fallbacks
(directly controlled Agents SDK / API runtime, or Codex app-server) require separate
approval.

---

## 8. Recommended plan changes (for later owner approval — repo docs not rewritten)

1. Replace README's "exactly-once replies" with **at-most-one logical acceptance +
   observable delivery states** (`sent | failed | uncertain | expired`).
2. State that the **gateway-owned Spectrum client is the sole sender**; the MCP only
   validates and enqueues into the outbox (resolves README↔PLAN inconsistency).
3. Record **Secure MCP Tunnel** as the intended private-callback transport, gated on
   the OA-TUNNEL-WA prototype; fallback public HTTPS + OAuth 2.1.
4. Separate **runtime** (`/work`, later Codex) from **tool scope** (`/vps`, `/local`);
   do not implement them in Phase 0.
5. Remove `get_thread` from V1; keep `submit_reply(reply_capability, text)` only.
6. Move secrets, rate limits, audit, backup, and recovery into the foundation phase.
7. Prefer the **Spectrum SDK stream** as primary ingress for the one-owner MVP.

---

## Appendix — repository state

- Initial: `main` @ `5da4e8314fcc75561815578fad326b5662e96215`; tree = `README.md`,
  `docs/PLAN.md` (blobs `a5bab1a5…`, `3aee2761…`). Local Mac clone
  `/Users/widismini/Threadline` is not reachable from the implementation
  environment; all work is on the `phase-0/feasibility-spike` branch via the GitHub API.
- This branch adds only: `docs/PHASE-0.md`, `spikes/phase-0-workspace-agent-callback/**`,
  and a single link line in `README.md`. `docs/PLAN.md` is unchanged.
