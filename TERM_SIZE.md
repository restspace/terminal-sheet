# Terminal sizing model

This document describes the current terminal sizing architecture.

The important distinction is:

- the browser can have a **desired** live-surface size
- the session snapshot only stores the last size the backend has **applied** to the PTY

Those are intentionally not the same thing while a resize is in flight.

## Core invariants

- `session.cols` and `session.rows` mean the last size the backend applied to the PTY.
- `session.appliedResizeGeneration` identifies which resize generation produced that applied size.
- `null` `cols` / `rows` / `appliedResizeGeneration` means the session exists, but no PTY-applied size is known yet.
- Every browser resize request carries a monotonic `generation`.
- For a given session, at most one mounted surface is `live`; summary surfaces never mount xterm and never resize the PTY.
- `acceptsInput` only controls whether the surface forwards keyboard input. A read-only live surface can still measure geometry and drive resize synchronization.
- During layout animation, `freezeTerminalGeometry` keeps the rendered terminal at the last applied PTY size and blocks backend resize dispatch until the layout settles.

## Surface model

`src/web/terminals/terminalSurfaceModel.ts` reduces sizing behavior to:

- `surfaceKind: 'live' | 'summary'`
- `acceptsInput: boolean`

The resulting modes are:

- **focus + live**: mounted xterm, accepts input
- **inspect + live**: mounted xterm, read-only, still owns sizing for that session
- **overview + summary**: no xterm mount, no resize participation
- **focus/inspect + summary**: placeholder state used before a live session snapshot exists

`src/web/terminals/TerminalPlaceholderNode.tsx` is the handoff point:

- live surfaces mount `TerminalSurface`
- summary surfaces render preview text from the snapshot only

## Snapshot semantics

The shared protocol lives in `src/shared/terminalSessions.ts`.

The relevant snapshot fields are:

- `cols`
- `rows`
- `appliedResizeGeneration`

The relevant client message is:

- `terminal.resize { sessionId, cols, rows, generation }`

There is no longer any separate client-side “snapshot size” concept for previews. If UI code needs the last PTY-applied size, it reads the session snapshot directly.

## Client-side resize flow

Live surfaces are driven by `src/web/terminals/useXtermSurfaceController.ts`.

### 1. Geometry measurement

Geometry measurement is centralized in `src/web/terminals/terminalGeometry.ts`.

`measureLiveTerminalGeometry(...)`:

- prefers `.xterm-screen` dimensions when xterm has rendered them
- prefers xterm renderer cell metrics when available
- falls back to DOM-based cell measurement
- returns `null` when the container cannot fit even one cell

That means zero-size or near-zero containers do not get clamped to a fake minimum PTY size.

### 2. Desired vs applied vs pending

For each live surface, the controller tracks:

- the **desired** size from current measured geometry
- the **applied** size from `appliedCols` / `appliedRows`
- an optional **pending** resize request with a generation

If the desired size differs from the applied size, the controller reserves a new generation in `src/web/terminals/terminalResizeGeneration.ts` and stores it as the pending request.

### 3. Local display behavior

When geometry is not frozen, the mounted xterm is rendered at the desired size immediately, even before the backend snapshot catches up.

That is intentional:

- the live surface can visually match its container immediately
- the session snapshot still reflects PTY-applied truth only

When geometry **is** frozen, the live surface stays rendered at the last applied size instead. The new desired size may still be remembered as a pending request, but it is not dispatched yet.

### 4. Dispatch

The controller sends resize requests through `onResize(sessionId, cols, rows, generation)`, which is wired to `resizeSession(...)` in `src/web/state/useTerminalSessions.ts`.

Blocked sends are tracked explicitly. The main blocked cases are:

- geometry is frozen
- the workspace socket is unavailable
- the send callback rejected the request

### 5. Apply acknowledgement

When a later snapshot arrives with `appliedResizeGeneration >= pending.generation`, the controller clears the pending request and pending visual state.

`observeAppliedTerminalResizeGeneration(...)` also advances the client-side generation counter so future requests stay monotonic after reconnects or remounts.

## Server-side resize flow

The authoritative server pipeline is in `src/server/pty/ptySessionManager.ts`.

### Session creation

`createSession(...)` starts with:

- `cols: null`
- `rows: null`
- `appliedResizeGeneration: null`
- no PTY process yet

The server creates the session record immediately, but defers spawning the PTY.

### Resize requests

`resizeSession(sessionId, cols, rows, generation)`:

- clamps the requested dimensions to shared bounds
- ignores stale generations that are older than the newest requested or already applied generation
- stores the latest requested resize in runtime state
- applies it immediately if a PTY already exists
- otherwise starts spawn or waits for an in-flight spawn to finish

### Spawn

`spawnTerminal(...)` chooses its initial size in this order:

1. latest requested resize from a live surface
2. last applied snapshot size, if one already exists
3. estimated fallback size from `estimateTerminalDimensionsFromNodeBounds(...)`

The fallback path uses resize generation `0`.

### Applied size

When the PTY is spawned or resized, the manager updates the snapshot with `createAppliedResizeSnapshot(...)`.

That writes:

- `cols`
- `rows`
- `appliedResizeGeneration`

and broadcasts a fresh `session.snapshot`.

There is no separate browser-desired size on the server snapshot. Only applied PTY size is published.

## Deferred spawn behavior

Sessions do not spawn immediately on creation.

If no live surface sends a resize within `DEFERRED_PTY_SPAWN_MS` (currently 2000 ms), the server spawns using the estimated fallback node size.

This gives the browser a chance to claim the initial PTY size from real measured geometry, while still ensuring headless or disconnected sessions eventually start.

## Layout animation behavior

`src/web/canvas/WorkspaceCanvas.tsx` exposes `freezeTerminalGeometry` while layout animation is active and passes it through `src/web/terminals/TerminalPlaceholderNode.tsx` into `TerminalSurface`.

While frozen:

- local xterm rendering stays at the last applied PTY size
- pending desired geometry can still be remembered
- backend dispatch is blocked

When the layout unfreezes, the pending resize is flushed or a new desired size is measured and sent.

This replaces the older model that intentionally let local and PTY geometry diverge for the full animation.

## Retry and timeout behavior

Rejected resize sends use bounded retry delays:

- 100 ms
- 200 ms
- 400 ms
- then 400 ms repeatedly

If a request remains unsynchronized for 10 seconds, the controller reports `onResizeSyncError`.

After timeout:

- timer-driven retries stop for that request
- a later explicit geometry/observer event can create a fresh generation and try again

## Removed concepts

The old sizing vocabulary is obsolete and should not be reintroduced:

- `interactionMode`
- `sizeSource`
- `resizeAuthority`
- `deferTerminalResizeSync`
- client-only `snapshotCols` / `snapshotRows` branching

The current replacements are:

- `surfaceKind`
- `acceptsInput`
- `freezeTerminalGeometry`
- `session.cols` / `session.rows` / `session.appliedResizeGeneration`

## Key files

- `src/shared/terminalSessions.ts`
- `src/web/terminals/terminalSurfaceModel.ts`
- `src/web/terminals/terminalGeometry.ts`
- `src/web/terminals/terminalResizeGeneration.ts`
- `src/web/terminals/useXtermSurfaceController.ts`
- `src/web/terminals/TerminalPlaceholderNode.tsx`
- `src/web/state/useTerminalSessions.ts`
- `src/server/pty/sessionSnapshot.ts`
- `src/server/pty/ptySessionManager.ts`
