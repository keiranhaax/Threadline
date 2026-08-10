# Threadline implementation plan

## 1. Product goal

Build a private iMessage interface whose default runtime is a published ChatGPT Workspace Agent. The hosted agent can use its configured web access, plugins, skills, instructions, and approvals, while authenticated bridges provide limited access to a VPS and selected local computers.

Threadline should feel like one assistant even though several runtimes may participate. The router owns identity, session mappings, delivery guarantees, and handoffs; runtimes do not share context automatically.

## 2. Scope

### Version 1

- One owner and one Photon shared line.
- Text messages only.
- Published Workspace Agent as the default runtime.
- Stable conversation continuity per Threadline session.
- Replies delivered through a private Photon MCP tool.
- `/new`, `/work`, `/status`, and `/help`.
- Auditable routing, idempotency, health checks, and basic rate limiting.

### Later releases

- VPS and local-PC host bridges.
- Optional Codex app-server routing with model and reasoning commands.
- Multiple named machines and project profiles.
- Attachments, reactions, typing indicators, and reply threading.
- Multi-user access with isolated identities and policies.

### Non-goals for version 1

- Reusing an arbitrary existing ChatGPT Work chat or its live container.
- Per-message model, reasoning, or plugin changes on Workspace Agent API triggers.
- Giving the hosted agent unrestricted shell or filesystem access.
- Exposing Photon, MCP, app-server, or host-bridge ports directly to the public internet.
- Supporting multiple visible iMessage identities.

## 3. System boundaries

| Component | Runs in | Responsibility | Trust boundary |
| --- | --- | --- | --- |
| Photon/Spectrum | VPS | Receive and send iMessages | Only the gateway owns the shared line. |
| Threadline gateway | VPS | Authentication, commands, routing, state, retries | Treat every inbound message as untrusted. |
| Workspace Agent | ChatGPT cloud | Default reasoning and configured Work tools | Can access only published agent resources and connected tools. |
| Photon MCP | VPS | Read the bound thread and send replies | Destination is bound by server policy, never by prompt text. |
| Host bridge | VPS or local PC | Narrow machine and project operations | Private network, explicit allowlists, least privilege. |
| Codex app-server adapter | Selected host | Optional controlled Codex sessions | Never expose app-server directly; gateway or private relay owns access. |
| State store | VPS | Sessions, mappings, dedupe, health | Encrypt sensitive data and minimize retained content. |

## 4. Message lifecycle

1. Spectrum delivers an inbound message event to the gateway.
2. The gateway verifies the sender and permitted Photon space, then deduplicates by message ID.
3. The command parser handles control messages locally or resolves the active runtime.
4. For the default hosted path, the gateway triggers the published Workspace Agent with:
   - `conversation_key = photon:<space-id>:<threadline-session-id>`
   - `Idempotency-Key = <photon-message-id>`
   - input containing the normalized message and opaque correlation ID
5. The agent follows its saved instructions and may use approved plugins or Threadline MCP tools.
6. The agent calls the Photon MCP reply tool exactly once with the correlation ID and response text.
7. Photon MCP resolves the destination from trusted server state, sends the reply, and records delivery.
8. The gateway reports timeouts or failures without silently duplicating the run.

Workspace Agent triggers are asynchronous and do not provide the completed agent response directly, so MCP delivery is part of the core architecture rather than an optional integration.

## 5. Session and routing model

The gateway keeps a durable record for each Threadline session:

```text
session_id
owner_id
photon_space_id
active_target
workspace_conversation_key
codex_thread_id_by_backend
created_at
last_activity_at
policy_profile
```

`/new` creates a new `session_id`; it does not delete history. `/work`, `/vps`, and `/local` change the active target for later plain-text messages. A target switch should inject only a bounded handoff summary, never assume shared hidden context.

## 6. Tool contracts

### Photon MCP

- `get_thread(correlation_id, limit)` returns only messages from the server-bound permitted space.
- `reply(correlation_id, text, reply_to?)` sends one response to the bound space.
- Later: `get_attachment`, `react`, and `set_typing`.

The MCP server rejects arbitrary destination identifiers and duplicate replies for the same correlation ID.

### Host bridge

Start with a small project-aware surface rather than a generic remote shell:

- `list_projects()`
- `project_status(project_id)`
- `read_project_file(project_id, path)`
- `run_project_task(project_id, task, arguments)`
- `request_codex_session(project_id, prompt, options?)`

Each bridge owns its project allowlist, path validation, command registry, timeouts, output limits, and approval rules.

