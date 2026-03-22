# Terminal Behaviour Refactor Plan

## Purpose

This document is a self-contained handoff for refactoring terminal behaviour in this repository.

The problem area is terminal behaviour around:

- focus changes
- node resizing
- viewport movement
- presentation-mode changes
- live preview vs interactive terminal rendering
- PTY size synchronization

This area has become fragile because multiple subsystems currently share responsibility for behaviour that should have a single owner.

This plan is intended to be executable from empty context later. It includes:

- background on the current architecture
- diagnosis of why regressions happen
- target architecture and invariants
- a staged PR plan
- file-level guidance
- validation criteria

## Repository Context

Relevant runtime boundaries:

- `src/server/pty/`: PTY session lifecycle, output handling, resize calls, snapshots
- `src/server/runtime/`: local/remote backend unification
- `src/server/ws/`: websocket transport
- `src/shared/`: workspace schema, session schema, shared types
- `src/web/state/`: workspace persistence state and session transport state
- `src/web/canvas/`: React Flow canvas, viewport handling, layout strategies
- `src/web/terminals/`: terminal rendering and presentation logic

## Why This Area Is Fragile

The core issue is architectural: terminal focus and resize behaviour is not owned by a single state machine.

A single user action such as "focus this terminal" or "resize this node" can affect all of the following:

- persisted workspace state
- local React state in the app
- canvas viewport state
- layout-mode state
- node rendered bounds
- xterm instance lifecycle
- websocket session state
- server PTY size state
- remote backend state

That means many bug fixes are local improvements that break a neighbouring layer.

## Current Structural Problems

### 1. No single size authority

There is no single owner for terminal size.

Current actors:

- node bounds in the workspace
- measured DOM size in the browser
- xterm render size in the browser
- PTY `cols` and `rows` in the server session snapshot
- read-only preview logic that can intentionally render using old PTY columns while requesting a future backend resize

Key files:

- `src/server/pty/ptySessionManager.ts`
- `src/server/pty/sessionSnapshot.ts`
- `src/web/terminals/TerminalFocusSurface.tsx`

### 2. TerminalSurface has too many responsibilities

`TerminalSurface` currently owns or partly owns:

- xterm mount/unmount
- renderer fallback
- terminal fit logic
- cell measurement
- debounced backend resize
- read-only vs interactive behaviour
- focus restoration
- scroll stickiness
- event shielding from the canvas
- scrollback replay and reset handling

This makes it very hard to modify one behaviour without affecting others.

Key file:

- `src/web/terminals/TerminalFocusSurface.tsx`

### 3. Focus is coupled to resize

Focusing a terminal can currently:

- select the node
- animate the viewport
- change autofocus timing
- enlarge the node to minimum focus dimensions

That means focus behaviour is not just focus behaviour. It is also resize behaviour.

Key files:

- `src/web/canvas/focus.ts`
- `src/web/app/App.tsx`

### 4. The canvas viewport is an implicit state machine

`WorkspaceCanvas` currently carries a fairly complex viewport interaction model:

- current canvas viewport
- last committed viewport
- pending viewport commit
- awaiting server/local reconciliation
- whether the viewport is being interacted with
- interaction with external workspace refreshes

This is why stale viewport commit bugs appear repeatedly.

Key file:

- `src/web/canvas/WorkspaceCanvas.tsx`

### 5. Presentation mode is derived from several overlapping concepts

Terminal presentation is effectively decided by a mix of:

- persisted selection
- layout mode
- semantic zoom
- recent interaction timestamps
- recent output timestamps
- live preview budget
- whether a session exists yet

This means background output can indirectly change rendering topology.

Key files:

- `src/web/terminals/presentationMode.ts`
- `src/web/terminals/TerminalPlaceholderNode.tsx`
- `src/web/canvas/flow.ts`

### 6. Focus-tiles introduces a second bounds system

In focus-tiles mode there is a distinction between:

- persisted workspace bounds
- rendered layout bounds

There is also write-back logic on mode switch. This increases the chance of losing user-authored layout intent.

Key files:

- `src/web/canvas/WorkspaceCanvas.tsx`
- `src/web/canvas/layout/focusTilesLayoutStrategy.ts`

### 7. The browser terminal is a reconstructed mirror, not the source of truth

Client rendering is based on:

- scrollback text snapshots
- incremental diff heuristics

