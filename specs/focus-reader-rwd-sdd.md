# Focus Reader RWD Recovery — SDD Specification

## Status

- Decision: approved for implementation from the user's request on 2026-08-31.
- Delivery: local verification only; do not commit or push.

## Problem

Focus Reader combines persistent user state with responsive layout. The normal
office intentionally auto-closes the task log when crossing into compact width,
but the same resize handler previously ran during Focus Reader. Shrinking the
window therefore hid the only report panel; widening it did not restore it and
left the user with a blank screen plus composer.

The new studio rail also adds a fourth desktop surface, so merely shrinking each
column causes unreadable report content at intermediate widths.

## Invariants

1. While `taskFocusMode` is true, `taskLogOpen` must be true. A resize, stale
   local preference, or hot reload may not hide the Focus Reader report.
2. Resize can change presentation only; it must not change the active workspace,
   active NPC, selected report, search scope, or composer target.
3. Each visible navigation surface owns a separate layout slot. No studio rail,
   report index, usage panel, or document canvas may overlap another surface.
4. A document area always has a positive usable height. It must never collapse
   to zero because a parent switches between grid and flex.

## Responsive matrix

| Width | Reader layout | Studio rail | Report index | Usage |
|---|---|---|---|---|
| >= 1500px | four columns | left vertical, collapsible | second vertical column | fixed right column |
| 1241–1499px | three columns | left vertical, collapsible | second vertical column | popover only |
| 841–1240px | normal vertical reading flow | first section; collapsed icons scroll horizontally, expanded cards wrap | disclosure below rail | popover only |
| 701–840px | vertical reading flow | same as medium | disclosure | popover; header controls wrap |
| <= 700px | vertical reading flow | horizontal compact strip | disclosure | full-width trigger/popup |

## Scope

- Guard Focus Reader against the office-only auto-collapse behavior.
- Encode and unit-test the width policy for the above matrix.
- Ensure narrow flow orders workspace selection before report navigation and
  content, with a non-zero report minimum height.
- Keep desktop workspaces, report index, document, and usage information in
  distinct grid columns.
- Preserve existing keyboard shortcuts and persisted studio-collapse preference.

## Out of scope

- Changing workspaces, NPC persistence, report contents, Git inspection, or
  provider usage data.
- Creating a different mobile navigation system or moving the composer.

## Acceptance criteria

- `shouldAutoCollapseTaskLog(..., true)` is always false when Focus Reader is
  active.
- A stale `taskLogOpen: false` is repaired immediately on entry to Focus Reader.
- Exact policy boundaries (1500, 1240, 840, and 700px) have unit coverage.
- Narrow DOM order is `studio rail → report index toggle → report → composer`.
- The content pane has a minimum height in narrow mode.
- Shrink across every breakpoint and return to desktop: header, report index,
  document, and composer remain visible; active worker and workspace are intact.
- `npm test -w web`, `npm run build -w web`, and `git diff --check` pass.

## Verification sequence

1. Enter Focus Reader with a completed report.
2. Resize from desktop through 1499, 1240, 840, and 700px, then back to desktop.
3. Repeat with studio rail expanded and collapsed.
4. Confirm document content and active NPC remain unchanged after each crossing.
5. Run the automated test/build/diff checks.
