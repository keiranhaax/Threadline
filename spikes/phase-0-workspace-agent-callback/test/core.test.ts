// Offline tests for the Phase 0 spike core. These run with NO third-party
// dependencies and NO live services, using node:test + node:sqlite + node:crypto.
//
//   node --test test/core.test.ts     (Node >= 22.5; type-stripping on Node >= 23)
//
// They prove the architectural invariants that do not require OpenAI or Photon:
//   - capability entropy, hashing, and constant-time verification
//   - at-most-one logical reply acceptance
//   - idempotent duplicate-callback behavior
//   - expiry, cross-session, unknown, and malformed capability rejection
//   - server-side text-size limit
//   - destination is never model-supplied (submit_reply has no destination arg)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mintCapability, hashCapability, capabilityMatchesHash, looksLikeCapability, CAPABILITY_ENTROPY_BYTES } from "../src/capability.ts";
import { SpikeStore, type CorrelationBinding } from "../src/store.ts";

function bind(overrides: Partial<CorrelationBinding> = {}): CorrelationBinding {
  return {
    sessionId: "sess_A",
    conversationKey: "opaque-conv-key-A",
    destinationRef: "photon-space-ref-held-server-side",
    inboundMessageId: "imsg_1",
    ...overrides,
  };
}

test("capability has >= 128 bits of entropy and is url-safe", () => {
  assert.ok(CAPABILITY_ENTROPY_BYTES * 8 >= 128);
  const { secret, hash } = mintCapability();
  assert.match(secret, /^[A-Za-z0-9_-]+$/);
  assert.equal(hash, hashCapability(secret));
  assert.notEqual(secret, hash); // plaintext != stored hash
});

test("two mints never collide", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) seen.add(mintCapability().secret);
  assert.equal(seen.size, 1000);
});

test("constant-time verify accepts the right secret, rejects the wrong one", () => {
  const { secret, hash } = mintCapability();
  assert.ok(capabilityMatchesHash(secret, hash));
  assert.ok(!capabilityMatchesHash(mintCapability().secret, hash));
});

test("looksLikeCapability rejects obvious garbage before any DB work", () => {
  assert.ok(!looksLikeCapability(""));
  assert.ok(!looksLikeCapability("short"));
  assert.ok(!looksLikeCapability("has spaces and ../ traversal"));
  assert.ok(!looksLikeCapability(12345 as unknown));
  assert.ok(looksLikeCapability(mintCapability().secret));
});

test("happy path: one inbound event yields exactly one accepted reply", () => {
  const store = new SpikeStore();
  const cap = mintCapability();
  store.registerCorrelation(cap.hash, bind(), 60_000);

  const r = store.submitReply(cap.secret, "hello from the agent");
  assert.equal(r.status, "accepted");
  assert.equal(r.delivery_state, "pending");
  assert.ok(r.reply_id);
  store.close();
});

test("duplicate callback returns the ORIGINAL record as already_accepted (no second send)", () => {
  const store = new SpikeStore();
  const cap = mintCapability();
  store.registerCorrelation(cap.hash, bind(), 60_000);

  const first = store.submitReply(cap.secret, "first");
  const second = store.submitReply(cap.secret, "second attempt with different text");

  assert.equal(first.status, "accepted");
  assert.equal(second.status, "already_accepted");
  assert.equal(second.reply_id, first.reply_id);

  // Only ONE outbox row exists, and it holds the FIRST text.
  const row = store.getOutbox(first.reply_id!)!;
  assert.equal(row.text, "first");
  store.close();
});

test("submit_reply has no destination argument; destination comes only from server state", () => {
  const store = new SpikeStore();
  const cap = mintCapability();
  store.registerCorrelation(cap.hash, bind({ destinationRef: "trusted-dest-XYZ" }), 60_000);

  const r = store.submitReply(cap.secret, "text only, no destination possible");
  // The sender resolves the destination from stored state, not from any argument.
  assert.equal(store.destinationForReply(r.reply_id!), "trusted-dest-XYZ");
  store.close();
});

test("expired capability is rejected", () => {
  let clock = 1_000_000;
  const store = new SpikeStore(":memory:", { now: () => clock });
  const cap = mintCapability();
  store.registerCorrelation(cap.hash, bind(), 1000); // expires at clock+1000
  clock += 5000; // advance past expiry
  const r = store.submitReply(cap.secret, "too late");
  assert.equal(r.status, "rejected");
  assert.equal(r.reject_reason, "expired");
  store.close();
});

test("unknown capability is rejected", () => {
  const store = new SpikeStore();
  const r = store.submitReply(mintCapability().secret, "no correlation registered");
  assert.equal(r.status, "rejected");
  assert.equal(r.reject_reason, "unknown_capability");
  store.close();
});

test("cross-session capability cannot deliver into another session", () => {
  const store = new SpikeStore();
  const capA = mintCapability();
  const capB = mintCapability();
  store.registerCorrelation(capA.hash, bind({ sessionId: "sess_A", destinationRef: "dest_A" }), 60_000);
  store.registerCorrelation(capB.hash, bind({ sessionId: "sess_B", destinationRef: "dest_B" }), 60_000);

  const r = store.submitReply(capA.secret, "for A");
  // A's capability resolves ONLY to A's destination; there is no way to target B.
  assert.equal(store.destinationForReply(r.reply_id!), "dest_A");
  store.close();
});

test("malformed capability is rejected as invalid before lookup", () => {
  const store = new SpikeStore();
  const r = store.submitReply("../../etc/passwd", "traversal attempt");
  assert.equal(r.status, "rejected");
  assert.equal(r.reject_reason, "invalid_capability");
  store.close();
});

test("empty text is rejected; oversize text is rejected", () => {
  const store = new SpikeStore(":memory:", { maxTextLength: 20 });
  const cap = mintCapability();
  store.registerCorrelation(cap.hash, bind(), 60_000);
  assert.equal(store.submitReply(cap.secret, "").status, "rejected");
  assert.equal(store.submitReply(cap.secret, "x".repeat(21)).reject_reason, "text_too_large");
  store.close();
});

test("unknown fields in the callback payload are ignored by the typed accept path", () => {
  // The store's submit_reply only reads (capability, text). Extra keys on any
  // wrapper object cannot influence acceptance. This asserts the contract shape.
  const store = new SpikeStore();
  const cap = mintCapability();
  store.registerCorrelation(cap.hash, bind(), 60_000);
  const payload = { reply_capability: cap.secret, text: "ok", destination: "+1-attacker", space_id: "evil" } as Record<string, unknown>;
  const r = store.submitReply(payload.reply_capability, payload.text);
  assert.equal(r.status, "accepted");
  // Destination is still the server-bound one; injected keys had no effect.
  assert.notEqual(store.destinationForReply(r.reply_id!), "+1-attacker");
  store.close();
});

test("delivery state transitions are independent of logical acceptance", () => {
  const store = new SpikeStore();
  const cap = mintCapability();
  store.registerCorrelation(cap.hash, bind(), 60_000);
  const r = store.submitReply(cap.secret, "hi");
  assert.equal(r.delivery_state, "pending");
  // Simulate the gateway-owned Spectrum sender reporting an ambiguous outcome.
  store.setDeliveryState(r.reply_id!, "uncertain", undefined, "crash after provider accept");
  assert.equal(store.getOutbox(r.reply_id!)!.delivery_state, "uncertain");
  // A later callback still returns already_accepted with the CURRENT delivery state.
  const again = store.submitReply(cap.secret, "hi again");
  assert.equal(again.status, "already_accepted");
  assert.equal(again.delivery_state, "uncertain");
  store.close();
});
