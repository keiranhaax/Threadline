// Durable state for the Phase 0 spike: correlations (reply capabilities bound to
// an inbound event / session / conversation) and the reply outbox.
//
// Uses node:sqlite (Node >= 22.5, stable-ish experimental) so the spike's core
// runs and tests entirely offline with no third-party dependency. WAL mode,
// foreign keys, and a busy timeout follow the codex audit's SQLite guidance.
//
// This store enforces the two invariants that DO NOT depend on any live service:
//   1. At most ONE logical reply is accepted per correlation (server-side,
//      atomic, never trusting the model to call once).
//   2. Duplicate callbacks return the ORIGINAL accepted reply record.
//
// Physical delivery (Spectrum send) is a SEPARATE state machine (see outbox
// delivery_state) and is deliberately NOT proven here — it is a live gate.

import { DatabaseSync } from "node:sqlite";
import { hashCapability, capabilityMatchesHash, looksLikeCapability } from "./capability.ts";

export type ReplyStatus = "accepted" | "already_accepted" | "rejected";
export type DeliveryState = "pending" | "sent" | "failed" | "uncertain" | "expired";
export type RejectReason =
  | "invalid_capability"
  | "unknown_capability"
  | "expired"
  | "text_too_large"
  | "policy_denied";

export interface SubmitReplyResult {
  reply_id: string | null;
  status: ReplyStatus;
  delivery_state: DeliveryState | null;
  reject_reason?: RejectReason;
}

