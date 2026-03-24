# Terminal Sizing Issues

Analysis of how terminal sizing flows from UI -> server -> PTY, and the problems at each layer.

## Data Flow

```
UI Container Resize
    |
ResizeObserver triggers scheduleFit() via requestAnimationFrame
    |
fitTerminal() in useXtermSurfaceController.ts:245
  - getTerminalCellSize(): tries xterm renderer dims, falls back to DOM probe
  - measureTerminal(): container.clientWidth / cellWidth -> cols (clamped 20-240 cols, 8-120 rows)
  - terminal.resize(cols, rows)          <-- local xterm resized immediately
  - syncBackendSize(cols, rows)          <-- async, via WebSocket
    |
WebSocket message: { type: 'terminal.resize', sessionId, cols, rows }
    |
Server: registerWorkspaceSocket.ts:163 -> BackendRuntimeManager -> PtySessionManager
    |
ptySessionManager.ts:177 resizeSession()
  - clampTerminalDimensions() again (same bounds)
  - record.pty.resize(cols, rows)        <-- node-pty sends SIGWINCH
  - snapshot updated and broadcast to all clients
    |
Read-only clients receive new snapshotCols/snapshotRows
Interactive client already showing the new size locally
```

## Key Files

| Layer | File | Role |
|-------|------|------|
| Frontend | `src/web/terminals/useXtermSurfaceController.ts` | ResizeObserver, fitTerminal(), measureTerminal(), syncBackendSize() |
| Frontend | `src/web/terminals/terminalSizing.ts` | measureCellSize() DOM probe, DEFAULT_TERMINAL_CELL_SIZE |
| Frontend | `src/web/state/useTerminalSessions.ts:182` | resizeSession() sends WebSocket message |
| Shared | `src/shared/terminalSizeConstraints.ts` | MIN/MAX cols/rows, clampTerminalDimensions() |
| Server | `src/server/ws/registerWorkspaceSocket.ts:163` | Receives terminal.resize message |
| Server | `src/server/runtime/backendRuntimeManager.ts:133` | Routes resize to correct backend adapter |
| Server | `src/server/pty/ptySessionManager.ts:177` | resizeSession(): clamps, calls pty.resize(), updates snapshot |
| Server | `src/server/pty/sessionSnapshot.ts:16` | createInitialSnapshot() hardcodes DEFAULT cols/rows |

## Resize Authority Model

Controlled by `terminalSurfaceModel.ts`:

- **Focus mode** (interactive): `resizeAuthority='owner'`, `sizeSource='measured'` -- UI drives resize
- **Inspect mode** (read-only): `resizeAuthority='none'`, `sizeSource='snapshot'` -- uses server snapshot
- **Overview mode** (read-only): `resizeAuthority='none'`, `sizeSource='snapshot'` -- uses server snapshot

---

## Issue #1: measureTerminal ignores xterm's internal geometry

**Location:** `useXtermSurfaceController.ts:701-722`

**Problem:** `measureTerminal()` divides `container.clientWidth` by `cellSize.width` to get cols. But xterm.js internally reserves space for a scrollbar and applies its own padding. The container size is not the same as the renderable character area. This means calculated cols/rows can be **larger** than what xterm actually renders, causing the PTY to think there are more columns than are visible -- leading to line wrapping mismatches.

xterm's own `FitAddon` uses `terminal._core._renderService.dimensions` to get the actual renderable area. This code bypasses that entirely.

```typescript
// Current code -- uses raw container dimensions
function measureTerminal(container, cellSize) {
  const width = Math.max(container.clientWidth, 0);
  const height = Math.max(container.clientHeight, 0);
  return {
    cols: clamp(Math.floor(width / cellSize.width), MIN, MAX),
    rows: clamp(Math.floor(height / cellSize.height), MIN, MAX),
  };
}
```

**Fix:** When xterm's renderer is available, read the actual renderable canvas dimensions from `_core._renderService.dimensions.css.canvas.{width,height}` (or subtract the viewport scrollbar width) and use those instead of raw `container.clientWidth/Height`. Fall back to the current approach only when the renderer hasn't initialized.

---

## Issue #2: Cell size source mismatch

**Location:** `useXtermSurfaceController.ts:725-738`

**Problem:** `getTerminalCellSize()` tries `getMeasuredRendererCellSize(terminal)` first (reads `_core._renderService.dimensions.css.cell`), and falls back to `measureCellSize()` (the DOM probe in `terminalSizing.ts`). These two can return **different values** -- the renderer cell size accounts for xterm's actual rendering pipeline (including sub-pixel adjustments), while the probe measures raw font metrics. A switch between sources mid-session (e.g. when WebGL renderer finishes loading) can cause a sudden resize event with different col/row counts for the same container size.

**Fix:** This is mitigated if #1 is fixed to use renderer dimensions end-to-end when available. The remaining risk is the moment the renderer first becomes available -- consider forcing a re-fit when the renderer addon loads (which `initializeTerminalRenderer` may already trigger via the ResizeObserver, but worth verifying).

