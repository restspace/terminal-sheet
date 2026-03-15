# Remote Backends Plan

## 1. Purpose

This document defines a simple way for Terminal Canvas to supervise terminals hosted by multiple Terminal Canvas servers on different machines, without turning the browser into a distributed client.

The design keeps one home server in charge of the canvas and lets that home server connect to one or more remote backends that own live PTY sessions.

## 2. User model

The user experience should stay simple:

- open one Terminal Canvas URL in the browser
- treat that instance as the home server
- add remote backends by entering a base URL and access token once
- create terminals against either the local backend or a selected remote backend
- supervise all terminals on one canvas with one event feed and one set of camera controls

The browser should not connect to multiple remote servers directly in v1 of this feature. It should only talk to the home server.

## 3. Core architecture

### Home server responsibilities

- persist the workspace, layout, filters, camera presets, and Markdown nodes
- maintain the registry of configured remote backends
- open outbound REST and WebSocket connections to remote backends
- merge local and remote session state into one browser-facing model
- route terminal input, resize, restart, and mark-read actions to the owning backend
- merge attention events from all connected backends into one stream

### Remote backend responsibilities

- run a normal Terminal Canvas server instance
- own the live PTY sessions started on that machine
- expose authenticated APIs for session snapshots and session control
- expose an authenticated event stream for session updates and attention events
- generate and store a server token for trusted home-server connections

### Browser responsibilities

- keep a single-origin connection to the home server only
- display backend status and backend ownership on terminal nodes
- let the user add, edit, remove, and select backend connections
- let the user choose a backend when creating a terminal

## 4. Data model and interfaces

### Workspace model

The workspace remains home-server-owned. Extend it with:

- `backends`: saved connection records containing `id`, `label`, `baseUrl`, and persisted connection metadata
- `backendId` on each terminal node so the home server knows which backend owns the live session

Markdown nodes remain home-server-owned in this phase.

### Runtime session model

Session and attention payloads should carry backend identity so merged events remain unambiguous:

- session snapshots include `backendId`
- attention events include `backendId`
- terminal runtime actions are routed by `backendId`

The home server should namespace or otherwise stabilize merged session identity so collisions cannot occur when different backends use the same session ID shape.

### Remote APIs

Each remote backend should expose authenticated endpoints or channels for:

- health and version check
- initial session snapshot fetch
- terminal creation
- terminal input
- terminal resize
- terminal restart
- terminal mark-read
- live session and attention event streaming

The home server should reuse the existing local browser-facing shapes where practical instead of inventing a second event model.

## 5. Security and setup

### What must be installed remotely

Each remote machine only needs Terminal Canvas installed and running. No separate bridge agent or browser-side helper is required.

### Token generation

The token model should be deliberately simple:

- generate a long random token automatically on first server launch
- store it in the server's local config or state directory
- expose a way to show, copy, and rotate the token from the UI or CLI
- require the home server to present that token on all outbound requests to the remote backend

Recommended CLI surface:

- `terminal-canvas token show`
- `terminal-canvas token rotate`

Recommended setup flow:

1. Install and start Terminal Canvas on the remote machine.
2. Copy the remote server URL.
3. Copy the generated token from the remote server.
4. Add that URL and token in the home server's Connections UI.

### Trust model

Assume trusted URLs plus a shared token for the initial implementation:

- no user accounts
- no OAuth
- no browser-to-remote credential handling
- no automatic discovery

If a backend is unreachable or the token is invalid, the home server should mark it clearly as disconnected or auth-failed without removing affected terminals from the workspace.

## 6. UX changes

Add a lightweight Connections panel in the home UI with:

- list of configured backends and their status
- add backend flow with label, URL, and token
- edit and remove actions
- default local backend

Terminal-related UI changes:

- backend selector in the Add Terminal flow
- backend badge on terminal cards and focused terminals
- backend-based filtering
- disconnected state on terminals whose backend is unavailable

The goal is that supervising a mixed local and remote workspace feels the same as supervising a local-only workspace, aside from backend labels and connection status.

## 7. Testing and acceptance

### Unit and integration coverage

- workspace schema supports saved backends and terminal `backendId`
- home server backend registry persists and reloads connections
- local and remote terminal authorities satisfy the same routing contract
- invalid token is surfaced as a clear auth error
- reconnect restores remote session and attention streams without duplication

### End-to-end scenarios

- home server supervises one local backend and one remote backend from a single browser tab
- user creates a terminal on a selected remote backend and can type into it normally
- remote attention events appear in the main event stream and jump-to-attention still works
- remote backend outage degrades terminal state without deleting layout or Markdown nodes

## 8. Defaults and non-goals

Defaults for this phase:

- one home server owns the workspace
- browser connects only to the home server
- remote auth uses a shared token
- Markdown remains home-server-owned

Out of scope for this phase:

- moving a live terminal from one backend to another
- synchronizing one workspace file across multiple servers
- direct browser connections to remote backends
- user-account-based authentication
- multi-user collaboration
