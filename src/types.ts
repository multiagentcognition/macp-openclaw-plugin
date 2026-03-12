/**
 * Plugin configuration from openclaw.plugin.json configSchema.
 */
export interface PluginConfig {
  projectId: string;
  dbPath?: string;
  defaultChannel: string;
  pollIntervalMs: number;
  autoPollInject: boolean;
  bridgeChannels: boolean;
  bridgeChannelPriority: number;
}

/**
 * Tracked MACP session for an OpenClaw agent.
 */
export interface AgentSession {
  agentId: string;
  sessionId: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Minimal OpenClaw Plugin API types
// These mirror the OpenClaw plugin contract without requiring openclaw as a
// compile-time dependency.  The actual runtime objects are provided by the
// Gateway when it loads this plugin.
// ---------------------------------------------------------------------------

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ServiceDefinition {
  id: string;
  start: (runtime: unknown) => Promise<void>;
  stop: (runtime: unknown) => Promise<void>;
}

export interface OpenClawPluginApi {
  registerTool(tool: ToolDefinition, opts?: { optional?: boolean }): void;
  registerService(service: ServiceDefinition): void;
  registerHook(
    event: string,
    handler: (...args: unknown[]) => Promise<void>,
    meta: { name: string; description?: string },
  ): void;
  registerCommand(command: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    handler: (ctx: unknown) => Promise<{ text: string }>;
  }): void;
  logger: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  config: PluginConfig;
}
