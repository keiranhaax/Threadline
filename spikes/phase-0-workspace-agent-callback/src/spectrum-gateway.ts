// The single gateway-owned Spectrum connection for the live gate.
//
// Reconciled architectural constraint: EXACTLY ONE live Spectrum client owns the
// Photon line for BOTH inbound and outbound. The MCP callback never opens a
// second connection; it only enqueues into the outbox this worker drains.
//
// Verified Photon facts (2026-08-10): outbound send is via the SDK (space.send /
// message.reply); there is no public HTTP send endpoint. Inbound is via the
// message stream (app.messages) or signed webhooks. The exact idempotency
// behavior of the chosen send path is the last live unknown — see PHASE-0.md,
// assumption P-SEND-IDEMPOTENCY.
//
// Requires `spectrum-ts` (pinned) and live Photon credentials; used only in the
// live gate. The offline suite does not import this module.

import { SpikeStore, type DeliveryState } from "./store.ts";

export interface SpectrumGatewayDeps {
  store: SpikeStore;
  projectId: string;
  projectSecret: string;
  /** Resolve an opaque destination_ref to the live Spectrum Space to send on. */
  resolveSpace: (destinationRef: string) => Promise<SpectrumSpaceLike>;
}

/** Structural type so this compiles without importing spectrum-ts here. */
export interface SpectrumSpaceLike {
  send: (text: string, opts?: { clientMessageId?: string }) => Promise<{ id?: string }>;
}

/**
 * Drain one pending outbox row and send it exactly once *logically*. Physical
 * exactly-once is NOT promised: if the process dies after the provider accepts
 * but before we record success, the row is left `uncertain` and MUST NOT be
 * blind-retried. This encodes the reconciled delivery guarantee.
 */
export async function deliverPending(
  deps: SpectrumGatewayDeps,
  replyId: string,
): Promise<DeliveryState> {
  const outbox = deps.store.getOutbox(replyId);
  if (!outbox) return "failed";
  if (outbox.delivery_state !== "pending") return outbox.delivery_state as DeliveryState;

  const destinationRef = outbox.destination_ref as string;
  const clientMessageId = outbox.client_message_id as string;
  const text = outbox.text as string;

  // Mark in-flight so a crash leaves an auditable `uncertain`, not a silent gap.
  deps.store.setDeliveryState(replyId, "uncertain", undefined, "send in-flight");
  try {
    const space = await deps.resolveSpace(destinationRef);
    // If the selected send path exposes a client idempotency key, pass it. If it
    // does NOT (to be confirmed live), delivery stays `uncertain` on ambiguous
    // outcomes rather than being retried.
    const sent = await space.send(text, { clientMessageId });
    deps.store.setDeliveryState(replyId, "sent", sent?.id, undefined);
    return "sent";
  } catch (err) {
    // Transport error BEFORE provider accept is safe to mark failed (no send).
    // We cannot always distinguish; conservative default is `uncertain`.
    const msg = err instanceof Error ? err.message : String(err);
    deps.store.setDeliveryState(replyId, "uncertain", undefined, msg);
    return "uncertain";
  }
}
