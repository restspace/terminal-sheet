# Terminal Unification Handoff

## Goal

Unify the focused terminal overlay with the underlying canvas node so that a focused terminal is owned by exactly one node and exactly one `xterm` instance.

The intended end state is:

- No separate `FocusedTerminalOverlay` for the selected terminal.
- The selected terminal node remains visible in place and becomes interactive.
- Focus changes reuse the same mounted `xterm` instead of handing off between a read-only preview path and a separate focused surface.

## Why This Is Worth Doing

There have been repeated bugs caused by trying to keep behavior equivalent across:

- The focused overlay path.
- The read-only xterm preview path.
- The lighter non-xterm preview path.

The reliability goal is to reduce "equivalent but different" rendering paths.

## Current State

Item 1 of the refactor has already been implemented in `src/web/terminals/TerminalFocusSurface.tsx`.

What changed:

- `TerminalSurface` now uses one shared xterm initialization path for both focused and read-only surfaces.
- Read-only and interactive mode now update interactivity in place on the same xterm instance.
- Read-only surfaces now use the same webgl-first renderer path, with canvas fallback, instead of forcing canvas up front.
- Public component API is unchanged: `TerminalFocusSurface` and `ReadOnlyTerminalSurface` still exist.

What did not change:

- The focused terminal is still rendered through `FocusedTerminalOverlay`.
- The selected node on the canvas is still hidden behind the overlay.
- `TerminalPlaceholderNode` still has multiple display paths, including non-xterm preview rendering.
- Focus-tiles swap visuals are still overlay-based.

## Relevant Files

- `src/web/terminals/TerminalFocusSurface.tsx`
- `src/web/terminals/TerminalFocusSurface.test.ts`
- `src/web/terminals/TerminalPlaceholderNode.tsx`
- `src/web/terminals/FocusedTerminalOverlay.tsx`
- `src/web/canvas/WorkspaceCanvas.tsx`
- `src/web/canvas/layout/focusTilesLayoutStrategy.ts`
- `src/web/styles.css`

## Current Architecture Notes

- `WorkspaceCanvas` renders all nodes through React Flow and then separately renders `FocusedTerminalOverlay` for the selected terminal.
- The selected terminal node is still present underneath, but the canvas hides it visually with CSS and overlay layering.
- `TerminalPlaceholderNode` currently has different rendering branches for `overview`, `inspect`, and `focus`.
- Unfocused inspect mode can mount a read-only xterm via `ReadOnlyTerminalSurface`.
- Node-level focus mode currently does not use the same live interactive xterm as the overlay. It falls back to `TerminalScrollPreview` or other lightweight UI depending on state.
- Focus-tiles mode currently relies on overlay swap state in `WorkspaceCanvas` plus overlay-specific CSS animations.

## Refactor Objective

Make the selected terminal node itself own the focused xterm.

That means:

- One visible focused node.
- One mounted focused xterm.
- Focus as a mode change on the node, not as a transfer to another component.

## Proposed Plan

### 1. Stabilize the node-owned terminal subtree

Refactor `TerminalPlaceholderNode` so that `inspect` and `focus` share one stable live terminal subtree backed by `TerminalSurface`.

Desired result:

- When a node becomes focused, its terminal flips from read-only to interactive without remounting.
- The same mounted xterm instance survives the mode change.

This is the most important architectural step.

### 2. Remove overlay rendering from `WorkspaceCanvas`

Delete the `FocusedTerminalOverlay` usage from `WorkspaceCanvas` and stop hiding the selected node behind it.

This will require removing:

- Overlay selection rendering.
- Overlay swap state.
- Overlay-specific opacity hiding for focused nodes.
- Absolute-positioned overlay rendering logic.

### 3. Move focused chrome into the node

Anything only available in the overlay should move into the node itself.

That includes:

- Title bar behavior.
- Restart affordance.
- Drag handle semantics.
- Any focused-only controls still needed by the user.

