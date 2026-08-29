# Unified Theme Shell — SDD Specification

## Problem

Pixel and Modern currently share the same application state but do not present it as one product: the pixel controls retain a dark neon visual system while Modern places a light 3D scene behind them. The result makes the central workspace feel disconnected and leaves a failed WebGL canvas as an empty white area.

## Goal

Keep one information architecture across both themes while changing only the visual language of the scene and surfaces.

The common interaction path is always:

`crew member → current work → task log → command composer`

## Scope

### In scope

- A shared visual-shell contract for the existing TopBar, WorkerTabs, task-log panel, and command composer.
- Pixel keeps its dark neon / game-world styling.
- Modern uses a calm light workbench surface, with the same placement, controls, status semantics, and keyboard interactions.
- Modern's 3D scene remains optional background context; it must not be the only place that communicates task state.
- WebGL disposal must never force a context loss during React cleanup or hot reload.
- A development server must never remain running after its HTTP listener has stopped.

### Out of scope

- Changing agents, task persistence, server APIs, keyboard shortcuts, or worker lifecycle.
- Rebuilding the 3D model, replacing Three.js, or changing the pixel-world renderer.
- Migrating unrelated existing UI styles.

## UX requirements

1. The TopBar, crew rail, task log, and composer occupy the same screen locations in both themes.
2. Selected worker, running, completed, approval-needed, and failed states remain distinguishable in both themes without relying solely on color.
3. Modern surfaces are opaque enough for task text to be readable over the 3D scene.
4. Theme switching does not leave a blank scene because a renderer was deliberately context-lost.
5. Narrow layouts retain the existing responsive panel behavior.

## Acceptance criteria

- Switching `像素 ↔ 現代` preserves the active worker, open task-log state, and composer target because it only changes the visual theme.
- Modern root has light color scheme, light chrome, and readable dark text; pixel root keeps its current dark color scheme.
- Existing functional controls in TopBar, WorkerTabs, QuestLog, and TaskComposer keep their component contracts unchanged.
- `renderer.forceContextLoss()` is not called from Office3D cleanup.
- If the HTTP listener closes or emits an error outside a planned shutdown, the server writes a local lifecycle entry and exits non-zero.
- The development supervisor relaunches a stopped backend with a bounded retry delay; `SIGINT` and `SIGTERM` remain clean, intentional stops.
- A missing or invalid webshot Chrome executable returns a request error only; it must not terminate the Pixel Crew server.
- Fatal shutdown has a bounded exit deadline so a stuck WebSocket cleanup cannot leave an API-less watcher process behind.
- `npm test -w server` covers the retry policy and runtime-log behavior.
- `npm test -w web`, `npm run build -w web`, and `git diff --check` pass.

## Implementation plan

1. Define Modern-only overrides beneath `.game-root--modern` for shared shell tokens and surfaces.
2. Apply those overrides to the TopBar, crew rail, task-log panel, task-log controls, and command composer.
3. Ensure Office3D exposes a stable class for its own visual surface and keeps the already-fixed normal disposal lifecycle.
4. Add a focused regression test for the no-forced-context-loss invariant.
5. Build, test, then restart the local development service and check `/healthz` plus provider authentication.
6. Keep the existing WebSocket reconnect banner, but make the backend fail fast instead of leaving it permanently reconnecting.

## Risks and mitigations

- **Readability over the 3D scene:** use solid / high-opacity Modern surfaces, not translucent glass.
- **Theme CSS leaking into pixel mode:** every new light override is scoped by `.game-root--modern`.
- **Renderer lifecycle regressions:** retain `renderer.dispose()` and verify the source never calls `forceContextLoss()`.
- **Half-dead development process:** the listener's `close`/`error` events are observable, persisted to the private app-data directory, and cause supervisor recovery.
- **Platform-specific screenshot binary:** Chrome discovery is platform-aware and asynchronous spawn errors are contained by the webshot request.
