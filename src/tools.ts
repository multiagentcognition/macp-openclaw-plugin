import type {
  AckLevel,
  GoalStatus,
  GoalType,
  MemoryEntry,
  MemoryConfidence,
  MemoryLayer,
  MemoryScope,
  Priority,
  PriorityAlias,
  QueryContextEntry,
  SenderInfo,
  TaskPriority,
  TaskStatus,
} from 'macp-mcp';
import type { MACPService } from './service.js';
import type { OpenClawPluginApi, ToolResult } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function senderFrom(session: { agentId: string; sessionId: string; name: string }): SenderInfo {
  return { agentId: session.agentId, sessionId: session.sessionId, name: session.name };
}

const PRIORITY_MAP: Record<PriorityAlias, Priority> = {
  info: 0,
  advisory: 1,
  steering: 2,
  interrupt: 3,
};

const QUERY_SOURCE_KIND_MAP = {
  memory: 'memory',
  vault: 'vault_doc',
  tasks: 'task',
  goals: 'goal',
} as const;

type QuerySource = keyof typeof QUERY_SOURCE_KIND_MAP;
type QueryKind = (typeof QUERY_SOURCE_KIND_MAP)[QuerySource];
type ArchiveableTaskStatus = Extract<TaskStatus, 'done' | 'cancelled'>;
type MessageContentType = 'text/plain' | 'application/json';

function resolvePriority(value: unknown): Priority | PriorityAlias {
  if (typeof value === 'number' && value >= 0 && value <= 3) return value as Priority;
  if (typeof value === 'string' && value in PRIORITY_MAP) return value as PriorityAlias;
  return 'advisory';
}

function filterByLayer(
  result: { entries: MemoryEntry[] },
  layer: MemoryLayer | undefined,
): { entries: MemoryEntry[] } {
  if (layer === undefined) return result;
  return {
    entries: result.entries.filter((entry) => entry.layer === layer),
  };
}

function resolveChannelId(service: MACPService, channelId: unknown): string {
  const resolved = typeof channelId === 'string' && channelId.trim().length > 0
    ? channelId
    : service.getConfig().defaultChannel;

  if (!resolved) {
    throw new Error('channelId is required when no default channel is configured.');
  }

  return resolved;
}

function resolveScopedChannelId(service: MACPService, channelId: unknown): string | undefined {
  return typeof channelId === 'string' && channelId.trim().length > 0
    ? channelId
    : service.getConfig().defaultChannel || undefined;
}

