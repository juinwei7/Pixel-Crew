# Provider Workflows V2

## Status

Accepted for implementation — 2026-07-15

## Context

Pixel Crew can manage Claude project commands in `.claude/commands` and Codex
repo skills in `.agents/skills`. The first version intentionally exposes the
Markdown documents directly, but five gaps remain:

1. a failed or stalled HTTP request can leave an editor stuck in a pending state;
2. capability state is global even when workers belong to different rooms;
3. edits made in Finder, VS Code, Git or another process do not refresh the UI;
4. users must understand frontmatter before they can safely edit a workflow;
5. testing a saved workflow requires closing the editor and manually invoking it.

## Goals

- Isolate capability state by canonical workspace path and provider.
- Keep the command palette, MCP panel and workflow library synchronized with
  local filesystem changes.
- Provide structured fields for common metadata while preserving a raw
  Markdown mode for advanced users.
- Make every workflow request terminate with success, a useful error, or a
  client-side timeout.
- Allow a saved workflow to be invoked on an idle, compatible NPC from the
  workflow editor.

## Non-goals

- Cloud synchronization or collaborative editing.
- Executing unsaved workflow content.
- Converting Claude commands to Codex skills automatically.
- Managing user-level `~/.claude/commands` or global Codex skills.
- Replacing the existing task log with a second execution view.

## User stories

1. When I switch rooms, MCP and slash-command state belongs to that room.
2. When a workflow file changes outside Pixel Crew, an open library refreshes
   without reloading the browser.
3. I can edit name, description and supported metadata without hand-writing
   YAML delimiters.
4. I can switch to raw Markdown without losing unknown frontmatter keys.
5. I can select an idle NPC in the same room and provider and run the saved
   workflow with optional arguments.
6. If the server disconnects, the editor exits its pending state and explains
   what failed.

## Architecture

### Capability registry per room

The server owns one registry instance per canonical workspace path:

```text
workspace path
  ├─ Claude CapabilityRegistry
  └─ Codex CapabilityRegistry
```

WebSocket snapshots contain `capabilitiesByWorkspace`, keyed by canonical path.
Updates include both `workspacePath` and `provider`. The client derives the
header, command palette and MCP panel state from the active NPC's room.

Claude runner allow-rules are resolved from the registry for that runner's
workspace. A worker meta event enriches only its own room.

### Filesystem synchronization

The server polls managed workspace libraries every 1.5 seconds. Polling is used
instead of recursive `fs.watch` because recursive watcher behavior differs
between macOS, Windows and Linux. A fingerprint consists only of workflow name
and modification time, so file contents are not retained by the watcher.

When a fingerprint changes, the server:

1. broadcasts `workflow_library_updated` with workspace and provider;
2. refreshes Claude disk commands without waiting for MCP discovery;
3. restarts only idle Claude workers in the affected room so the next request
   sees the new command.

Codex is turn-based and reads repo skills on each invocation, so no idle process
restart is needed for a Skill-only change.

### Structured document editing

Workflow documents are parsed as YAML frontmatter plus a Markdown body.
Structured mode owns the common fields:

- Claude: `description`, `argument-hint`, `allowed-tools`, `model`;
- Codex: `name`, `description`.

Unknown frontmatter keys are preserved. Updating a structured field rewrites
the frontmatter and leaves the Markdown body unchanged. Raw mode edits the full
document. Invalid YAML is shown as an editor error and cannot be saved from
structured mode; raw mode remains available for repair.

### Request lifecycle

Workflow UI requests use one helper with:

- JSON parsing and server error extraction;
- an `AbortController` timeout;
- normalized offline/timeout messages;
- `finally` cleanup at each pending call site.

Default timeout is 15 seconds. Native folder selection keeps its longer server
timeout and is outside this change.

### Test run

The editor receives compatible NPC summaries from `App`. A target is compatible
when it has the same canonical workspace, the same provider and is not busy.
Only saved, clean workflows can run.

- Claude invocation: `/<command> <optional arguments>`
- Codex invocation: `$<skill> <optional task context>`

Execution uses the existing worker message endpoint. On success the selected
NPC becomes active while the workflow editor remains open and reports that the
task was dispatched.

## Protocol changes

### WebSocket snapshot

```ts
{
  type: "snapshot";
  capabilitiesByWorkspace: Record<string, Record<ProviderId, CapabilityState>>;
}
```

### Capability update

```ts
{
  type: "capabilities_updated";
  workspacePath: string;
  provider: ProviderId;
  capabilities: CapabilityState;
}
```

### Workflow library update

```ts
{
  type: "workflow_library_updated";
  workspacePath: string;
  provider: ProviderId;
  revision: number;
}
```

Existing HTTP endpoints remain compatible. MCP mutation requests add an
optional `workspacePath`; when omitted they use the configured default room.

## Failure and consistency rules

- External changes are eventually consistent within two seconds.
- Dirty editors are never silently overwritten. A filesystem update marks the
  library as changed and offers reload; clean editors reload automatically.
- A request timeout does not imply that a filesystem write was rolled back.
  The editor reloads the library before allowing a retry after an ambiguous
  failure.
- No watcher or editor follows symlinks outside the managed workspace.
- Test run never sends unsaved content.

## Acceptance criteria

- Two workers in different rooms can show different Claude slash commands.
- A command created externally appears in an open clean library within two seconds.
- External changes do not replace dirty editor text.
- Multiline YAML descriptions parse and round-trip without losing unknown keys.
- Save/delete network failures clear the pending state and show an actionable error.
- A saved Claude command or Codex skill can be sent to a compatible idle NPC.
- Server and web tests and production builds pass.

## Test strategy

- Unit tests for per-room registry isolation and frontmatter round-tripping.
- Unit tests for local workflow fingerprints and symlink rejection.
- Component tests for structured/raw mode and compatible test targets.
- Regression tests for existing runner event normalization and task logs.
- Production TypeScript and Vite builds.

## Delivery sequence

1. Request helper and per-workspace capability protocol.
2. Workflow polling and revision events.
3. Structured editor and YAML validation.
4. Compatible NPC test-run controls.
5. Full regression verification.
