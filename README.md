# @macp/openclaw-plugin

Native [MACP](https://github.com/multiagentcognition/macp) multi-agent coordination plugin for [OpenClaw](https://openclaw.ai).

Embeds the MACP protocol directly into the OpenClaw Gateway process, giving every agent real-time coordination with peers — both local OpenClaw agents and external IDE agents (Claude Code, Gemini CLI, Cursor, VS Code) on the same shared bus.

## Why this exists

OpenClaw already has multi-agent features. This plugin does not replace them — it fills a specific gap they cannot cover.

### The coordination model gap

OpenClaw's native inter-agent communication (`sessions_send`, `sessions_spawn`, `agentToAgent`) follows a **request-response** model. Agent A sends a message to Agent B, Agent B processes it, optionally replies for up to 5 ping-pong turns, then announces a result. This is **sequential** — one agent waits while the other works.

MACP is **real-time**. All agents run simultaneously and share a persistent message bus. There is no "turn" or "request-response cycle." Agent A broadcasts that it is editing `auth.ts`. Agent B sees this immediately on its next poll and avoids touching that file. Agent C dispatches a sub-task. Agent D picks it up. All of this happens concurrently, without any agent blocking or waiting for another.

| | OpenClaw Native | MACP |
|---|---|---|
| **Model** | Request-response (sequential turns) | Real-time shared bus (concurrent) |
| **Blocking** | Sender waits for receiver | No blocking — fire and observe |
| **Awareness** | Agent knows about the one it messaged | All agents see all channel traffic |
| **Scope** | Within one Gateway | Across Gateways + IDE agents |
| **Delivery** | Fire-and-forget text | Durable at-least-once with ACK |
| **Priority** | None | 4-tier with smart queue overflow |

### Cross-tool coordination

This is the primary use case. OpenClaw cannot coordinate with Claude Code, Gemini CLI, or other OpenClaw instances. The Gateway is the boundary. MACP breaks that boundary with a shared SQLite file — anyone who can open the file is on the bus.

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  OpenClaw    │    │  Claude Code │    │  Gemini CLI  │
│  Gateway     │    │              │    │              │
│  ┌────────┐  │    │  ┌────────┐  │    │  ┌────────┐  │
│  │Agent A │  │    │  │macp-mcp│  │    │  │macp-mcp│  │
│  │Agent B │  │    │  │ server │  │    │  │ server │  │
│  └───┬────┘  │    │  └───┬────┘  │    │  └───┬────┘  │
│  MACP plugin │    │      │       │    │      │       │
│  ┌───┴────┐  │    │      │       │    │      │       │
│  │MACPCore│──┼────┼──────┼───────┼────┼──────┘       │
│  └────────┘  │    │      │       │    │              │
└──────────────┘    └──────────────┘    └──────────────┘
        │                  │                    │
        └──────── shared .macp.db ──────────────┘
```

## Feature comparison with OpenClaw native

| Capability | OpenClaw Native | MACP Plugin | When to use MACP |
|---|---|---|---|
| **Agent messaging** | `sessions_send` — fire-and-forget text, up to 5 ping-pong turns | Durable bus with priority, TTL, ACK | When you need guaranteed delivery or real-time broadcast |
| **File locking** | `lock_file`/`unlock_file` — blocking checkout, stale lock bugs possible | Advisory claims with TTL auto-expiry | When you need self-healing locks or cross-tool visibility |
| **Shared memory** | LanceDB vectors + `SHARED_KNOWLEDGE.json` | Scoped (agent/channel/workspace), layered, cascading reads | When multiple tools need shared findings |
| **Task management** | `TASKS.json` (static RACI) | Full lifecycle: dispatch → claim → start → complete/block/cancel | When you need a live work queue, not a static list |
| **Goal tracking** | `SPRINT_CURRENT.json` (manual) | Hierarchical: mission → project_goal → agent_goal | When you need structured planning with progress tracking |
| **Sub-agent spawning** | `sessions_spawn` — isolated, tool-restricted, announce-back | Not provided | Use OpenClaw's — MACP coordinates peers, not children |
| **Routing** | Deterministic bindings: channel × account × peer → agent | Named channels, join/leave | Use OpenClaw's for inbound routing, MACP for coordination |
| **Context engine** | Pluggable `ContextEngine` (bootstrap/ingest/assemble/compact) | Poll-based injection via hook | Use OpenClaw's for deep context management |
| **Concurrency** | `maxConcurrentRuns`, lane queues, session serialization | None | Use OpenClaw's for back-pressure |
| **Cross-tool** | Not possible | Shared SQLite bus with any MACP-compatible agent | The reason this plugin exists |
| **Audit trail** | None for coordination | Full delivery/ACK audit with reason codes | When you need to trace what happened |
| **Profiles** | `SOUL.md` per agent (freeform) | Structured role definitions, searchable by skill | When agents need to discover each other's capabilities |

### Where OpenClaw native is better

- **Sub-agent spawning** — `sessions_spawn` with isolation and tool restrictions is deeper than anything MACP offers
- **Inbound routing** — binding system handles multi-channel, multi-account message routing at production scale
- **Context engine** — `ContextEngine` plugin interface is architecturally cleaner for context lifecycle management
- **Concurrency control** — lane queues and `maxConcurrentRuns` handle back-pressure; MACP doesn't

### Where MACP adds what OpenClaw cannot do

- **Real-time coordination** — concurrent shared awareness, not sequential request-response
- **Cross-tool bus** — IDE agents and multiple OpenClaw instances on the same channel
- **Structured task/goal lifecycle** — live dispatch/claim/complete beats static JSON files
- **Durable delivery** — at-least-once with ACK vs fire-and-forget
- **Self-healing file claims** — TTL auto-expiry eliminates stale locks

### Overlap guidance

Some features exist in both systems. Use this rule:

- **Need cross-tool visibility?** → Use MACP (`macp_ext_*` tools)
- **OpenClaw-only, within one Gateway?** → Use OpenClaw native (`sessions_send`, `lock_file`, etc.)

The plugin does not disable or replace any OpenClaw native features.

## Install

```bash
openclaw plugins install @macp/openclaw-plugin
```

## Configure

Minimal — add to `openclaw.json`:

```json5
{
  "plugins": {
    "enabled": true,
    "allow": ["macp-coordination"],
    "entries": {
      "macp-coordination": {
        "enabled": true,
        "config": {
          "projectId": "my-project"
        }
      }
    }
  }
}
```

Full options:

```json5
{
  "plugins": {
    "enabled": true,
    "allow": ["macp-coordination"],
    "entries": {
      "macp-coordination": {
        "enabled": true,
        "config": {
          // Identity
          "projectId": "my-project",

          // Storage — shared location so external agents can access
          "dbPath": "~/.macp/projects/my-project.macp.db",

          // Channels
          "defaultChannel": "general",

          // Context injection (polls on-demand at bootstrap, off by default)
          "autoPollInject": false,

          // Channel bridge (forward WhatsApp/Slack/Telegram → MACP bus)
          "bridgeChannels": false,
          "bridgeChannelPriority": 0
        }
      }
    }
  }
}
```

## What happens on startup

1. Gateway starts → plugin opens the shared SQLite DB
2. Each OpenClaw agent bootstraps → auto-registered with MACP, joins default channel, announces presence
3. If `autoPollInject` is enabled, the bootstrap hook polls on-demand and injects deliveries as a `<macp-deliveries>` block
4. Agents use MACP tools during their turns (send, claim files, dispatch tasks, poll, etc.)
5. Gateway stops → tracked agents deregister and the DB closes cleanly

## Tools (42 exposed)

The plugin exposes 42 MACP tools to OpenClaw agents:

**Core protocol (5)** — `macp_join_channel`, `macp_send_channel`, `macp_send_direct`, `macp_poll`, `macp_ack`

**Awareness (2)** — `macp_ext_list_agents`, `macp_ext_get_session_context`

**File ownership (3)** — `macp_ext_claim_files`, `macp_ext_release_files`, `macp_ext_list_locks`

**Shared memory (6)** — `macp_ext_set_memory`, `macp_ext_get_memory`, `macp_ext_search_memory`, `macp_ext_list_memories`, `macp_ext_delete_memory`, `macp_ext_resolve_memory`

**Profiles (4)** — `macp_ext_register_profile`, `macp_ext_get_profile`, `macp_ext_list_profiles`, `macp_ext_find_profiles`

**Goals (5)** — `macp_ext_create_goal`, `macp_ext_list_goals`, `macp_ext_get_goal`, `macp_ext_update_goal`, `macp_ext_get_goal_cascade`

**Tasks (9)** — `macp_ext_dispatch_task`, `macp_ext_claim_task`, `macp_ext_start_task`, `macp_ext_complete_task`, `macp_ext_block_task`, `macp_ext_cancel_task`, `macp_ext_get_task`, `macp_ext_list_tasks`, `macp_ext_archive_tasks`

**Agent lifecycle (3)** — `macp_ext_sleep_agent`, `macp_ext_deactivate_agent`, `macp_ext_delete_agent`

**Vault (4)** — `macp_ext_register_vault`, `macp_ext_search_vault`, `macp_ext_get_vault_doc`, `macp_ext_list_vault_docs`

**Context search (1)** — `macp_ext_query_context`

Additionally, 3 MACP lifecycle operations are handled automatically by the plugin host and are not exposed as agent tools: `register`, `deregister`, and `get_instructions`.

## Channel bridge

When `bridgeChannels: true`, the plugin forwards human messages from OpenClaw messaging channels (WhatsApp, Slack, Telegram, etc.) into the MACP bus on a `bridge:human` channel. This gives external IDE agents awareness of human conversations without any manual forwarding.

## Status command

```
/macp
```

Shows project ID, default channel, online agents, and bridge status.

## Architecture

```
src/
├── index.ts      # Plugin entry — registers service, tools, hooks, command
├── service.ts    # MACPService — lifecycle, poll loop, context injection
├── tools.ts      # 42 exposed tool registrations
├── bridge.ts     # MACPChannelBridge — messaging platforms → MACP bus
└── types.ts      # PluginConfig, AgentSession, OpenClaw API types

skills/
└── macp-coordination/
    └── SKILL.md  # Full tool reference + coordination guidelines for LLMs
```

The plugin imports `macp-mcp` as a dependency and uses `MacpCore`, `MacpWorkspaceExtensions`, and `MacpWorkspaceExtensionsAdvanced` as in-process libraries. No MCP server process is spawned. No MACP protocol code is copied or modified.

## Requirements

- Node.js >= 22.0.0
- OpenClaw >= 2026.1.0
- `macp-mcp` >= 2.1.0

## License

MIT
