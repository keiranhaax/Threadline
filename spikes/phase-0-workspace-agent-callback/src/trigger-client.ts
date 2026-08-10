// Minimal Workspace Agent trigger client for the live gate.
//
// Verified against official OpenAI docs (2026-08-10, developers.openai.com/
// workspace-agents/trigger-runs):
//   - POST {base}/workspace_agents/{agtch_id}/trigger
//   - Bearer = Workspace Agent access token (NOT a Platform API key)
//   - Body: { input, conversation_key? }  (only these two fields)
//   - Header Idempotency-Key: <stable inbound message id>
//   - Header OpenAI-Beta: workspace_agent_runs=v1  -> response carries
//     agent_trigger_run_id (apirun_XXX) for beta status polling
//   - Returns 202 + { conversation_url }; the answer is NEVER returned here.
//
// This module performs NETWORK I/O and requires live credentials. It is invoked
// only by the operator during the live gate; the offline test suite does not
// import it.

export interface TriggerParams {
  /** The normalized inbound message plus the opaque correlation capability. */
  input: string;
  /** Opaque conversation key (photon identifiers are NOT embedded). */
  conversationKey: string;
  /** Stable idempotency key = inbound Photon message id. */
  idempotencyKey: string;
}

export interface TriggerResult {
  httpStatus: number;
  conversationUrl?: string;
  agentTriggerRunId?: string; // apirun_XXX (beta)
  raw: unknown;
}

export interface TriggerClientConfig {
  baseUrl: string; // https://api.chatgpt.com/v1
  triggerId: string; // agtch_XXX
  accessToken: string; // Workspace Agent scoped token
}

export class WorkspaceAgentTriggerClient {
  constructor(private cfg: TriggerClientConfig) {}

  async trigger(params: TriggerParams): Promise<TriggerResult> {
    const url = `${this.cfg.baseUrl}/workspace_agents/${encodeURIComponent(this.cfg.triggerId)}/trigger`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.cfg.accessToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": params.idempotencyKey,
        "OpenAI-Beta": "workspace_agent_runs=v1",
      },
      body: JSON.stringify({ input: params.input, conversation_key: params.conversationKey }),
    });

    let raw: unknown = undefined;
    try {
      raw = await res.json();
    } catch {
      raw = await res.text().catch(() => undefined);
    }

    const obj = (raw ?? {}) as Record<string, unknown>;
    return {
      httpStatus: res.status,
      conversationUrl: typeof obj.conversation_url === "string" ? obj.conversation_url : undefined,
      agentTriggerRunId: typeof obj.agent_trigger_run_id === "string" ? obj.agent_trigger_run_id : undefined,
      raw,
    };
  }

  /** Beta run-status poll. Returns status only; never the agent's output text. */
  async pollRun(runId: string): Promise<{ httpStatus: number; status?: string; raw: unknown }> {
    const url = `${this.cfg.baseUrl}/workspace_agents/${encodeURIComponent(this.cfg.triggerId)}/runs/${encodeURIComponent(runId)}`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.cfg.accessToken}`,
        "OpenAI-Beta": "workspace_agent_runs=v1",
      },
    });
    let raw: unknown = undefined;
    try {
      raw = await res.json();
    } catch {
      raw = undefined;
    }
    const obj = (raw ?? {}) as Record<string, unknown>;
    const inner = (obj["workspace_agent.trigger_run"] ?? obj) as Record<string, unknown>;
    return {
      httpStatus: res.status,
      status: typeof inner.status === "string" ? inner.status : undefined,
      raw,
    };
  }
}
