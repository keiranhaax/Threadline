// Reply-capability minting and verification for the Phase 0 feasibility spike.
//
// A reply capability is the ONLY handle the triggered Workspace Agent receives
// that lets it deliver a reply. It carries no destination authority: the model
// never sees a phone number, Photon space, or backend address. The gateway binds
// the capability, server-side, to (inbound_event, session, photon_conversation)
// at mint time. `submit_reply` accepts only the opaque capability string + text.
//
// Security properties (reconciled from both audits):
//   - >= 128 bits of randomness (we use 256 bits).
//   - Single purpose, single logical acceptance, expiring.
//   - Only the SHA-256 hash is persisted; the plaintext lives only in the
//     trigger input and is never written to disk or logs.
//
// Pure Node stdlib so it runs and tests offline with no dependencies.

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/** Bytes of entropy in a capability secret. 32 bytes = 256 bits (>= 128 required). */
export const CAPABILITY_ENTROPY_BYTES = 32;

/** Default capability lifetime. A reply must be accepted within this window. */
export const DEFAULT_CAPABILITY_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface MintedCapability {
  /** Opaque secret handed to the trigger input (base64url). NEVER persisted. */
  readonly secret: string;
  /** SHA-256 hex of the secret. Persisted; used for lookup + verification. */
  readonly hash: string;
}

/** base64url-encode without padding (URL/JSON safe, no `=`/`+`/`/`). */
function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Hash a capability secret. Constant across calls; safe to store. */
export function hashCapability(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Mint a fresh high-entropy capability. Returns the plaintext + its hash. */
export function mintCapability(): MintedCapability {
  const secret = b64url(randomBytes(CAPABILITY_ENTROPY_BYTES));
  return { secret, hash: hashCapability(secret) };
}

/**
 * Constant-time comparison of a presented secret against a stored hash.
 * Avoids leaking hash-prefix information through early-exit timing.
 */
export function capabilityMatchesHash(presentedSecret: string, storedHash: string): boolean {
  const presentedHash = Buffer.from(hashCapability(presentedSecret), "hex");
  const stored = Buffer.from(storedHash, "hex");
  if (presentedHash.length !== stored.length) return false;
  return timingSafeEqual(presentedHash, stored);
}

/** Basic shape validation for a presented capability before any DB work. */
export function looksLikeCapability(value: unknown): value is string {
  // base64url of 32 bytes is 43 chars. Accept a small range to allow future
  // entropy changes, but reject anything obviously malformed to fail fast.
  return typeof value === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(value);
}
