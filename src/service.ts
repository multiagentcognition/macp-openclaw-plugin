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
 * agent registration/deregistration and on-demand polling.
 *
 * Polling is intentionally on-demand (not timer-based).  MACP's poll()
 * mutates delivery state (marks surfaced, records ACKs), so calling it
 * before the agent explicitly asks for messages would change protocol
 * semantics.  Agents poll via macp_poll or the optional autoPollInject
 * hook, both of which are agent-initiated.
 */
export class MACPService {
  private core: MacpCore | null = null;
  private ext: MacpWorkspaceExtensions | null = null;
  private adv: MacpWorkspaceExtensionsAdvanced | null = null;
  private config: PluginConfig;
  private agentSessions = new Map<string, AgentSession>();

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
  }

  async stop(): Promise<void> {
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
  }

  // ── On-demand Polling ──────────────────────────────────────────

  /**
   * Poll deliveries for a specific agent on demand.
   * This is the correct way to retrieve deliveries — it calls poll()
   * only when the agent is ready to see the results, preserving
   * MACP's surfaced/ACK semantics.
   */
  pollForAgent(agentId: string): unknown[] {
    const core = this.requireCore();
    const result = core.poll({ agentId });
    return result.deliveries;
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
   * back to the default session.
   *
   * When exactly one agent is registered, agentId may be omitted.
   * When multiple agents are registered, agentId is required —
   * this prevents an LLM omission from silently mutating or
   * polling the wrong agent's MACP state.
   */
  resolveSession(agentId?: string): AgentSession {
    if (agentId) {
      const session = this.agentSessions.get(agentId);
      if (!session) {
        throw new Error(`Agent ${agentId} not registered with MACP`);
      }
      return session;
    }

    if (this.agentSessions.size === 0) {
      throw new Error('No MACP agent session available');
    }

    if (this.agentSessions.size > 1) {
      throw new Error(
        'Multiple agents registered — agentId is required to avoid session ambiguity',
      );
    }

    return this.agentSessions.values().next().value!;
  }

  getConfig(): PluginConfig {
    return this.config;
  }
}
