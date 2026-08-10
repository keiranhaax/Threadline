// Environment loading for the spike. NO secrets live in the repo; everything is
// read from process.env at runtime. Missing values are reported clearly so the
// operator knows exactly which live gate is unconfigured.

export interface SpikeConfig {
  // --- OpenAI Workspace Agent trigger (live gate) ---
  workspaceAgentTriggerId: string | undefined; // agtch_XXX (the API channel id)
  workspaceAgentAccessToken: string | undefined; // Workspace Agent scoped token
  openaiTriggerBaseUrl: string; // default https://api.chatgpt.com/v1

  // --- Secure MCP Tunnel (live gate) ---
  tunnelId: string | undefined;
  openaiRuntimeApiKey: string | undefined;

  // --- Photon / Spectrum (live gate) ---
  photonProjectId: string | undefined;
  photonProjectSecret: string | undefined;
  photonWebhookSecret: string | undefined;

  // --- Spike server ---
  mcpListenPort: number;
  maxTextLength: number;
  sqlitePath: string;
}

function req(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export function loadConfig(): SpikeConfig {
  return {
    workspaceAgentTriggerId: req("THREADLINE_WA_TRIGGER_ID"),
    workspaceAgentAccessToken: req("THREADLINE_WA_ACCESS_TOKEN"),
    openaiTriggerBaseUrl: req("THREADLINE_OPENAI_BASE_URL") ?? "https://api.chatgpt.com/v1",
    tunnelId: req("THREADLINE_TUNNEL_ID"),
    openaiRuntimeApiKey: req("THREADLINE_OPENAI_RUNTIME_API_KEY"),
    photonProjectId: req("THREADLINE_PHOTON_PROJECT_ID"),
    photonProjectSecret: req("THREADLINE_PHOTON_PROJECT_SECRET"),
    photonWebhookSecret: req("THREADLINE_PHOTON_WEBHOOK_SECRET"),
    mcpListenPort: Number(req("THREADLINE_MCP_PORT") ?? "8787"),
    maxTextLength: Number(req("THREADLINE_MAX_TEXT") ?? "4000"),
    sqlitePath: req("THREADLINE_SQLITE_PATH") ?? "./phase0.sqlite",
  };
}

/** Report which live gates are configured. Used by the operator checklist. */
export function gateStatus(cfg: SpikeConfig): Record<string, boolean> {
  return {
    "workspace-agent-trigger": !!(cfg.workspaceAgentTriggerId && cfg.workspaceAgentAccessToken),
    "secure-mcp-tunnel": !!(cfg.tunnelId && cfg.openaiRuntimeApiKey),
    photon: !!(cfg.photonProjectId && cfg.photonProjectSecret),
    "photon-webhook": !!cfg.photonWebhookSecret,
  };
}
