## Terminal Behaviour

This note documents the ownership rules for terminal behaviour after the refactor.

### Durable vs ephemeral state

- The persisted workspace owns durable document state: node bounds, layout mode, viewport presets, backend metadata, and terminal metadata.
- Local canvas UI state owns ephemeral interaction state: selected node, focus auto-focus timing, node interaction timestamps, and in-progress viewport interaction.
- Server session snapshots remain the source of truth for PTY status, scrollback, snapshot dimensions, and runtime connectivity.

### Focus ownership

- Focusing a node selects it and may animate the viewport.
- Focus does not resize or rewrite node bounds.
- Focus-tiles selection is still local UI state; it does not persist a derived layout back into the workspace.

### Resize ownership

- A focused interactive terminal surface is the only PTY resize owner.
- Read-only previews never emit `terminal.resize`.
- Read-only previews render from snapshot dimensions supplied by the session snapshot.

### Preview ownership

- `terminalSurfaceModel.ts` is the single module that decides whether a terminal renders as `interactive`, `live-preview`, or `summary`.
- `useXtermSurfaceController.ts` owns xterm lifecycle, renderer setup, fit scheduling, scroll replay, stickiness, and event shielding.
- Background previews must preserve the same live-preview rendering style as focused terminals while output is streaming.

### Layout behaviour

- Free-layout bounds are the durable source of truth.
- Focus-tiles is a derived render-time layout only.
- Leaving focus-tiles returns the canvas to the persisted free-layout bounds instead of writing tile positions back into workspace data.
