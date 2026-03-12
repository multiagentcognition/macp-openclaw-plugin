---
name: macp-coordination
description: Coordinate with other AI agents working on this project via the MACP protocol
version: 0.1.0
metadata:
  openclaw:
    requires:
      config:
        - plugins.entries.macp-coordination.enabled
---

# Multi-Agent Coordination (MACP)

You are part of a team of AI agents coordinating in real-time via the MACP
protocol. Other agents — including IDE agents (Claude Code, Gemini CLI) and
other OpenClaw agents — may be working in parallel on related tasks in the
same project.

## Available tools

### Core protocol

| Tool | Purpose |
|------|---------|
| `macp_join_channel` | Join a broadcast channel |
| `macp_send_channel` | Broadcast to all agents in a channel |
| `macp_send_direct` | Message a specific agent |
| `macp_poll` | Check for incoming messages from peers |
| `macp_ack` | Acknowledge you have acted on a delivery |

### Awareness

| Tool | Purpose |
|------|---------|
| `macp_ext_list_agents` | See who else is online |
| `macp_ext_get_session_context` | Get detailed context for the current MACP session |

### File ownership

| Tool | Purpose |
|------|---------|
| `macp_ext_claim_files` | Signal which files you intend to edit |
| `macp_ext_release_files` | Release file claims when done |
| `macp_ext_list_locks` | See all active file claims |

### Shared memory

| Tool | Purpose |
|------|---------|
| `macp_ext_set_memory` | Store shared findings (scoped: agent/channel/workspace) |
| `macp_ext_get_memory` | Retrieve a specific memory by key |
| `macp_ext_search_memory` | Search shared knowledge across agents |
| `macp_ext_list_memories` | List all memories |
| `macp_ext_delete_memory` | Remove a memory entry |
| `macp_ext_resolve_memory` | Resolve conflicting memories by writing the chosen value |

### Profiles

| Tool | Purpose |
|------|---------|
| `macp_ext_register_profile` | Register a reusable role definition |
| `macp_ext_get_profile` | Get a profile by slug |
| `macp_ext_list_profiles` | List all profiles |
| `macp_ext_find_profiles` | Find profiles by skill tag |

### Goals

| Tool | Purpose |
|------|---------|
| `macp_ext_create_goal` | Create a hierarchical goal |
| `macp_ext_list_goals` | List goals |
| `macp_ext_get_goal` | Get a goal by ID |
| `macp_ext_update_goal` | Update goal title, description, or status |
| `macp_ext_get_goal_cascade` | Get goal with all children and linked tasks |

### Tasks

| Tool | Purpose |
|------|---------|
| `macp_ext_dispatch_task` | Create a task for another agent |
| `macp_ext_claim_task` | Pick up a pending task |
| `macp_ext_start_task` | Mark a claimed task as in-progress |
| `macp_ext_complete_task` | Mark a task done with results |
| `macp_ext_block_task` | Mark a task as blocked |
| `macp_ext_cancel_task` | Cancel a task |
| `macp_ext_get_task` | Get a task by ID |
| `macp_ext_list_tasks` | View the shared work queue |
| `macp_ext_archive_tasks` | Archive completed/cancelled tasks |

### Agent lifecycle

| Tool | Purpose |
|------|---------|
| `macp_ext_sleep_agent` | Put the current agent to sleep (keeps registration) |
| `macp_ext_deactivate_agent` | Deactivate the current agent (deregisters session) |
| `macp_ext_delete_agent` | Delete the current agent from workspace state |

### Vault / documents

| Tool | Purpose |
|------|---------|
| `macp_ext_register_vault` | Register a directory as indexed document store |
| `macp_ext_search_vault` | Full-text search across vault documents |
| `macp_ext_get_vault_doc` | Retrieve a specific document |
| `macp_ext_list_vault_docs` | List all vault documents |

### Context search

| Tool | Purpose |
|------|---------|
| `macp_ext_query_context` | Unified search across memories, docs, tasks, goals |

## Coordination guidelines

1. **Poll regularly.** Check for messages from peers before starting new work
   and after completing significant steps.

2. **Announce your work.** Send a channel message when you start a task so
   peers know what you are doing and can avoid duplication.

3. **Claim files before editing.** Use `macp_ext_claim_files` before modifying
   files to signal your intent. Release when done.

4. **Share findings via memory.** When you discover something useful (API
   endpoints, architecture decisions, bug root causes), store it in shared
   memory so other agents can find it.

5. **Use priority appropriately.**
   - `info` — status updates, findings, context
   - `advisory` — suggestions, non-urgent coordination
   - `steering` — direction changes, important decisions
   - `interrupt` — urgent: stop what you are doing and read this

6. **Acknowledge deliveries.** After acting on a message, call `macp_ack`
   so the sender knows it was processed.

7. **Dispatch tasks for parallel work.** If your current task can be
   decomposed, dispatch sub-tasks for other agents to claim.

8. **Use goals for structured planning.** Create a mission goal, break it
   into project goals, then agent goals linked to tasks.

9. **Index reference docs in the vault.** Register directories with
   `macp_ext_register_vault` so all agents can search shared documentation.

10. **Use query_context for broad searches.** When you need to find
    something across memories, docs, tasks, and goals at once.
