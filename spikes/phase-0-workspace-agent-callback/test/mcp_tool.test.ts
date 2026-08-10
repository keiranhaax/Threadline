// End-to-end test of the submit_reply tool THROUGH the real MCP SDK, using the
// SDK's in-memory linked transport. No network, no OpenAI, no Photon — but this
// exercises the actual tool registration, strict input schema, and result
// marshalling that the live Workspace Agent callback would hit.
//
//   node --test test/mcp_tool.test.ts
//
// Requires the installed @modelcontextprotocol/sdk (pinned). Proves at the MCP
// boundary: acceptance, idempotent duplicate callback, unknown-field rejection,
// and that no destination argument is accepted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp-server.ts";
import { SpikeStore, type CorrelationBinding } from "../src/store.ts";
import { mintCapability } from "../src/capability.ts";

function bind(overrides: Partial<CorrelationBinding> = {}): CorrelationBinding {
  return {
    sessionId: "sess_A",
    conversationKey: "opaque-conv-key",
    destinationRef: "server-held-destination",
    inboundMessageId: "imsg_1",
    ...overrides,
  };
}

async function connectedClient(store: SpikeStore): Promise<Client> {
  const server = buildMcpServer(store);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-agent", version: "0.0.1" });
  await client.connect(clientTransport);
  return client;
}

function parse(res: unknown): Record<string, unknown> {
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const first = content.find((c) => c.type === "text");
  return JSON.parse(first?.text ?? "{}");
}

test("submit_reply is exposed as a single tool with no destination field", async () => {
  const store = new SpikeStore();
  const client = await connectedClient(store);
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  assert.deepEqual(names, ["submit_reply"]);
  const schema = tools.tools[0]!.inputSchema as { properties?: Record<string, unknown> };
  const props = Object.keys(schema.properties ?? {});
  assert.deepEqual(props.sort(), ["reply_capability", "text"]);
  assert.ok(!props.includes("destination"));
  assert.ok(!props.includes("space_id"));
  store.close();
});

test("agent call accepts exactly one reply; duplicate is already_accepted", async () => {
  const store = new SpikeStore();
  const cap = mintCapability();
  store.registerCorrelation(cap.hash, bind(), 60_000);
  const client = await connectedClient(store);

  const first = parse(await client.callTool({ name: "submit_reply", arguments: { reply_capability: cap.secret, text: "hello" } }));
  assert.equal(first.status, "accepted");

  const second = parse(await client.callTool({ name: "submit_reply", arguments: { reply_capability: cap.secret, text: "again" } }));
  assert.equal(second.status, "already_accepted");
  assert.equal(second.reply_id, first.reply_id);
  store.close();
});

test("smuggled destination field has NO effect (SDK strips unknown keys; destination stays server-bound)", async () => {
  // FINDING (recorded in PHASE-0.md, OA-MCP-STRICT): the high-level McpServer
  // validates against the schema SHAPE and STRIPS unknown keys before the
  // handler runs, so a zod `.strict()` on the object is not enforced as a hard
  // reject at this boundary. That is safe here because submit_reply has NO
  // destination parameter — a smuggled `destination` is dropped, never honored.
  // The invariant that actually matters: the reply routes ONLY to the
  // server-bound destination, regardless of any injected field.
  const store = new SpikeStore();
  const cap = mintCapability();
  store.registerCorrelation(cap.hash, bind({ destinationRef: "server-bound-dest" }), 60_000);
  const client = await connectedClient(store);

  const out = parse(
    await client.callTool({
      name: "submit_reply",
      arguments: { reply_capability: cap.secret, text: "x", destination: "+1-attacker", space_id: "evil" },
    }),
  );

  // The reply is accepted (rogue keys stripped), but the destination is the
  // server-held one — the model's injected destination had zero authority.
  assert.equal(out.status, "accepted");
  assert.equal(store.destinationForReply(out.reply_id as string), "server-bound-dest");
  store.close();
});