function filterQueryContextSources(
  result: { results: QueryContextEntry[] },
  sources: unknown,
): { results: QueryContextEntry[] } {
  if (!Array.isArray(sources) || sources.length === 0) return result;

  const kinds = new Set<QueryKind>(
    sources
      .filter((entry): entry is QuerySource => typeof entry === 'string' && entry in QUERY_SOURCE_KIND_MAP)
      .map((entry) => QUERY_SOURCE_KIND_MAP[entry]),
  );

  if (kinds.size === 0) return result;

  return {
    results: result.results.filter((entry) => kinds.has(entry.kind)),
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the 42 MACP tools exposed to OpenClaw agents.
 *
 * Tools are grouped by category.  Each tool delegates to the shared
 * MACPService which manages the underlying MACPCore, MACPExtensions,
 * and MACPExtensionsAdvanced instances.
 *
 * Session resolution: tools that need the calling agent's identity
 * accept an optional `agentId` parameter.  When omitted the service
 * falls back to the default (first registered) session.
 */
export function registerAllTools(api: OpenClawPluginApi, service: MACPService): void {
  // ── Core Protocol (5 exposed) ──────────────────────────────

  api.registerTool({
    name: 'macp_join_channel',
    description: 'Join a MACP broadcast channel to send and receive messages',
    parameters: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Optional — defaults to the plugin default channel' },
        agentId: { type: 'string', description: 'Optional — override calling agent' },
      },
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireCore().joinChannel({
          agentId: session.agentId,
          sessionId: session.sessionId,
          channelId: resolveChannelId(service, params.channelId),
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_send_channel',
    description: 'Broadcast a message to all agents in a MACP channel',
    parameters: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Target channel' },
        content: { type: 'string', description: 'Message content' },
        priority: {
          oneOf: [
            { type: 'number', enum: [0, 1, 2, 3] },
            { type: 'string', enum: ['info', 'advisory', 'steering', 'interrupt'] },
          ],
          default: 'advisory',
        },
        type: { type: 'string', description: 'Message type tag' },
        relevanceTags: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        sourceReferences: { type: 'array', items: { type: 'string' } },
        ttlSeconds: { type: 'number', description: 'Time-to-live in seconds' },
        contentType: { type: 'string', enum: ['text/plain', 'application/json'] },
        ackLevel: { type: 'string', enum: ['queued', 'received', 'processed'] },
        agentId: { type: 'string', description: 'Optional — override calling agent' },
      },
      required: ['content'],
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireCore().sendChannel({
          from: senderFrom(session),
          channelId: resolveChannelId(service, params.channelId),
          content: params.content as string,
          priority: params.priority === undefined ? undefined : resolvePriority(params.priority),
          type: params.type as string | undefined,
          contentType: params.contentType as MessageContentType | undefined,
          context: {
            relevanceTags: params.relevanceTags as string[] | undefined,
            confidence: params.confidence as number | undefined,
            sourceReferences: params.sourceReferences as string[] | undefined,
          },
          ack: {
            requestLevel: params.ackLevel as AckLevel | undefined,
          },
          ttlSeconds: params.ttlSeconds as number | undefined,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_send_direct',
    description: 'Send a direct message to a specific agent',
    parameters: {
      type: 'object',
      properties: {
        destinationAgentId: { type: 'string', description: 'Target agent ID' },
        content: { type: 'string', description: 'Message content' },
        priority: {
          oneOf: [
            { type: 'number', enum: [0, 1, 2, 3] },
            { type: 'string', enum: ['info', 'advisory', 'steering', 'interrupt'] },
          ],
          default: 'advisory',
        },
        type: { type: 'string' },
        relevanceTags: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        sourceReferences: { type: 'array', items: { type: 'string' } },
        ttlSeconds: { type: 'number' },
        contentType: { type: 'string', enum: ['text/plain', 'application/json'] },
        ackLevel: { type: 'string', enum: ['queued', 'received', 'processed'] },
        agentId: { type: 'string', description: 'Optional — override calling agent' },
      },
      required: ['destinationAgentId', 'content'],
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireCore().sendDirect({
          from: senderFrom(session),
          destinationAgentId: params.destinationAgentId as string,
          content: params.content as string,
          priority: params.priority === undefined ? undefined : resolvePriority(params.priority),
          type: params.type as string | undefined,
          contentType: params.contentType as MessageContentType | undefined,
          context: {
            relevanceTags: params.relevanceTags as string[] | undefined,
            confidence: params.confidence as number | undefined,
            sourceReferences: params.sourceReferences as string[] | undefined,
          },
          ack: {
            requestLevel: params.ackLevel as AckLevel | undefined,
          },
          ttlSeconds: params.ttlSeconds as number | undefined,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_poll',
    description: 'Check for messages from other agents. Returns pending deliveries.',
    parameters: {
      type: 'object',
      properties: {
        minPriority: { type: 'number', enum: [0, 1, 2, 3] },
        maxMessages: { type: 'number' },
        applyBudgetPruning: { type: 'boolean' },
        budgetBytes: { type: 'number' },
        agentId: { type: 'string', description: 'Optional — override calling agent' },
      },
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireCore().poll({
          agentId: session.agentId,
          minPriority: params.minPriority as Priority | undefined,
          maxMessages: params.maxMessages as number | undefined,
          applyBudgetPruning: params.applyBudgetPruning as boolean | undefined,
          budgetBytes: params.budgetBytes as number | undefined,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ack',
    description: 'Acknowledge a delivery after acting on it',
    parameters: {
      type: 'object',
      properties: {
        deliveryId: { type: 'string', description: 'The delivery_id to acknowledge' },
      },
      required: ['deliveryId'],
    },
    async execute(_id, params) {
      try {
        const result = service.requireCore().ack({
          deliveryId: params.deliveryId as string,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  // ── Awareness (2) ──────────────────────────────────────────

  api.registerTool({
    name: 'macp_ext_list_agents',
    description: 'List all active agents on the MACP bus',
    parameters: { type: 'object', properties: {} },
    async execute() {
      try { return ok(service.requireExt().listAgents()); }
      catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_get_session_context',
    description: 'Get detailed session info for a specific agent',
    parameters: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Optional — defaults to the plugin default channel' },
        pendingLimit: { type: 'number' },
        agentId: { type: 'string', description: 'Optional — calling agent' },
      },
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireExt().getSessionContext({
          agentId: session.agentId,
          sessionId: session.sessionId,
          channelId: resolveScopedChannelId(service, params.channelId),
          pendingLimit: params.pendingLimit as number | undefined,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  // ── File Ownership (3) ─────────────────────────────────────

  api.registerTool({
    name: 'macp_ext_claim_files',
    description: 'Claim files to signal editing intent and prevent collisions',
    parameters: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: 'Files to claim' },
        reason: { type: 'string', description: 'Why you need these files' },
        ttlSeconds: { type: 'number', description: 'Claim duration (default 1800)' },
        agentId: { type: 'string' },
      },
      required: ['files'],
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireExt().claimFiles({
          agentId: session.agentId,
          sessionId: session.sessionId,
          files: params.files as string[],
          reason: params.reason as string | undefined,
          ttlSeconds: params.ttlSeconds as number | undefined,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_release_files',
    description: 'Release file claims after you are done editing',
    parameters: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: 'Files to release' },
        reason: { type: 'string', description: 'Optional release note' },
        agentId: { type: 'string' },
      },
      required: ['files'],
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireExt().releaseFiles({
          agentId: session.agentId,
          sessionId: session.sessionId,
          files: params.files as string[],
          reason: params.reason as string | undefined,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_list_locks',
    description: 'List all active file claims across agents',
    parameters: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: 'Filter by file path' },
        claimAgentId: { type: 'string', description: 'Filter claims by agent id' },
      },
    },
    async execute(_id, params) {
      try {
        const result = service.requireExt().listFileClaims({
          agentId: params.claimAgentId as string | undefined,
          files: params.files as string[] | undefined,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  // ── Shared Memory (6) ──────────────────────────────────────

  api.registerTool({
    name: 'macp_ext_set_memory',
    description: 'Store a shared memory entry visible to other agents',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Memory key' },
        value: { type: 'string', description: 'Memory value (text or JSON)' },
        scope: { type: 'string', enum: ['agent', 'channel', 'workspace'], default: 'workspace' },
        layer: { type: 'string', enum: ['constraints', 'behavior', 'context'], default: 'context' },
        confidence: { type: 'string', enum: ['stated', 'inferred', 'observed'], default: 'stated' },
        tags: { type: 'array', items: { type: 'string' } },
        channelId: { type: 'string', description: 'Required when scope=channel' },
        agentId: { type: 'string' },
      },
      required: ['key', 'value', 'scope'],
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireExt().setMemory({
          agentId: session.agentId,
          sessionId: session.sessionId,
          key: params.key as string,
          value: params.value as string,
          scope: params.scope as MemoryScope,
          layer: (params.layer as MemoryLayer | undefined) ?? 'context',
          confidence: (params.confidence as MemoryConfidence | undefined) ?? 'stated',
          tags: params.tags as string[] | undefined,
          channelId: resolveScopedChannelId(service, params.channelId),
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_get_memory',
    description: 'Retrieve a specific memory by key',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        scope: { type: 'string', enum: ['agent', 'channel', 'workspace'] },
        channelId: { type: 'string' },
        agentId: { type: 'string' },
      },
      required: ['key'],
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireExt().getMemory({
          agentId: session.agentId,
          sessionId: session.sessionId,
          key: params.key as string,
          scope: params.scope as MemoryScope | undefined,
          channelId: resolveScopedChannelId(service, params.channelId),
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_search_memory',
    description: 'Search shared memories across all agents',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        scope: { type: 'string', enum: ['agent', 'channel', 'workspace'] },
        layer: { type: 'string', enum: ['constraints', 'behavior', 'context'] },
        tags: { type: 'array', items: { type: 'string' } },
        channelId: { type: 'string' },
        limit: { type: 'number' },
        agentId: { type: 'string' },
      },
      required: ['query'],
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = filterByLayer(service.requireExt().searchMemory({
          agentId: session.agentId,
          sessionId: session.sessionId,
          query: params.query as string,
          scope: params.scope as MemoryScope | undefined,
          channelId: resolveScopedChannelId(service, params.channelId),
          tags: params.tags as string[] | undefined,
          limit: params.limit as number | undefined,
        }), params.layer as MemoryLayer | undefined);
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_list_memories',
    description: 'List all memories, optionally filtered by scope or layer',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['agent', 'channel', 'workspace'] },
        layer: { type: 'string', enum: ['constraints', 'behavior', 'context'] },
        channelId: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        limit: { type: 'number' },
        agentId: { type: 'string' },
      },
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = filterByLayer(service.requireExt().listMemories({
          agentId: session.agentId,
          sessionId: session.sessionId,
          scope: params.scope as MemoryScope | undefined,
          channelId: resolveScopedChannelId(service, params.channelId),
          tags: params.tags as string[] | undefined,
          limit: params.limit as number | undefined,
        }), params.layer as MemoryLayer | undefined);
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_delete_memory',
    description: 'Delete a memory entry',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        scope: { type: 'string', enum: ['agent', 'channel', 'workspace'] },
        channelId: { type: 'string' },
        agentId: { type: 'string' },
      },
      required: ['key', 'scope'],
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireExt().deleteMemory({
          agentId: session.agentId,
          sessionId: session.sessionId,
          key: params.key as string,
          scope: params.scope as MemoryScope,
          channelId: resolveScopedChannelId(service, params.channelId),
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_resolve_memory',
    description: 'Resolve conflicting memory entries by selecting the canonical value for a scope',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        chosenValue: { type: 'string', description: 'Canonical value to write back' },
        scope: { type: 'string', enum: ['agent', 'channel', 'workspace'] },
        layer: { type: 'string', enum: ['constraints', 'behavior', 'context'] },
        confidence: { type: 'string', enum: ['stated', 'inferred', 'observed'] },
        tags: { type: 'array', items: { type: 'string' } },
        agentId: { type: 'string' },
        channelId: { type: 'string' },
      },
      required: ['key', 'chosenValue', 'scope'],
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireExt().resolveMemory({
          agentId: session.agentId,
          sessionId: session.sessionId,
          key: params.key as string,
          scope: params.scope as MemoryScope,
          chosenValue: params.chosenValue as string,
          channelId: resolveScopedChannelId(service, params.channelId),
          tags: params.tags as string[] | undefined,
          confidence: params.confidence as MemoryConfidence | undefined,
          layer: params.layer as MemoryLayer | undefined,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  // ── Profiles (4) ───────────────────────────────────────────

  api.registerTool({
    name: 'macp_ext_register_profile',
    description: 'Register a reusable role profile with skills and memory hints',
    parameters: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Profile identifier (e.g. "researcher")' },
        name: { type: 'string' },
        role: { type: 'string' },
        contextPack: { type: 'string' },
        skills: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['id', 'name'],
          },
        },
        memoryKeys: { type: 'array', items: { type: 'string' } },
        vaultPaths: { type: 'array', items: { type: 'string' } },
        agentId: { type: 'string' },
      },
      required: ['slug', 'name', 'role'],
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireAdv().registerProfile({
          agentId: session.agentId,
          sessionId: session.sessionId,
          slug: params.slug as string,
          name: params.name as string,
          role: params.role as string,
          contextPack: params.contextPack as string | undefined,
          skills: params.skills as Array<{ id: string; name: string; tags?: string[] }> | undefined,
          memoryKeys: params.memoryKeys as string[] | undefined,
          vaultPaths: params.vaultPaths as string[] | undefined,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_get_profile',
    description: 'Get a profile by its slug',
    parameters: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        agentId: { type: 'string' },
      },
      required: ['slug'],
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireAdv().getProfile({
          agentId: session.agentId,
          sessionId: session.sessionId,
          slug: params.slug as string,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_list_profiles',
    description: 'List all registered profiles',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
      },
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireAdv().listProfiles({
          agentId: session.agentId,
          sessionId: session.sessionId,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_find_profiles',
    description: 'Find profiles matching specific skills or tags',
    parameters: {
      type: 'object',
      properties: {
        skillTag: { type: 'string', description: 'Skill tag to match against profile skill tags' },
        agentId: { type: 'string' },
      },
      required: ['skillTag'],
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireAdv().findProfiles({
          agentId: session.agentId,
          sessionId: session.sessionId,
          skillTag: params.skillTag as string,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  // ── Goals (5) ──────────────────────────────────────────────

  api.registerTool({
    name: 'macp_ext_create_goal',
    description: 'Create a hierarchical goal (mission / project_goal / agent_goal)',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        type: { type: 'string', enum: ['mission', 'project_goal', 'agent_goal'] },
        parentGoalId: { type: 'string', description: 'Parent goal for nesting' },
        ownerAgentId: { type: 'string', description: 'Optional goal owner' },
        agentId: { type: 'string' },
      },
      required: ['title', 'type'],
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireAdv().createGoal({
          agentId: session.agentId,
          sessionId: session.sessionId,
          title: params.title as string,
          description: params.description as string | undefined,
          type: params.type as GoalType,
          parentGoalId: params.parentGoalId as string | undefined,
          ownerAgentId: params.ownerAgentId as string | undefined,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_list_goals',
    description: 'List goals, optionally filtered by type or status',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['mission', 'project_goal', 'agent_goal'] },
        status: { type: 'string', enum: ['active', 'completed', 'paused'] },
        ownerAgentId: { type: 'string' },
        agentId: { type: 'string' },
      },
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireAdv().listGoals({
          agentId: session.agentId,
          sessionId: session.sessionId,
          type: params.type as GoalType | undefined,
          status: params.status as GoalStatus | undefined,
          ownerAgentId: params.ownerAgentId as string | undefined,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_get_goal',
    description: 'Get a specific goal with ancestry and children',
    parameters: {
      type: 'object',
      properties: {
        goalId: { type: 'string' },
        agentId: { type: 'string' },
      },
      required: ['goalId'],
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireAdv().getGoal({
          agentId: session.agentId,
          sessionId: session.sessionId,
          goalId: params.goalId as string,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_update_goal',
    description: 'Update a goal title, description, or status',
    parameters: {
      type: 'object',
      properties: {
        goalId: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['active', 'completed', 'paused'] },
        progress: { type: 'string', description: 'Legacy alias for description' },
        agentId: { type: 'string' },
      },
      required: ['goalId'],
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireAdv().updateGoal({
          agentId: session.agentId,
          sessionId: session.sessionId,
          goalId: params.goalId as string,
          title: params.title as string | undefined,
          description:
            (params.description as string | undefined) ?? (params.progress as string | undefined),
          status: params.status as GoalStatus | undefined,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_get_goal_cascade',
    description: 'Get a goal with all children and linked tasks',
    parameters: {
      type: 'object',
      properties: {
        goalId: { type: 'string', description: 'Root goal ID (omit for all top-level)' },
        agentId: { type: 'string' },
      },
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireAdv().getGoalCascade({
          agentId: session.agentId,
          sessionId: session.sessionId,
          goalId: params.goalId as string | undefined,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  // ── Tasks (9) ──────────────────────────────────────────────

  api.registerTool({
    name: 'macp_ext_dispatch_task',
    description: 'Create and dispatch a task for agents to claim',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'], default: 'P1' },
        profileHint: { type: 'string', description: 'Suggested agent profile/role' },
        profileSlug: { type: 'string', description: 'Profile slug required by MACP advanced tasks' },
        goalId: { type: 'string', description: 'Link to a goal' },
        parentTaskId: { type: 'string', description: 'Parent task for nesting' },
        agentId: { type: 'string' },
      },
      required: ['title'],
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireAdv().dispatchTask({
          agentId: session.agentId,
          sessionId: session.sessionId,
          title: params.title as string,
          description: params.description as string | undefined,
          priority: ((params.priority as TaskPriority | undefined) ?? 'P1'),
          profileSlug:
            (params.profileSlug as string | undefined) ?? (params.profileHint as string | undefined),
          goalId: params.goalId as string | undefined,
          parentTaskId: params.parentTaskId as string | undefined,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_claim_task',
    description: 'Claim a pending task for this agent to work on',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        includeSubtasks: { type: 'boolean' },
        agentId: { type: 'string' },
      },
      required: ['taskId'],
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireAdv().claimTask({
          agentId: session.agentId,
          sessionId: session.sessionId,
          taskId: params.taskId as string,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_start_task',
    description: 'Mark a claimed task as in-progress',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        agentId: { type: 'string' },
      },
      required: ['taskId'],
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireAdv().startTask({
          agentId: session.agentId,
          sessionId: session.sessionId,
          taskId: params.taskId as string,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_complete_task',
    description: 'Mark a task as completed with a results summary',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        summary: { type: 'string', description: 'Summary of what was done' },
        result: { type: 'string', description: 'Result text stored with the task' },
        agentId: { type: 'string' },
      },
      required: ['taskId'],
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireAdv().completeTask({
          agentId: session.agentId,
          sessionId: session.sessionId,
          taskId: params.taskId as string,
          result: (params.result as string | undefined) ?? (params.summary as string | undefined),
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_block_task',
    description: 'Mark a task as blocked with a reason',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        reason: { type: 'string', description: 'Why the task is blocked' },
        agentId: { type: 'string' },
      },
      required: ['taskId'],
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireAdv().blockTask({
          agentId: session.agentId,
          sessionId: session.sessionId,
          taskId: params.taskId as string,
          reason: params.reason as string | undefined,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_cancel_task',
    description: 'Cancel a task',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        reason: { type: 'string' },
        agentId: { type: 'string' },
      },
      required: ['taskId'],
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireAdv().cancelTask({
          agentId: session.agentId,
          sessionId: session.sessionId,
          taskId: params.taskId as string,
          reason: params.reason as string | undefined,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_get_task',
    description: 'Get a specific task by ID',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        agentId: { type: 'string' },
      },
      required: ['taskId'],
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireAdv().getTask({
          agentId: session.agentId,
          sessionId: session.sessionId,
          taskId: params.taskId as string,
          includeSubtasks: params.includeSubtasks as boolean | undefined,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_list_tasks',
    description: 'List tasks, optionally filtered by state or assignee',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'accepted', 'in-progress', 'done', 'blocked', 'cancelled'] },
        profileSlug: { type: 'string' },
        priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
        assignedAgentId: { type: 'string' },
        goalId: { type: 'string' },
        limit: { type: 'number' },
        agentId: { type: 'string' },
      },
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireAdv().listTasks({
          agentId: session.agentId,
          sessionId: session.sessionId,
          status: params.status as TaskStatus | undefined,
          profileSlug: params.profileSlug as string | undefined,
          priority: params.priority as TaskPriority | undefined,
          assignedAgentId: params.assignedAgentId as string | undefined,
          goalId: params.goalId as string | undefined,
          limit: params.limit as number | undefined,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_archive_tasks',
    description: 'Archive done or cancelled tasks, optionally filtered by goal',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['done', 'cancelled'], default: 'done' },
        goalId: { type: 'string' },
        agentId: { type: 'string' },
      },
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireAdv().archiveTasks({
          agentId: session.agentId,
          sessionId: session.sessionId,
          status: params.status as ArchiveableTaskStatus | undefined,
          goalId: params.goalId as string | undefined,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  // ── Agent Lifecycle (3) ────────────────────────────────────

  api.registerTool({
    name: 'macp_ext_sleep_agent',
    description: 'Put an agent to sleep (keeps registration, pauses activity)',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        agentId: { type: 'string' },
      },
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireAdv().sleepAgent({
          agentId: session.agentId,
          sessionId: session.sessionId,
          reason: params.reason as string | undefined,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_deactivate_agent',
    description: 'Deactivate an agent (deregisters its session)',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        agentId: { type: 'string' },
      },
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireAdv().deactivateAgent({
          agentId: session.agentId,
          sessionId: session.sessionId,
          reason: params.reason as string | undefined,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_delete_agent',
    description: 'Permanently delete an agent and all associated state',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        agentId: { type: 'string' },
      },
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireAdv().deleteAgent({
          agentId: session.agentId,
          sessionId: session.sessionId,
          reason: params.reason as string | undefined,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  // ── Vault / Documents (4) ──────────────────────────────────

  api.registerTool({
    name: 'macp_ext_register_vault',
    description: 'Register a filesystem directory as an indexed document vault',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to index' },
        agentId: { type: 'string' },
      },
      required: ['path'],
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireAdv().registerVault({
          agentId: session.agentId,
          sessionId: session.sessionId,
          path: params.path as string,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_search_vault',
    description: 'Full-text search across indexed vault documents',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        limit: { type: 'number' },
        agentId: { type: 'string' },
      },
      required: ['query'],
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireAdv().searchVault({
          agentId: session.agentId,
          sessionId: session.sessionId,
          query: params.query as string,
          tags: params.tags as string[] | undefined,
          limit: params.limit as number | undefined,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_get_vault_doc',
    description: 'Retrieve a specific vault document by path',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        agentId: { type: 'string' },
      },
      required: ['path'],
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireAdv().getVaultDoc({
          agentId: session.agentId,
          sessionId: session.sessionId,
          path: params.path as string,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  api.registerTool({
    name: 'macp_ext_list_vault_docs',
    description: 'List all documents in registered vaults',
    parameters: {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
        limit: { type: 'number' },
        agentId: { type: 'string' },
      },
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = service.requireAdv().listVaultDocs({
          agentId: session.agentId,
          sessionId: session.sessionId,
          tags: params.tags as string[] | undefined,
          limit: params.limit as number | undefined,
        });
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });

  // ── Context Search (1) ─────────────────────────────────────

  api.registerTool({
    name: 'macp_ext_query_context',
    description: 'Unified search across memories, vault docs, tasks, and goals',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        sources: {
          type: 'array',
          items: { type: 'string', enum: ['memory', 'vault', 'tasks', 'goals'] },
          description: 'Restrict search to specific sources',
        },
        channelId: { type: 'string' },
        limit: { type: 'number', description: 'Max results per source' },
        agentId: { type: 'string' },
      },
      required: ['query'],
    },
    async execute(_id, params) {
      try {
        const session = service.resolveSession(params.agentId as string | undefined);
        const result = filterQueryContextSources(service.requireAdv().queryContext({
          agentId: session.agentId,
          sessionId: session.sessionId,
          query: params.query as string,
          channelId: resolveScopedChannelId(service, params.channelId),
          limit: params.limit as number | undefined,
        }), params.sources);
        return ok(result);
      } catch (e) { return err(String(e)); }
    },
  });
}