It is not a direct remote terminal protocol stream with an authoritative client-side terminal state.

This makes remounts, resize timing, and reset timing more sensitive.

Key files:

- `src/web/terminals/incrementalWrite.ts`
- `src/web/state/useTerminalSessions.ts`

### 8. There is conceptual drift from earlier refactors

There are signs that some abstractions no longer reflect the active architecture:

- semantic zoom still exists as a shared concept
- some preview-selection logic remains but is not the main active path
- an older text-preview implementation still exists

This makes it easier to accidentally fix an obsolete abstraction.

Key files:

- `src/shared/workspace.ts`
- `src/web/terminals/TerminalScrollPreview.tsx`

## Key Design Principles For The Refactor

### 1. Separate durable state from ephemeral UI state

Persisted workspace data should only include state that must survive reloads or synchronize across clients.

Good candidates for persisted state:

- node bounds
- terminal metadata
- layout mode
- camera presets
- backend configuration

Good candidates for local UI state:

- selected node
- focus timing
- recent interaction timestamps
- active viewport gesture state
- transient preview budgeting

### 2. A terminal must have one resize owner

At any given time, exactly one surface should be allowed to request PTY resize for a session.

Preferred model:

- focused interactive surface owns PTY resize
- unfocused previews never request PTY resize
- previews render using snapshot dimensions

### 3. Focus should not mutate node size

Selection and focus should not implicitly resize the node.

If the product needs "focus and enlarge", that should be an explicit separate feature. It should not be the default meaning of focus.

### 4. Focus-tiles should be a derived layout, not a bounds rewrite

Focus-tiles should render nodes in derived positions without overwriting the user-authored free-layout bounds.

### 5. Presentation decisions should come from one explicit model

There should be one module that decides whether a terminal is rendered as:

- interactive live terminal
- read-only live preview
- summary card

That decision should not be distributed across several components.

## Target End State

### Ownership model

- `workspace` owns durable document state
- `session snapshots` own server/runtime truth
- `canvas UI state` owns local selection, recency, and viewport interaction
- `terminal surface controller` owns xterm lifecycle and size policy

### Behaviour model

- focusing a terminal selects it and optionally animates the viewport
- focusing does not change persisted node bounds
- only one surface may emit `terminal.resize` for a terminal
- read-only previews remain visually live while output streams
- focus-tiles is derived rendering only
- external workspace refreshes do not clobber in-progress local viewport interaction

## Non-Negotiable Invariants

These invariants should hold throughout the refactor:

- one terminal, one interactive xterm, one PTY resize owner
- focusing an inspect preview must not remount the xterm
- unfocused live previews must preserve the same live-preview rendering style as focused terminals while output is streaming
- switching layout modes must not destroy free-layout bounds
- server workspace refreshes must not recommit stale local viewport state
- local and remote terminals must behave the same at the UI layer

## Relevant Files

Core files most likely to change:

- `src/web/terminals/TerminalFocusSurface.tsx`
- `src/web/terminals/TerminalPlaceholderNode.tsx`
- `src/web/terminals/presentationMode.ts`
- `src/web/terminals/types.ts`
- `src/web/terminals/incrementalWrite.ts`
- `src/web/canvas/WorkspaceCanvas.tsx`
- `src/web/canvas/flow.ts`
- `src/web/canvas/focus.ts`
- `src/web/canvas/layout/focusTilesLayoutStrategy.ts`
- `src/web/app/App.tsx`
- `src/web/state/useWorkspace.ts`
- `src/web/state/workspaceActions.ts`
- `src/web/state/useTerminalSessions.ts`
- `src/shared/workspace.ts`
- `src/shared/terminalSessions.ts`

Core files likely not requiring protocol changes at first:

- `src/server/ws/registerWorkspaceSocket.ts`
- `src/server/pty/ptySessionManager.ts`
- `src/server/pty/sessionSnapshot.ts`
- `src/server/runtime/backendRuntimeManager.ts`

## PR Sequence

The sequence matters. Do not skip ahead unless earlier steps are already completed.

### PR1: Characterization Tests

Goal:

Lock current intended behaviour with tests before changing ownership boundaries.

Files to update:

- `src/web/terminals/TerminalFocusSurface.test.ts`
- `src/web/terminals/TerminalPlaceholderNode.test.ts`
- `src/web/canvas/WorkspaceCanvas.test.ts`
- `src/web/canvas/layout/focusTilesLayoutStrategy.test.ts`
- `src/web/state/useTerminalSessions.test.ts`

