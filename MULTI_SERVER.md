# Multi-Machine Terminal Hosting Via One Home Server

## Summary
Implement v1 as a hub-and-spoke system built on the existing partial remote-backend work.

- One `home` server remains the only browser-facing server and the only workspace authority.
- Each remote machine runs the existing Terminal Canvas server in `remote` mode and owns PTY lifecycle on that machine.
- The home server maintains outbound authenticated REST/WebSocket connections to remotes, creates sessions on demand, merges remote runtime state into its own `/ws` feed, and routes terminal control actions by `backendId`.
- Authentication stays on the existing shared machine-token model, with token show/rotate support and health validation during backend registration.

## Key Changes
### Server architecture
- Formalize server roles around current behavior:
  - `standalone`: current local-only mode.
  - `home`: owns workspace, backend registry, merged runtime feed, backend CRUD, and remote session creation.
  - `remote`: exposes authenticated machine APIs and backend socket, but does not allow configuring downstream backends.
- Keep the browser single-origin to the home server; do not connect the browser directly to remotes.

### Workspace and runtime ownership
- Make the home workspace the source of truth for all terminal nodes, including remote terminals.
- Continue storing `backendId` on each terminal node and `backends[]` in workspace state, but stop treating remote workspace import as the primary ownership model.
- Treat remotes as PTY authorities only: they host sessions whose IDs are assigned/declared by the home server and whose metadata originates from the home workspace.
- Preserve merged runtime snapshots and attention events in the home server, namespaced by `backendId` as today.

### Public APIs and interfaces
- Add an explicit remote terminal creation API on machine routes, e.g. authenticated `POST /api/backend/sessions`, accepting the terminal launch spec the home server needs to send:
  - `sessionId`
  - `label`
  - `shell`
  - `cwd`
  - `agentType`
  - optional display metadata needed by integrations
- Keep existing remote control APIs for input, resize, restart, and mark-read.
- Adjust backend registration flow so `POST /api/backends` validates remote health/capabilities, but does not rely on importing remote-owned terminal nodes as the main mechanism.
- Extend backend health/capabilities payloads so the home server can reject unsupported remotes cleanly.
- Ensure workspace/browser-facing shapes continue to use the existing `/api/workspace`, `/api/sessions`, and `/ws` contracts, with `backendId` present on terminal and session payloads.

### Home-server behavior
- When the user creates a terminal, require/select a backend in the home UI; local maps to `local`, remote maps to a configured backend.
- Persist the new terminal node in the home workspace first, then have the home runtime manager call the selected remote's create-session API.
- On success, the remote PTY manager starts a session using the provided `sessionId`, and the home server receives the resulting snapshot/output over the existing backend socket.
- On remote creation failure, keep the terminal node in the home workspace but surface it as disconnected/spawn-failed with a clear error path.
- Continue routing input/resize/restart/mark-read by resolving `backendId` from workspace/session state.

### Remote-server behavior
- Remote PTY/session manager must support creating a session from an authenticated API request, not only from syncing its own workspace file.
- Remote workspace persistence should no longer be required for home-created sessions; remote mode can keep a minimal local workspace or no durable terminal-node ownership for those sessions.
- Remote attention/integration behavior should remain local to the machine where the PTY runs, then stream resulting events back to the home server.

### UI and CLI
- Add backend selection to "Add Terminal" in the web app; default to local.
- Add a lightweight Connections/Backends management UI showing label, URL, status, and remove action.
- Show backend identity in terminal chrome and disconnected/auth-failed states in a user-visible way.
- Keep CLI support for:
  - `tsheet serve --role home|remote`
  - `tsheet token show|rotate`
  - `tsheet backend add|list|remove`
- If useful, add a CLI path for opening a terminal on a specific backend later, but web support is the primary v1 path.

## Test Plan
- Schema/state:
  - workspace persists `backends[]` and terminal `backendId`
  - home-created remote terminal nodes round-trip through workspace save/load
- Home runtime:
  - merged `/api/sessions` and `/ws` include local and remote snapshots with correct `backendId`
  - input/resize/restart/mark-read route to the owning backend
  - reconnect restores remote snapshots without duplicate sessions/events
- Remote machine APIs:
  - health succeeds with valid token and fails with invalid token
  - create-session starts a PTY using the supplied `sessionId`
  - create-session failure produces a clear error response
- End-to-end:
  - home server with two remotes can create terminals on any selected machine from one browser tab
  - typing, resize, restart, and attention events work for local and remote terminals
  - remote outage leaves layout intact and marks affected terminals disconnected
  - auth failure on one backend does not break local or other remote terminals

## Assumptions
- V1 uses one home server and many remotes; no browser-to-remote connections.
- Remotes run the existing full Terminal Canvas server in `remote` mode, not a new agent.
- Shared machine token auth is sufficient for the first implementation; stronger auth is deferred.
- Markdown and non-terminal workspace objects remain home-owned.
- Remote terminal migration between machines, multi-home sync, and multi-user collaboration are out of scope.
