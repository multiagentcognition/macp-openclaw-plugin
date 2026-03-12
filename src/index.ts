import { MACPService } from './service.js';
import { MACPChannelBridge } from './bridge.js';
import { registerAllTools } from './tools.js';
import type { OpenClawPluginApi, PluginConfig } from './types.js';

/**
 * @macp/openclaw-plugin — Native MACP multi-agent coordination for OpenClaw.
 *
 * This plugin embeds MACPCore, MACPExtensions, and MACPExtensionsAdvanced
 * directly into the OpenClaw Gateway process, providing 42 MACP tools
 * to every agent without the overhead of a separate MCP server process.
 *
 * Lifecycle:
 *   Gateway start  → MACPService.start() opens the shared SQLite DB
 *   Agent bootstrap → auto-register agent + join default channel
 *   Bootstrap hook  → optionally poll and inject deliveries into context
 *   Gateway stop    → deregister tracked agents and close the DB cleanly
 */
export default function register(api: OpenClawPluginApi): void {
  const config: PluginConfig = {
    projectId: api.config.projectId,
    dbPath: api.config.dbPath,
    defaultChannel: api.config.defaultChannel ?? 'general',
    autoPollInject: api.config.autoPollInject ?? false,
    bridgeChannels: api.config.bridgeChannels ?? false,
    bridgeChannelPriority: api.config.bridgeChannelPriority ?? 0,
  };

  const service = new MACPService(config);
  let bridge: MACPChannelBridge | null = null;

  // ── Register background service ────────────────────────────

  api.registerService({
    id: 'macp-coordination',

    async start() {
      await service.start();
      api.logger.info(`[MACP] Service started — project: ${config.projectId}`);

      if (config.bridgeChannels) {
        bridge = new MACPChannelBridge(service, config.bridgeChannelPriority);
        await bridge.start();
        api.logger.info('[MACP] Channel bridge active on bridge:human');
      }
    },

    async stop() {
      if (bridge) {
        await bridge.stop();
        bridge = null;
      }
      await service.stop();
      api.logger.info('[MACP] Service stopped');
    },
  });

  // ── Register all 42 exposed MACP tools ─────────────────────

  registerAllTools(api, service);

  // ── Lifecycle hooks ────────────────────────────────────────

  // Auto-register agents when they bootstrap
  api.registerHook(
    'agent:bootstrap',
    async (event: unknown) => {
      const ev = event as { agentId?: string; agentName?: string };
      if (!ev.agentId) return;

      const name = ev.agentName ?? ev.agentId;
      try {
        const session = service.registerAgent(ev.agentId, name);
        api.logger.info(`[MACP] Agent registered: ${name} (${session.agentId})`);
      } catch (e) {
        api.logger.error(`[MACP] Failed to register agent ${name}:`, e);
      }
    },
    { name: 'macp.agent-register', description: 'Auto-register agents with MACP on bootstrap' },
  );

  // Inject MACP deliveries into agent context.
  // NOTE: This assumes agent:bootstrap fires per run/turn, not just once
  // per agent lifecycle.  If OpenClaw fires it only once, this feature
  // provides initial context only — agents should still call macp_poll
  // explicitly during their turns for ongoing awareness.
  if (config.autoPollInject) {
    api.registerHook(
      'agent:bootstrap',
      async (event: unknown) => {
        const ev = event as { agentId?: string; context?: { append?: (text: string) => void } };
        if (!ev.agentId || !ev.context?.append) return;

        try {
          const deliveries = service.pollForAgent(ev.agentId);
          if (deliveries.length > 0) {
            const contextBlock = service.formatDeliveriesAsContext(deliveries);
            ev.context.append(contextBlock);
          }
        } catch {
          // Non-fatal — agent may not be registered yet
        }
      },
      { name: 'macp.context-inject', description: 'Inject MACP deliveries into agent context' },
    );
  }

  // Bridge inbound messages to MACP
  if (config.bridgeChannels) {
    api.registerHook(
      'message:received',
      async (event: unknown) => {
        if (!bridge) return;
        const ev = event as {
          channelType?: string;
          senderName?: string;
          peerId?: string;
          text?: string;
          timestamp?: string;
        };
        if (!ev.channelType || !ev.text || !ev.peerId) return;

        bridge.onMessageIngress({
          channelType: ev.channelType,
          senderName: ev.senderName ?? 'unknown',
          peerId: ev.peerId,
          text: ev.text,
          timestamp: ev.timestamp,
        });
      },
      { name: 'macp.bridge-ingest', description: 'Forward messaging platform messages to MACP bus' },
    );
  }

  // ── Status command ─────────────────────────────────────────

  api.registerCommand({
    name: 'macp',
    description: 'Show MACP coordination status',
    acceptsArgs: true,
    async handler() {
      try {
        const core = service.requireCore();
        const ext = service.requireExt();
        const agents = ext.listAgents();
        const agentList = (agents as { agents?: Array<{ name: string; agentId: string }> })
          .agents ?? [];

        const lines = [
          `MACP Coordination Status`,
          `Project: ${config.projectId}`,
          `Channel: ${config.defaultChannel}`,
          `Agents online: ${agentList.length}`,
        ];

        for (const a of agentList) {
          lines.push(`  - ${a.name} (${a.agentId})`);
        }

        if (config.bridgeChannels) {
          lines.push(`Bridge: active (bridge:human)`);
        }

        return { text: lines.join('\n') };
      } catch (e) {
        return { text: `MACP status error: ${e}` };
      }
    },
  });
}

// Re-export for programmatic use
export { MACPService } from './service.js';
export { MACPChannelBridge } from './bridge.js';
export { registerAllTools } from './tools.js';
export type { PluginConfig, AgentSession, OpenClawPluginApi } from './types.js';