Add tests for:

- inspect preview becomes focused without remounting xterm
- focused terminal keeps typing correctly while output is streaming
- focused terminal resize emits backend resize
- read-only preview does not become a second resize owner
- stale external viewport refresh does not recommit a local viewport
- focus-tiles selection swaps preserve correct center/side behaviour
- layout-mode switch does not lose user-authored free-layout bounds
- remote sessions follow the same client rendering rules

Exit criteria:

- test suite explicitly covers the known regression classes
- no production code restructuring yet unless strictly required for testability

### PR2: Extract Viewport Controller

Goal:

Move the viewport interaction state machine out of `WorkspaceCanvas`.

Create:

- `src/web/canvas/useCanvasViewportController.ts`

Move from `WorkspaceCanvas` into the controller:

- `canvasViewport`
- `lastCommittedViewport`
- `pendingViewportCommitRef`
- `isAwaitingViewportCommit`
- `isViewportInteracting`
- `onViewportChange`
- `onMoveStart`
- `onMoveEnd`
- `onReactFlowViewportChange`

Keep `WorkspaceCanvas` responsible only for wiring the controller into React Flow.

Exit criteria:

- `WorkspaceCanvas` no longer contains the viewport state machine inline
- existing viewport tests still pass unchanged

### PR3: Split Canvas UI State From Persisted Workspace

Goal:

Remove ephemeral UI state from persistence ownership.

Create:

- `src/web/canvas/useCanvasUiState.ts`

Move into local UI state:

- selected node
- focus autofocus timing
- node interaction timestamps

Refactor:

- `src/web/app/App.tsx`
- `src/web/state/useWorkspace.ts`
- `src/web/state/workspaceActions.ts`
- `src/shared/workspace.ts`

Notes:

- During migration, `workspace.selectedNodeId` can remain as compatibility data if needed, but it should stop being the main active UI source of truth.
- Do not break loading old workspaces.

Exit criteria:

- selecting a node no longer immediately persists workspace data
- local UI state survives internal re-renders without requiring workspace writes

### PR4: Introduce One Explicit Terminal Presentation Model

Goal:

Make one module responsible for deciding how each terminal is presented.

Create:

- `src/web/terminals/terminalSurfaceModel.ts`

This module should explicitly derive something like:

- `interactive`
- `live-preview`
- `summary`

It should use:

- local UI selection
- session existence
- preview budget
- layout mode
- recency

Refactor:

- `src/web/terminals/presentationMode.ts`
- `src/web/terminals/TerminalPlaceholderNode.tsx`
- `src/web/canvas/flow.ts`
- `src/web/terminals/types.ts`

Exit criteria:

- `TerminalPlaceholderNode` no longer decides live-vs-summary through multiple local boolean combinations
- there is one explicit rendering-mode model for terminals

### PR5: Extract Xterm Surface Controller

Goal:

Reduce `TerminalSurface` to a thin component by moving xterm lifecycle policy into a dedicated controller.

Create:

- `src/web/terminals/useXtermSurfaceController.ts`

Move controller responsibilities out of `TerminalFocusSurface.tsx`:

- terminal mount/unmount
- renderer setup and fallback
- fit scheduling
- cell-size measurement
- scroll stickiness
- focus restoration
- scrollback replay/reset
- event shielding hooks

Replace the current prop contract:

- `readOnly`
- `syncPtySize`
- `ptyCols`

With a more explicit one:

- `interactionMode: 'interactive' | 'read-only'`
- `sizeSource: 'measured' | 'snapshot'`
- `resizeAuthority: 'owner' | 'none'`

Exit criteria:

- `TerminalFocusSurface.tsx` becomes thin
- behaviour remains equivalent under existing tests

### PR6: Enforce Single PTY Resize Authority

Goal:

Remove the current dual-authority resize path.

Desired rule:

- focused interactive terminal surface owns PTY resize
- unfocused live previews never send `terminal.resize`
- previews render using snapshot `cols/rows`

Refactor:

- `src/web/terminals/TerminalFocusSurface.tsx`
- `src/web/terminals/TerminalPlaceholderNode.tsx`
- `src/web/terminals/terminalSurfaceModel.ts`

Prefer not to change server protocol yet.

