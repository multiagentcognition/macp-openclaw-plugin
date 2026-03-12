import { randomUUID } from 'node:crypto';
import {
  MacpCore,
  type SenderInfo,
} from 'macp-mcp';
import { MacpWorkspaceExtensions } from 'macp-mcp';
import { MacpWorkspaceExtensionsAdvanced } from 'macp-mcp';
import type { PluginConfig, AgentSession } from './types.js';

/**
 * Central MACP service embedded in the OpenClaw Gateway process.
 *
 * Manages a single MACPCore + MACPExtensions + MACPExtensionsAdvanced
 * instance shared across all OpenClaw agents in this Gateway.  Handles
 * agent registration/deregistration, background polling, and delivery
 * buffering for context injection.
 */
export class MACPService {
  private core: MacpCore | null = null;
  private ext: MacpWorkspaceExtensions | null = null;
  private adv: MacpWorkspaceExtensionsAdvanced | null = null;
  private config: PluginConfig;
  private agentSessions = new Map<string, AgentSession>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pendingDeliveries = new Map<string, unknown[]>();

  constructor(config: PluginConfig) {
    this.config = config;
  }

  // ── Lifecycle ────────────────────────────────────────────────

  async start(): Promise<void> {
    const dbPath =
      this.config.dbPath ??
      `${process.env.HOME}/.macp/projects/${this.config.projectId}.macp.db`;

    this.core = new MacpCore({ dbPath });
    this.ext = new MacpWorkspaceExtensions({ dbPath });
    this.adv = new MacpWorkspaceExtensionsAdvanced({ dbPath });

    this.pollTimer = setInterval(() => this.pollAll(), this.config.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    for (const agentId of this.agentSessions.keys()) {
      this.deregisterAgent(agentId);
    }

    this.adv?.close();
    this.ext?.close();
    this.core?.close();
    this.core = null;
    this.ext = null;
    this.adv = null;
  }

  // ── Agent Registration ───────────────────────────────────────

  registerAgent(agentId: string, name: string): AgentSession {
    const core = this.requireCore();
    const sessionId = randomUUID();

    core.registerAgent({
      agentId,
      sessionId,
      name,
      capabilities: { role: 'openclaw-agent', host: 'openclaw' },
      interestTags: [],
      queuePreferences: { max_pending_messages: 200 },
    });

    core.joinChannel({
      agentId,
      sessionId,
      channelId: this.config.defaultChannel,
    });

    const session: AgentSession = { agentId, sessionId, name };
    this.agentSessions.set(agentId, session);

    // Announce presence
    try {
      const from: SenderInfo = { agentId, sessionId, name };
      core.sendChannel({
        from,
        channelId: this.config.defaultChannel,
        content: JSON.stringify({ type: 'agent.online', agent: name }),
        priority: 0,
        type: 'lifecycle',
        ttlSeconds: 300,
      });
    } catch {
      // Best-effort — channel may be empty
    }

    return session;
  }

  deregisterAgent(agentId: string): void {
    const session = this.agentSessions.get(agentId);
    if (!session || !this.core) return;

    try {
      const from: SenderInfo = {
        agentId: session.agentId,
        sessionId: session.sessionId,
        name: session.name,
      };
      this.core.sendChannel({
        from,
        channelId: this.config.defaultChannel,
        content: JSON.stringify({ type: 'agent.offline', agent: session.name }),
        priority: 0,
        type: 'lifecycle',
        ttlSeconds: 300,
      });
    } catch {
      // Best-effort
    }

    try {
      this.core.deregister({
        agentId: session.agentId,
        sessionId: session.sessionId,
      });
    } catch {
      // Best-effort
    }

    this.agentSessions.delete(agentId);
    this.pendingDeliveries.delete(agentId);
  }

  // ── Polling ──────────────────────────────────────────────────

  private pollAll(): void {
    if (!this.core) return;

    for (const agentId of this.agentSessions.keys()) {
      try {
        const result = this.core.poll({ agentId });
        if (result.deliveries.length > 0) {
          const existing = this.pendingDeliveries.get(agentId) ?? [];
          this.pendingDeliveries.set(agentId, [...existing, ...result.deliveries]);
        }
      } catch {
        // Non-fatal — will retry next tick
      }
    }
  }

  /**
   * Retrieve and clear buffered deliveries for an agent.
   * Called during context assembly to inject messages into the prompt.
   */
  getAndClearDeliveries(agentId: string): unknown[] {
    const deliveries = this.pendingDeliveries.get(agentId) ?? [];
    this.pendingDeliveries.delete(agentId);
    return deliveries;
  }

  /**
   * Format buffered deliveries as a context block for injection
   * into the agent's system prompt.
   */
  formatDeliveriesAsContext(deliveries: unknown[]): string {
    if (deliveries.length === 0) return '';

    const lines = (deliveries as Array<Record<string, unknown>>).map((d) => {
      const from = d.from as Record<string, string> | undefined;
      const priorityNames = ['info', 'advisory', 'steering', 'interrupt'];
      const priority = priorityNames[d.priority as number] ?? 'info';
      return `[${priority}] ${from?.name ?? 'unknown'}: ${String(d.content ?? '')}`;
    });

    return [
      '<macp-deliveries>',
      'Messages from other agents:',
      '',
      ...lines,
      '',
      'Use macp_ack to acknowledge after acting on these.',
      '</macp-deliveries>',
    ].join('\n');
  }

  // ── Accessors ────────────────────────────────────────────────

  requireCore(): MacpCore {
    if (!this.core) throw new Error('MACP service not started');
    return this.core;
  }

  requireExt(): MacpWorkspaceExtensions {
    if (!this.ext) throw new Error('MACP service not started');
    return this.ext;
  }

  requireAdv(): MacpWorkspaceExtensionsAdvanced {
    if (!this.adv) throw new Error('MACP service not started');
    return this.adv;
  }

  getSession(agentId: string): AgentSession | undefined {
    return this.agentSessions.get(agentId);
  }

  /**
   * Returns the first registered session.  Used as fallback when
   * the calling agent's ID is not explicitly provided.
   */
  getDefaultSession(): AgentSession | undefined {
    const first = this.agentSessions.values().next();
    return first.done ? undefined : first.value;
  }

  /**
   * Resolve a session from an explicit agentId parameter or fall
   * back to the default session.  Throws if no session is found.
   */
  resolveSession(agentId?: string): AgentSession {
    const session = agentId
      ? this.agentSessions.get(agentId)
      : this.getDefaultSession();
    if (!session) {
      throw new Error(
        agentId
          ? `Agent ${agentId} not registered with MACP`
          : 'No MACP agent session available',
      );
    }
    return session;
  }

  getConfig(): PluginConfig {
    return this.config;
  }
}