---

## Issue #3: Initial PTY spawn uses stale 80x24 default

**Location:** `ptySessionManager.ts:289-293`, `sessionSnapshot.ts:16-45`

**Problem:** The PTY is spawned with `record.snapshot.cols/rows`, which comes from `createInitialSnapshot()` using `DEFAULT_TERMINAL_COLS=80` / `DEFAULT_TERMINAL_ROWS=24`. But the UI may measure a very different size (e.g. a small node might only fit 40x12). The PTY starts at 80x24, and only later gets resized when the frontend mounts and sends a resize. Programs that check terminal size at startup (`top`, `htop`, shell prompts with right-aligned content) render their first frame at the wrong size.

**Fix:** `TerminalNode` has `bounds: { x, y, width, height }` in logical pixels. Use `DEFAULT_TERMINAL_CELL_SIZE` from `terminalSizing.ts` to estimate initial cols/rows from `bounds.width` / `bounds.height` (with a padding deduction for node chrome). Pass estimated dimensions to `createInitialSnapshot()` instead of hardcoded defaults. This won't be pixel-perfect but will be much closer than 80x24 for small or large nodes.

---

## Issue #4: Race between PTY spawn output and first resize

**Location:** `ptySessionManager.ts:271`, `useXtermSurfaceController.ts:310-311`

**Problem:** `createSession()` calls `spawnTerminal()` immediately. The shell starts producing output at the initial size (80x24 or estimated). The UI won't send a resize until after mount + ResizeObserver fires + requestAnimationFrame runs. Any output produced during that gap (shell init, MOTD, prompt) is formatted for the wrong size and may look wrong once the resize arrives.

**Fix:** Defer the actual `spawnTerminal()` call until the first `resizeSession()` message arrives from the frontend. The session record is created and registered immediately (so it appears in the UI), but `record.pty` stays `null` until the first resize sets the correct dimensions. This ensures the PTY is never spawned at a stale size. Need to handle the edge case where a resize never arrives (e.g. the client disconnects) -- a timeout fallback that spawns at the estimated/default size after ~2s would be reasonable.

---

## Issue #5: Retry is fire-once

**Location:** `useXtermSurfaceController.ts:177-189`

**Problem:** If `syncBackendSize` fails (`resizeAccepted === false`), it schedules exactly one retry after 100ms. If that retry also fails (e.g. WebSocket still reconnecting), the resize is silently dropped. The pending size stays in `pendingBackendSizeRef` but nothing re-triggers it except the effect at line 390, which only fires when `canSyncResize` or `deferResizeSync` change -- it won't fire if the WebSocket was briefly unavailable but those flags didn't change.

**Fix:** Either use exponential backoff with a small number of retries (e.g. 3 attempts at 100ms, 200ms, 400ms), or rely more on the recovery effect at line 403 by ensuring it also checks for pending resizes when the snapshot comes back in sync. The simplest fix: when `canSyncResize` transitions to `true`, always flush `pendingBackendSizeRef` if non-null (the effect at line 390 already does this -- verify it covers the WebSocket-reconnect case).

---

## Issue #6: Clamping to MIN on zero-size containers

**Location:** `useXtermSurfaceController.ts:712-721`

**Problem:** When a terminal is being unmounted or collapsed to 0x0 (e.g. during animation), `Math.floor(0 / cellSize.width) = 0` gets clamped to `MIN_TERMINAL_COLS=20`. If `resizeAuthority='owner'`, this sends a resize to 20x8 to the PTY, which can cause running programs to reflow their output at a tiny size momentarily.

**Fix:** Guard `measureTerminal()` (or `fitTerminal()`) to return early / skip the resize when the container has zero or near-zero dimensions. For example:

```typescript
if (width < cellSize.width || height < cellSize.height) {
  return; // container too small to hold even one cell -- skip resize
}
```

This prevents a transient resize-to-minimum during unmount animations.

## Issue #7: Transient size mismatch between local xterm and PTY

**Location:** `useXtermSurfaceController.ts:305-312`

**Problem:** Inside the `terminal.write('')` callback, the code calls `terminal.resize()` and then `syncBackendSize()`. The local xterm is resized immediately, but the backend resize is async (WebSocket round-trip). During the gap, the PTY is at the old size while xterm shows the new size. If the shell outputs data between the local resize and the PTY resize landing, the data is formatted for the old PTY cols but rendered in the new xterm cols -- causing visual corruption for one "frame" of output.

**Impact:** Low in practice. The gap is typically <50ms on localhost. Becomes more visible with remote backends over high-latency connections.

**Fix:** This is inherent to the async architecture and hard to fully eliminate. The main mitigation is to ensure the resize reaches the PTY as fast as possible (no unnecessary debouncing). The current rAF-based scheduling is already reasonable. For remote backends, consider buffering output briefly after sending a resize until the resize is acknowledged, but this adds complexity.
