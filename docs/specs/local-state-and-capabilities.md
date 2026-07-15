# Local State and Capability Bootstrap

## Status

Implemented — 2026-07-15. The global-capability portion is superseded by
`provider-workflows-v2.md` now that one server can host multiple rooms.

## Problem

Pixel Crew currently learns slash commands and MCP server status from a
worker's `system/init` event. Claude CLI may not emit that event until the first
message, so a fresh worker shows no commands and `MCP 0/-`. Worker configuration
and event history are also lost when the server restarts.

## User stories

1. As a user, I can type `/` immediately after opening Cockpit and see known
   project/user commands without sending a throwaway prompt.
2. As a user, I can inspect MCP servers and their latest health immediately.
3. As a user, my workers, selected models, Claude session mapping and recent
   task history survive a server restart.
4. As a user, I see whether capability data is loading or cached rather than an
   ambiguous `0/-` value.

## Design

### Global capabilities

Capabilities are server-level state, independent of the active worker:

- Slash commands are discovered from Markdown files under the target repo and
  the user's `.claude/commands` directory.
- MCP servers are discovered with `claude mcp list`.
- A later Claude `system/init` event enriches this state with built-in/plugin
  commands, tool count and authoritative per-process MCP status.
- The latest state is cached in SQLite and sent in WebSocket snapshots. Refreshes
  are broadcast as `capabilities_updated` events.

### Persistence

The server uses a local SQLite database in `server/data/cockpit.sqlite` by
default. It stores:

- global capability cache per target repo;
- worker identity, model, colour and Claude session resume state;
- at most 2,000 recent runner events per worker.

MCP credentials, authorization headers and environment secrets are never
stored by Cockpit.

## Acceptance criteria

- A fresh page displays an explicit MCP loading/cached/updated state.
- Typing `/` before the first prompt shows discovered commands when command
  files exist.
- MCP servers returned by `claude mcp list` appear before the first prompt.
- Adding/removing MCP refreshes all connected clients.
- Workers and event history reappear after restarting the server.
- Server and web production builds pass.
- Existing message, model switch, interrupt and worker lifecycle flows continue
  to work.

## Non-goals

- Storing MCP secrets.
- Supporting multiple target repos in one running server.
- Unlimited event retention or cross-device synchronization.
