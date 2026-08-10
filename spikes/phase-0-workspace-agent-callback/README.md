# Phase 0 feasibility spike — Workspace Agent callback

Deliberately small, isolated harness that tests Threadline's single architectural
uncertainty:

> Can an **API-triggered published Workspace Agent** reliably call a **private
> `submit_reply` MCP tool** that causes a **correctly bound reply** to reach the
> owner's iMessage conversation — with the model holding **no destination
> authority** and **at most one logical reply** accepted server-side?

This is a spike, **not** the production gateway. It does not start the gateway,
host bridges, local-PC integration, Codex runtime, or `/vps` / `/local` routing.

## Layout

```
src/
  capability.ts        # mint/hash/verify high-entropy one-time reply capabilities
  store.ts             # SQLite correlations + reply outbox; at-most-one acceptance
  types.ts             # strict zod boundary schema for submit_reply
  config.ts            # env loading + live-gate status (no secrets in repo)
  trigger-client.ts    # LIVE: Workspace Agent trigger + beta run poll
  mcp-server.ts        # LIVE: one-tool submit_reply MCP server (HTTP-fronted)
  spectrum-gateway.ts  # LIVE: single gateway-owned Spectrum send worker
test/
  core.test.ts         # offline, dependency-free: invariants (14 tests)
  mcp_tool.test.ts     # offline: submit_reply through the real MCP SDK (3 tests)
```

## Offline vs live

- **Offline core** (`capability.ts`, `store.ts`) imports **only** Node stdlib
  (`node:crypto`, `node:sqlite`). Its tests run with **no install and no network**.
- **Live modules** (`trigger-client.ts`, `mcp-server.ts`, `spectrum-gateway.ts`)
  need the pinned deps and **test/staging credentials**. They are exercised only
  during the live gate, following `../../docs/PHASE-0.md` and `OPERATOR-CHECKLIST.md`.

## Run

```bash
npm install          # pinned; commits package-lock.json
npm run typecheck    # tsc --noEmit over all modules (incl. live)
npm test             # node --test  -> 17 passing (offline)
```

## Guarantees this spike encodes

- **Logical exactly-once:** at most one reply accepted per correlation; duplicate
  callbacks return the original record. Physical iMessage exactly-once is **not**
  promised (see `../../docs/PHASE-0.md` → delivery semantics).
- **No model destination authority:** `submit_reply(reply_capability, text)` has
  no destination/space/backend argument; the send target is resolved solely from
  server-held state bound at mint time.
- **Capabilities:** ≥256-bit random, single-use, expiring, stored **hashed** only.

See `../../docs/PHASE-0.md` for the full record, assumptions table, test matrix,
operator steps, and go/no-go status.
