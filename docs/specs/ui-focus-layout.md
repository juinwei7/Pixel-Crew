# UI Focus Layout SDD

- Status: Accepted for implementation
- Date: 2026-07-15
- Scope: task log sizing, office viewport, NPC speech bubbles

## Problem

The task log is readable only at one fixed width, while the office keeps centering against the full browser even when the log covers its right side. With several active NPCs, persistent speech bubbles overlap each other and compete with the selected worker's result.

## Layout rules

1. The office stage keeps a stable viewport, scale, and center while the task log opens, closes, or changes width.
2. The task log is always an overlay. Covering part of the office is preferable to making desks and NPCs jump between layouts.
3. Task-log width is user controlled between 400px and the smaller of 860px or the available viewport.
4. Presets are Compact (420px), Reading (600px), and Wide (820px). Double-clicking the resize rail restores Reading width.
5. The chosen width is local UI preference data and is stored in `localStorage`; it is not written to the project or server database.

## Resize interaction

- The resize rail is attached to the log's left edge and has a larger invisible pointer target than its visible line.
- Dragging updates the CSS custom property without changing application data.
- Pointer release and cancellation always remove global listeners.
- Width is clamped again on window resize.

## Office viewport

- `GameCanvas` remains full-stage and is not resized in response to task-log UI state.
- Scene scale remains integer pixel scale and changes only with the actual browser viewport.
- The command bar remains browser-centered so its muscle memory does not change.

## Speech hierarchy

1. The selected NPC may show the full current speech bubble.
2. A non-selected busy NPC shows a one-line compact summary.
3. A non-selected idle NPC shows no speech bubble.
4. Subagent bubbles use the compact treatment.
5. Visible bubbles are placed selected-first. Each later bubble tries a short list of nearby offsets and selects the first rectangle that does not overlap an already placed bubble.
6. Nameplates keep their exact character anchor and are not moved by bubble collision handling.

## Accessibility and motion

- Resize controls are real buttons with labels and tooltips.
- The resize rail uses the standard horizontal-resize cursor.
- Panel and bubble layout transitions honor `prefers-reduced-motion`; layout correctness must not depend on animation.

## Acceptance criteria

1. Dragging the log changes its width and a reload restores it.
2. Opening, resizing, or closing the log does not move or rescale the office.
3. The log may cover the office and remains visually separated through its glass panel surface.
4. Idle background NPCs no longer render speech cards.
5. Selected and busy NPC bubbles avoid direct overlap when a nearby placement exists.
6. Existing Worker, task-log, approval, and avatar tests continue to pass.
