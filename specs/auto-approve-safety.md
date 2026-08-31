# Auto-approve safety and transparency

## Problem

The `invincible` auto-approve mode can be selected in either the primary top
bar or the focused-reading control panel. It persists for the NPC and permits
all actions, including destructive shell commands. The previous interaction
sent the change immediately. In addition, the UI description of `full` did
not make clear that non-Bash actions, including MCP actions, are approved.

## Scope

This change improves the client-side decision point. It does not remove an
explicitly requested advanced mode or change the server's approval policy.

## Acceptance criteria

1. Selecting `invincible` from either control must not call the mode-update
   API until the user explicitly confirms in a modal.
2. The modal must identify the affected NPC and workspace, explain that all
   approvals (including destructive shell and MCP actions) are skipped, and
   be keyboard-accessible. Cancelling or pressing Escape changes nothing.
3. Confirming sends the mode update for the originally selected NPC, even if
   the active NPC changes while the modal is open.
4. When an NPC is unrestricted, both the normal and narrow top-bar controls
   expose a one-click action to return to `safe`; focused-reading controls do
   the same.
5. Descriptions of `full` accurately say that file changes and MCP actions
   can be auto-approved; only known-dangerous Bash commands remain blocked.
6. The policy decision has unit coverage, and existing web tests/build remain
   green.

## Non-goals

- This is not server-side authorization for a hostile local caller. Pixel
  Crew remains a local-first tool and the server already owns enforcement.
- This does not change existing sessions or automatically reset an
  intentionally selected mode.
