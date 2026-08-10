# Phase 0 operator checklist (live gate)

These steps require ChatGPT/Photon UI actions and test credentials that a hosted
agent cannot perform. Run them on a machine with the repo checked out. Use
**test/staging** resources only. Record every result verbatim in
`../../docs/PHASE-0.md` → Test matrix, keeping trigger, run, callback,
logical-reply, and delivery states **separate**.

Do NOT: provision a paid Photon dedicated line, change workspace admin settings
beyond enabling the feature for your own test workspace, or run against a line
anyone but you can see — without explicit owner approval.

## G0 — Prerequisites (record versions in PHASE-0.md)

- [ ] Node ≥ 22.5 (spike tested on the version in `.nvmrc`/CI); `npm install`; `npm test` → 17 passing.
- [ ] A ChatGPT **Business or Enterprise** workspace where an admin has enabled
      Workspace Agents and "Allow users to create personal access tokens."
- [ ] A Photon **test** project (app.photon.codes) with a **test** line/space that
      only you can see. Record `space.phone` — literal `shared` vs an E.164 number
      tells you shared-pool vs dedicated (do not upgrade to dedicated without approval).

## G1 — Photon round-trip on ONE gateway-owned Spectrum client

- [ ] Start one process that owns the Spectrum connection; send yourself a test
      iMessage and confirm inbound arrives; reply via `space.send` and confirm receipt.
- [ ] Confirm no second Spectrum client is opened anywhere (MCP must not send).
- [ ] EXIT: inbound + outbound both work through a single client. Record line mode.

## G2 — Publish a test Workspace Agent with an API channel

- [ ] Create/publish a minimal agent. Instruction: "When triggered, call
      `submit_reply` exactly once with the `reply_capability` from your input and a
      short acknowledgement. You cannot choose a destination."
- [ ] Add an **API channel**; record the `agtch_…` id.
- [ ] Admin → Access tokens → create a **Workspace Agents**-scoped token. Put both
      in `.env` (never commit). Confirm the token owner can run the agent (else 403).

## G3 — Attach the one-tool MCP via Secure MCP Tunnel (THE unknown — A10/OA-TUNNEL-WA)

- [ ] Start the spike MCP server locally (`mcp-server.ts`, bound to 127.0.0.1).
- [ ] Install/run the OpenAI `tunnel-client`; create a `tunnel_id`; point it at the
      local MCP port; provide a runtime API key with Tunnels Read+Use.
- [ ] In the agent builder, attach the custom MCP over the tunnel.
- [ ] **CRITICAL:** confirm the builder actually accepts a tunneled custom MCP for a
      Workspace Agent. Official docs do NOT state the tunnel supports the
      workspace-agent trigger path — this step is the go/no-go gate. If the tunnel
      cannot be attached, record the exact failure and try the documented fallback
      (public HTTPS + OAuth 2.1) before concluding NO-GO on transport.

## G4 — Closed-loop trigger

- [ ] Gateway mints a capability, stores `hash → (event, session, destination)`.
- [ ] POST trigger with: opaque `conversation_key`, stable `Idempotency-Key` (=
      inbound message id), `OpenAI-Beta: workspace_agent_runs=v1`, input carrying the
      capability secret and NO destination.
- [ ] Confirm `202` + `conversation_url`; capture `agent_trigger_run_id`.
- [ ] Confirm the agent authenticates to and calls `submit_reply`.
- [ ] Confirm exactly one logical reply accepted; gateway resolves destination from
      state; reply reaches the SAME iMessage conversation.

## G5 — Failure and idempotency matrix (record each separately)

- [ ] Re-trigger with the SAME `Idempotency-Key` → no second run queued.
- [ ] Two messages sharing one `conversation_key` (serialize per session).
- [ ] Rotated `conversation_key` → fresh conversation.
- [ ] Concurrent same-key messages → observe ordering/interleave.
- [ ] Duplicate `submit_reply` calls → one logical reply, second = `already_accepted`.
- [ ] Invalid / expired / cross-session capability → rejected.
- [ ] Agent completes WITHOUT calling `submit_reply` → observable missing-callback.
- [ ] Tunnel down during callback → no unsafe retry; observable failure.
- [ ] Approval-gated (non-destructive) tool → observe `suspended`; confirm whether
      any API resume exists (expected: none — document).
- [ ] Send-path idempotency: since `spectrum-ts` `space.send` exposes NO client id
      (confirmed), decide/test whether to use low-level `@photon-ai/advanced-imessage`
      (`clientMessageId`) for physical dedup, or retain `uncertain` on ambiguity.
- [ ] Crash injection before/after: trigger accept, outbox insert, Spectrum send.

## G6 — Hosted capability probes (record availability per capability)

- [ ] Web access; read-only GitHub PR inspection; one configured skill; small
      PDF/.docx generation; whether a generated artifact can be transferred via an
      explicit attachment callback (do NOT build a broad attachment system to pass this
      — record the missing boundary if unsupported).

## Recording rule

A received iMessage alone is NOT sufficient evidence. For every trigger, record
the tuple: **trigger state → run state → callback state → logical-reply state →
Photon-delivery state**.
