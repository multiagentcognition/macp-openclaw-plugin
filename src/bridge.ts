import { randomUUID } from 'node:crypto';
import type { Priority, SenderInfo } from 'macp-mcp';
import type { MACPService } from './service.js';
import type { AgentSession } from './types.js';

/**
 * Bridges OpenClaw messaging channels (WhatsApp, Slack, Telegram, etc.)
 * into the MACP bus so external agents can observe human conversations.
 *
 * When enabled, the Gateway itself registers as a special MACP agent
 * ("openclaw-gateway") and forwards normalized inbound messages to the
 * "bridge:human" channel.  External agents (Claude Code, Gemini CLI)
 * can poll this channel to gain situational awareness.
 *
 * Reverse bridging is also supported: an external agent can send a
 * message with type "bridge_reply" and a target platform/peerId, and
 * the bridge will route it back through OpenClaw's channel adapter.
 */
export class MACPChannelBridge {
  private service: MACPService;
  private session: AgentSession | null = null;
  private bridgeChannelPriority: Priority;

  private static readonly GATEWAY_AGENT_ID = 'openclaw-gateway';
  private static readonly BRIDGE_CHANNEL = 'bridge:human';

  constructor(service: MACPService, bridgeChannelPriority: number) {
    this.service = service;
    this.bridgeChannelPriority =
      bridgeChannelPriority >= 0 && bridgeChannelPriority <= 3
        ? (bridgeChannelPriority as Priority)
        : 0;
  }

  // ── Lifecycle ────────────────────────────────────────────────

  async start(): Promise<void> {
    const core = this.service.requireCore();
    const sessionId = randomUUID();

    core.registerAgent({
      agentId: MACPChannelBridge.GATEWAY_AGENT_ID,
      sessionId,
      name: 'OpenClaw Gateway',
      capabilities: { role: 'gateway-bridge', host: 'openclaw' },
      interestTags: ['bridge', 'human-messages'],
      queuePreferences: { max_pending_messages: 50 },
    });

    core.joinChannel({
      agentId: MACPChannelBridge.GATEWAY_AGENT_ID,
      sessionId,
      channelId: MACPChannelBridge.BRIDGE_CHANNEL,
    });

    this.session = {
      agentId: MACPChannelBridge.GATEWAY_AGENT_ID,
      sessionId,
      name: 'OpenClaw Gateway',
    };
  }

  async stop(): Promise<void> {
    if (!this.session) return;

    try {
      this.service.requireCore().deregister({
        agentId: this.session.agentId,
        sessionId: this.session.sessionId,
      });
    } catch {
      // Best-effort
    }

    this.session = null;
  }

  // ── Inbound: messaging platform → MACP bus ──────────────────

  /**
   * Forward a normalized inbound message to the MACP bridge channel.
   * Call this from an OpenClaw hook on message ingress.
   */
  onMessageIngress(msg: {
    channelType: string;
    senderName: string;
    peerId: string;
    text: string;
    timestamp?: string;
  }): void {
    if (!this.session) return;

    const core = this.service.requireCore();
    const from: SenderInfo = {
      agentId: this.session.agentId,
      sessionId: this.session.sessionId,
      name: this.session.name,
    };

    try {
      core.sendChannel({
        from,
        channelId: MACPChannelBridge.BRIDGE_CHANNEL,
        content: JSON.stringify({
          type: 'human_message',
          platform: msg.channelType,
          from: msg.senderName,
          peerId: msg.peerId,
          text: msg.text,
          timestamp: msg.timestamp ?? new Date().toISOString(),
        }),
        priority: this.bridgeChannelPriority,
        type: 'bridge',
        ttlSeconds: 1800, // 30 minutes
      });
    } catch {
      // Non-fatal — bridge is best-effort
    }
  }

  // ── Outbound: MACP bus → messaging platform ─────────────────

  /**
   * Check if a delivery is a bridge reply and extract routing info.
   * Returns null if the delivery is not a bridge reply.
   */
  parseBridgeReply(delivery: Record<string, unknown>): {
    platform: string;
    peerId: string;
    text: string;
  } | null {
    try {
      const content =
        typeof delivery.content === 'string'
          ? JSON.parse(delivery.content)
          : delivery.content;

      if (
        content &&
        content.type === 'bridge_reply' &&
        typeof content.platform === 'string' &&
        typeof content.peerId === 'string' &&
        typeof content.text === 'string'
      ) {
        return {
          platform: content.platform,
          peerId: content.peerId,
          text: content.text,
        };
      }
    } catch {
      // Malformed — not a bridge reply
    }

    return null;
  }
}