Server can remain as-is:

- `src/server/ws/registerWorkspaceSocket.ts`
- `src/server/pty/ptySessionManager.ts`

Exit criteria:

- there is exactly one codepath that emits `terminal.resize` for an active terminal
- read-only resize debounce logic is removed

### PR7: Decouple Focus From Resize

Goal:

Make focus only a selection/viewport concern.

Refactor:

- `src/web/canvas/focus.ts`
- `src/web/app/App.tsx`
- `src/web/canvas/WorkspaceCanvas.tsx`

Remove:

- implicit node growth on focus
- hard-coded canvas-size estimates for focus viewport logic

Replace with:

- selection
- optional viewport animation
- autofocus timing

If viewport fitting needs container dimensions, pass real canvas dimensions down instead of using fixed estimates.

Exit criteria:

- focusing a node no longer mutates its bounds
- focus tests still pass

### PR8: Separate Free Layout From Focus-Tiles Layout

Goal:

Stop writing derived focus-tiles bounds back into persisted workspace bounds.

Refactor:

- `src/web/canvas/WorkspaceCanvas.tsx`
- `src/web/canvas/layout/focusTilesLayoutStrategy.ts`

Remove:

- write-back of rendered focus-tiles bounds into workspace on mode exit

Keep:

- user-authored free-layout bounds as durable state
- focus-tiles layout as a purely derived render-time layout

Exit criteria:

- switching between `free` and `focus-tiles` does not rewrite free-layout bounds
- layout-mode tests cover this explicitly

### PR9: Cleanup And Documentation

Goal:

Delete obsolete abstractions and document the final model.

Candidates to remove if unused after earlier PRs:

- `getReadOnlyPreviewTerminalIds` in `src/shared/workspace.ts`
- `src/web/terminals/TerminalScrollPreview.tsx`
- any stale semantic-zoom-only terminal presentation codepaths

Add:

- a short design note, for example `docs/TERMINAL_BEHAVIOUR.md`, documenting:
  - size ownership
  - focus ownership
  - preview ownership
  - layout-mode behaviour

Exit criteria:

- dead abstractions removed
- final ownership rules are documented clearly enough for future contributors

## Acceptance Criteria For The Whole Refactor

The refactor is complete when all of the following are true:

- focusing an inspect preview does not remount its xterm
- typing into the focused terminal remains reliable while output streams
- only one surface can request PTY resize for a session
- unfocused previews remain visually live while output streams
- focus does not resize nodes
- switching layout modes does not destroy free-layout bounds
- external workspace refreshes cannot recommit stale local viewport state
- local and remote terminals behave the same from the UI's perspective

## Suggested Manual Test Matrix

Run these manual scenarios after each behaviour-changing PR:

- local shell terminal, free layout, focus and type while output streams
- local shell terminal, resize focused node while output streams
- local shell terminal, focus another terminal, then return
- local shell terminal, switch between `free` and `focus-tiles`
- remote terminal, same scenarios as local
- multiple terminals producing background output while a different terminal is focused
- workspace refresh arriving while the user is panning the canvas

## Useful Commands

Recommended verification commands:

```bash
npx vitest run src/web/terminals/TerminalFocusSurface.test.ts
npx vitest run src/web/terminals/TerminalPlaceholderNode.test.ts
npx vitest run src/web/canvas/WorkspaceCanvas.test.ts
npx vitest run src/web/canvas/layout/focusTilesLayoutStrategy.test.ts
npx vitest run src/web/state/useTerminalSessions.test.ts
npm run typecheck
npm run test
```

## Implementation Notes

- Prefer small PRs with one architectural responsibility each.
- Do not change the server protocol unless the client-side ownership model is already simplified.
- Keep local and remote behaviour unified at the client API layer.
- Avoid reintroducing separate rendering paths that are intended to be behaviourally equivalent.
- When in doubt, preserve the invariant: one terminal, one interactive xterm, one PTY resize owner.

## Summary

This refactor is not primarily about fixing individual bugs. It is about changing ownership boundaries so that focus, resize, preview, and layout behaviour can become predictable.

The most important structural changes are:

- split ephemeral UI state from persisted workspace state
- make terminal presentation explicit
- make PTY resize ownership explicit
- decouple focus from resize
- make focus-tiles derived rather than destructive

If those are done in the order above, the behaviour should become much easier to reason about and much less likely to regress.