## 7. Security requirements

- Authenticate Photon events and allowlist the owner before processing commands.
- Use independent credentials for Workspace Agent triggers, Photon MCP, and every host bridge.
- Keep local-PC traffic on Tailscale, SSH, or an equivalent private authenticated channel.
- Use short-lived credentials where supported and rotate long-lived secrets.
- Prevent path traversal, command injection, SSRF, and prompt-controlled destinations.
- Require confirmation or approval for deletion, publication, messaging third parties, purchases, and privilege changes.
- Apply per-sender and per-backend rate limits.
- Record immutable event IDs and delivery state for retry safety.
- Redact tokens, credentials, private paths, and sensitive message bodies from operational logs.

## 8. Suggested repository layout

```text
threadline/
  apps/
    gateway/              # Spectrum ingress, router, commands, delivery state
    photon-mcp/           # Workspace Agent tools for thread reads and replies
  packages/
    protocol/             # Shared event, command, and tool schemas
    state/                # Session and idempotency persistence
    workspace-agent/      # Trigger client and agent configuration notes
    host-bridge/          # Reusable bridge server and policy engine
    codex-adapter/        # Optional app-server integration
  docs/
    PLAN.md
    SECURITY.md
    WORKSPACE_AGENT.md
  README.md
```

Recommended starting stack: TypeScript, Node.js, Spectrum TS, JSON Schema or Zod at every boundary, a small HTTP framework, and SQLite for the single-owner MVP. The choices should remain replaceable behind the protocol and state packages.

## 9. Delivery phases

### Phase 0 — Validate prerequisites

- Confirm Workspace Agents API access and create a published test agent.
- Configure one Photon test space and verify inbound/outbound Spectrum events.
- Decide the MCP authentication method and the exact owner allowlist.
- Write a minimal threat model before enabling external writes.

Exit: documented credentials, endpoints, policies, and a manually verified test path.

### Phase 1 — Gateway foundation

- Implement event validation, allowlisting, deduplication, persistence, and structured logs.
- Implement `/help`, `/status`, and `/new`.
- Add health checks and graceful restart behavior.

Exit: duplicate inbound events never create duplicate internal requests.

### Phase 2 — Hosted Work loop

- Implement the Workspace Agent trigger client.
- Implement `get_thread` and exactly-once `reply` in Photon MCP.
- Publish narrow agent instructions and test approval behavior.
- Add timeout and missing-reply alerts.

Exit: one iMessage produces exactly one hosted-agent reply and preserves continuity across messages.

### Phase 3 — VPS bridge

- Add project registration, task allowlists, output limits, and approval gates.
- Connect the bridge to the Workspace Agent through MCP.
- Add `/vps` routing and status reporting.

Exit: the agent can complete an approved task in one registered VPS project without general host access.

### Phase 4 — Local-PC bridge

- Deploy the same bridge behind a private network connection.
- Add named-device health and `/local [name]` routing.
- Define offline behavior and safe retry rules.

Exit: an offline computer fails clearly; an online computer can perform only approved project tasks.

### Phase 5 — Optional Codex app-server

- Add persistent thread mapping and streamed-event handling.
- Implement `/model` and `/reasoning` only for app-server-backed sessions.
- Define bounded context handoffs between Workspace Agent and Codex threads.

Exit: runtime differences are visible to the user and context never appears to transfer implicitly.

### Phase 6 — Hardening

- Add threat-model tests, abuse limits, secret rotation procedures, backups, monitoring, and recovery drills.
- Add attachment handling only after content limits and scanning are defined.

Exit: security review and an operational runbook are complete.

## 10. MVP acceptance criteria

- Unauthorized senders receive no agent access.
- A permitted inbound message is processed once despite delivery retries.
- The default target is always the published Workspace Agent.
- Conversation continuity survives a gateway restart.
- `/new` starts a distinct conversation mapping.
- The agent cannot choose a Photon destination from message text.
- A successful run sends exactly one reply.
- A missing, duplicate, late, or failed reply is observable.
- No secret appears in source control or normal logs.
- VPS and PC files remain inaccessible until an explicit host bridge is configured.

## 11. Decisions required before implementation

1. Photon/Spectrum authentication and event-delivery details for the existing installation.
2. The initial permitted Photon space and sender identifiers.
3. Whether the Workspace Agent's fixed model and tool configuration is acceptable for the MVP.
4. Which single VPS project should be the first host-bridge pilot.
5. Whether the local-PC bridge will use Tailscale or SSH forwarding.
6. Retention period for message metadata and operational logs.