export interface CorrelationBinding {
  /** Opaque session id (never a raw Photon identifier). */
  sessionId: string;
  /** Opaque conversation key sent to the Workspace Agent as conversation_key. */
  conversationKey: string;
  /** Server-held destination handle. NEVER exposed to the model. */
  destinationRef: string;
  /** Inbound Photon message id that triggered this correlation. */
  inboundMessageId: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS correlations (
  capability_hash   TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  conversation_key  TEXT NOT NULL,
  destination_ref   TEXT NOT NULL,     -- trusted server state; not model-supplied
  inbound_message_id TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  consumed_at       INTEGER,           -- set when a reply is accepted (one-shot)
  reply_id          TEXT               -- FK-ish to reply_outbox.reply_id
);
CREATE TABLE IF NOT EXISTS reply_outbox (
  reply_id          TEXT PRIMARY KEY,
  capability_hash   TEXT NOT NULL UNIQUE,   -- at most one reply per correlation
  destination_ref   TEXT NOT NULL,          -- copied from correlation, immutable
  text              TEXT NOT NULL,
  delivery_state    TEXT NOT NULL,          -- pending|sent|failed|uncertain|expired
  client_message_id TEXT NOT NULL,          -- outbound idempotency key for Photon
  provider_message_id TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_error        TEXT,
  FOREIGN KEY (capability_hash) REFERENCES correlations(capability_hash)
);
CREATE INDEX IF NOT EXISTS idx_outbox_state ON reply_outbox(delivery_state);
CREATE INDEX IF NOT EXISTS idx_corr_expiry ON correlations(expires_at);
`;

export interface StoreOptions {
  /** Server-side max reply length in characters. */
  maxTextLength?: number;
  /** Injected clock for deterministic tests. */
  now?: () => number;
}

export class SpikeStore {
  private db: DatabaseSync;
  private maxTextLength: number;
  private now: () => number;

  constructor(path = ":memory:", opts: StoreOptions = {}) {
    this.db = new DatabaseSync(path);
    this.maxTextLength = opts.maxTextLength ?? 4000;
    this.now = opts.now ?? Date.now;
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Persist a freshly minted correlation. Stores only the capability HASH. */
  registerCorrelation(capabilityHash: string, binding: CorrelationBinding, ttlMs: number): void {
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO correlations
           (capability_hash, session_id, conversation_key, destination_ref,
            inbound_message_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        capabilityHash,
        binding.sessionId,
        binding.conversationKey,
        binding.destinationRef,
        binding.inboundMessageId,
        t,
        t + ttlMs,
      );
  }

  /**
   * The heart of the spike: accept AT MOST ONE logical reply for a capability.
   *
   * Ordering of checks matters for safety:
   *   1. Shape-validate the presented secret (fail fast, no DB).
   *   2. Enforce server-side text size.
   *   3. Look up the correlation by hash; unknown -> rejected.
   *   4. If already consumed -> return the ORIGINAL reply as already_accepted
   *      (idempotent duplicate-callback behavior; never a second send).
   *   5. If expired -> rejected(expired).
   *   6. Atomically claim the correlation (UPDATE ... WHERE consumed_at IS NULL)
   *      and insert the single outbox row in one transaction. The UNIQUE
   *      constraint on reply_outbox.capability_hash is the final backstop
   *      against a race producing two rows.
   */
  submitReply(presentedSecret: unknown, text: unknown): SubmitReplyResult {
    if (!looksLikeCapability(presentedSecret)) {
      return { reply_id: null, status: "rejected", delivery_state: null, reject_reason: "invalid_capability" };
    }
    if (typeof text !== "string" || text.length === 0) {
      return { reply_id: null, status: "rejected", delivery_state: null, reject_reason: "invalid_capability" };
    }
    if (text.length > this.maxTextLength) {
      return { reply_id: null, status: "rejected", delivery_state: null, reject_reason: "text_too_large" };
    }

    const hash = hashCapability(presentedSecret);
    const corr = this.db
      .prepare(`SELECT * FROM correlations WHERE capability_hash = ?`)
      .get(hash) as Record<string, unknown> | undefined;

    if (!corr) {
      return { reply_id: null, status: "rejected", delivery_state: null, reject_reason: "unknown_capability" };
    }

    // Defense in depth: constant-time confirm (hash lookup already matched, but
    // this guards against any future non-hash keying).
    if (!capabilityMatchesHash(presentedSecret, hash)) {
      return { reply_id: null, status: "rejected", delivery_state: null, reject_reason: "unknown_capability" };
    }

    // Idempotent duplicate callback: return the original accepted record.
    if (corr.consumed_at != null) {
      const existing = this.db
        .prepare(`SELECT reply_id, delivery_state FROM reply_outbox WHERE capability_hash = ?`)
        .get(hash) as { reply_id: string; delivery_state: DeliveryState } | undefined;
      return {
        reply_id: existing?.reply_id ?? (corr.reply_id as string),
        status: "already_accepted",
        delivery_state: existing?.delivery_state ?? "pending",
      };
    }

    const t = this.now();
    if ((corr.expires_at as number) < t) {
      return { reply_id: null, status: "rejected", delivery_state: null, reject_reason: "expired" };
    }

    const replyId = `rpl_${hash.slice(0, 24)}`;
    const clientMessageId = replyId; // stable outbound idempotency key
    const destinationRef = corr.destination_ref as string;

    // Atomic claim + single insert.
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const claim = this.db
        .prepare(
          `UPDATE correlations
             SET consumed_at = ?, reply_id = ?
           WHERE capability_hash = ? AND consumed_at IS NULL`,
        )
        .run(t, replyId, hash);

      if (claim.changes !== 1) {
        // Lost the race; someone else consumed it. Roll back and return the winner.
        this.db.exec("ROLLBACK;");
        const existing = this.db
          .prepare(`SELECT reply_id, delivery_state FROM reply_outbox WHERE capability_hash = ?`)
          .get(hash) as { reply_id: string; delivery_state: DeliveryState } | undefined;
        return {
          reply_id: existing?.reply_id ?? null,
          status: "already_accepted",
          delivery_state: existing?.delivery_state ?? "pending",
        };
      }

      this.db
        .prepare(
          `INSERT INTO reply_outbox
             (reply_id, capability_hash, destination_ref, text, delivery_state,
              client_message_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(replyId, hash, destinationRef, text, clientMessageId, t, t);

      this.db.exec("COMMIT;");
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }

    return { reply_id: replyId, status: "accepted", delivery_state: "pending" };
  }

  /** Read a correlation's stored destination (for the gateway sender only). */
  destinationForReply(replyId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT destination_ref FROM reply_outbox WHERE reply_id = ?`)
      .get(replyId) as { destination_ref: string } | undefined;
    return row?.destination_ref;
  }

  /** Transition an outbox row's delivery state (gateway sender / reconciler). */
  setDeliveryState(replyId: string, state: DeliveryState, providerMessageId?: string, lastError?: string): void {
    this.db
      .prepare(
        `UPDATE reply_outbox
           SET delivery_state = ?, provider_message_id = COALESCE(?, provider_message_id),
               attempts = attempts + 1, updated_at = ?, last_error = ?
         WHERE reply_id = ?`,
      )
      .run(state, providerMessageId ?? null, this.now(), lastError ?? null, replyId);
  }

  getOutbox(replyId: string): Record<string, unknown> | undefined {
    return this.db.prepare(`SELECT * FROM reply_outbox WHERE reply_id = ?`).get(replyId) as
      | Record<string, unknown>
      | undefined;
  }
}
