// Shared boundary schemas for the spike. Zod is the single canonical validator
// (per codex audit §14). At every trust boundary we PARSE and REJECT UNKNOWN
// KEYS with `.strict()` so an injected `destination`/`space_id` field cannot
// ride along in a callback payload.
//
// NOTE: this module imports `zod`, a pinned dependency. It is used by the live
// MCP server (mcp-server.ts). The offline core (capability.ts/store.ts) has no
// third-party imports so it tests without an install.

import { z } from "zod";

/** Inbound callback contract exposed to the triggered Workspace Agent. */
export const SubmitReplyInput = z
  .object({
    reply_capability: z.string().min(40).max(64),
    text: z.string().min(1).max(4000),
  })
  .strict(); // reject unknown fields (no destination/space/backend smuggling)

export type SubmitReplyInput = z.infer<typeof SubmitReplyInput>;

/** Result returned to the agent. Delivery is separate from acceptance. */
export const SubmitReplyOutput = z.object({
  reply_id: z.string().nullable(),
  status: z.enum(["accepted", "already_accepted", "rejected"]),
  delivery_state: z.enum(["pending", "sent", "failed", "uncertain", "expired"]).nullable(),
  reject_reason: z
    .enum(["invalid_capability", "unknown_capability", "expired", "text_too_large", "policy_denied"])
    .optional(),
});

export type SubmitReplyOutput = z.infer<typeof SubmitReplyOutput>;
