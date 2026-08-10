// One-tool private MCP callback server for the live gate: submit_reply.
//
// This is the exact surface the triggered Workspace Agent is expected to call.
// It does NOT own a Spectrum connection and it does NOT send anything itself —
// it validates the capability and ENQUEUES a single logical reply into the
// gateway-owned outbox (SpikeStore). The gateway's Spectrum worker performs the
// actual send in a separate process/state machine.
//
// The tool schema deliberately exposes ONLY (reply_capability, text). There is
// no destination/space/backend argument, so the model can never choose where a
// reply goes. Unknown fields are rejected by the strict Zod schema.
//
// Transport: served over HTTP so it can be fronted by the Secure MCP Tunnel
// client (outbound-only). Requires `@modelcontextprotocol/sdk` (pinned) and a
// running tunnel; used only during the live gate.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { SubmitReplyInput } from "./types.ts";
import { SpikeStore } from "./store.ts";

export interface McpServerDeps {
  store: SpikeStore;
  port: number;
  /** Shared secret the tunnel/relay presents; checked on every request. */
  callbackAuthToken: string;
}

export function buildMcpServer(store: SpikeStore): McpServer {
  const server = new McpServer({ name: "threadline-callback", version: "0.0.1" });

  server.registerTool(
    "submit_reply",
    {
      title: "Submit the reply for the current Threadline message",
      description:
        "Deliver your reply to the user. Call this exactly once with the reply_capability " +
        "from your input and the reply text. You cannot choose a destination; the reply is " +
        "routed by the server to the originating conversation.",
      inputSchema: SubmitReplyInput.shape,
    },
    async (args: unknown) => {
      // Strict parse: rejects unknown fields (no destination smuggling).
      const parsed = SubmitReplyInput.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "rejected", reject_reason: "invalid_capability" }) }],
          isError: true,
        };
      }
      const result = store.submitReply(parsed.data.reply_capability, parsed.data.text);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  return server;
}

/** Start the HTTP-fronted MCP server. Auth is checked before the MCP handshake. */
export async function startMcpHttpServer(deps: McpServerDeps): Promise<() => Promise<void>> {
  const mcp = buildMcpServer(deps.store);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await mcp.connect(transport);

  const http = createServer((reqHttp, resHttp) => {
    // Minimal bearer check for the callback edge. The Secure MCP Tunnel provides
    // the outbound-only path; this token authenticates the caller in addition.
    const auth = reqHttp.headers["authorization"];
    if (auth !== `Bearer ${deps.callbackAuthToken}`) {
      resHttp.writeHead(401).end("unauthorized");
      return;
    }
    transport.handleRequest(reqHttp, resHttp).catch(() => {
      if (!resHttp.headersSent) resHttp.writeHead(500).end("error");
    });
  });

  await new Promise<void>((resolve) => http.listen(deps.port, "127.0.0.1", resolve));
  return async () => {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  };
}