### 4. Rework pointer boundaries between xterm and React Flow

This is likely the highest-risk part.

A focused in-node xterm must:

- Accept keyboard input.
- Allow text selection and wheel scrolling.
- Not leak pointer events into canvas panning or node dragging.

At the same time, the node must still support:

- Selection.
- Dragging from the intended handle.
- Resize handles.

### 5. Replace overlay-specific focus-tiles transitions

The current focus-tiles transition model assumes overlays.

After overlay removal, use either:

- Simpler node-level transitions.
- Or a reduced animation model for selected-node handoff.

Do not try to preserve overlay behavior verbatim unless it is cheap.

### 6. Update tests around the new ownership model

Add tests asserting:

- Focus transitions reuse the same xterm instance.
- The selected node renders the focused terminal in place.
- `WorkspaceCanvas` no longer renders `FocusedTerminalOverlay`.
- Focus/inspect behavior stays equivalent where intended.

## Suggested Implementation Order

1. Refactor `TerminalPlaceholderNode` first so the focused node can own a real `TerminalSurface`.
2. Only once that is stable, remove the overlay from `WorkspaceCanvas`.
3. Then clean up focus-tiles transitions and CSS.

Trying to delete the overlay first will make the interaction bugs harder to reason about.

## Useful Design Constraints

- Keep the current preview budget model unless there is a strong reason to change it.
- Preserve the current layout system and `focus-tiles` selection semantics unless the refactor forces a local change.
- Avoid introducing more mounted xterms than necessary for non-selected terminals.
- Prefer deleting duplicated behavior rather than re-implementing overlay behavior inside the node.

## Known Risk Areas

- React Flow event propagation versus interactive xterm input.
- Wheel/scroll behavior inside a focused node.
- Drag handle behavior when the node contains a live terminal.
- Focus-tiles swap animation after overlay removal.
- Maintaining performance if too many live surfaces stay mounted.

## Validation Checklist

At minimum, the next agent should verify:

- Focusing a terminal does not remount its xterm.
- Typing into the focused terminal works.
- Resizing the focused terminal still updates PTY size correctly.
- Unfocused inspect previews continue to render correctly.
- Focus-tiles mode still selects and rearranges nodes correctly.
- No pointer leakage into canvas drag/pan while interacting with the focused terminal.

Suggested commands:

- `npx vitest run src/web/terminals/TerminalFocusSurface.test.ts`
- `npx vitest run src/web/terminals/TerminalPlaceholderNode.test.ts src/web/terminals/FocusedTerminalOverlay.test.ts`
- `npm run typecheck`

Additional canvas-focused tests will likely need to be added during the refactor.

## Worktree Notes

The repository is already in a dirty state outside this handoff task.

Current modified/untracked areas include:

- `src/server/pty/ptySessionManager.test.ts`
- `src/server/routes/workspace.ts`
- `src/server/ws/registerWorkspaceSocket.ts`
- `src/shared/workspace.test.ts`
- `src/shared/workspace.ts`
- `src/web/app/App.tsx`
- `src/web/canvas/WorkspaceCanvas.tsx`
- `src/web/state/useTerminalSessions.ts`
- `src/web/state/useWorkspace.ts`
- `src/web/state/workspaceActions.test.ts`
- `src/web/state/workspaceActions.ts`
- `src/web/state/workspaceClient.ts`
- `src/web/terminals/TerminalFocusSurface.test.ts`
- `src/web/terminals/TerminalFocusSurface.tsx`
- `src/server/debug/`
- `src/web/debug/`

Do not assume those changes are safe to overwrite. Read before editing and avoid reverting unrelated work.

## Status At Handoff

Completed:

- Shared xterm initialization and in-place interactivity switching in `TerminalSurface`.

Still pending:

- Making the focused node own the focused xterm.
- Removing overlay rendering.
- Deleting overlay-specific animation and styling.
- Unifying node-level focus rendering with the real terminal surface.
