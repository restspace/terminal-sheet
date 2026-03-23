# Workspace And Runtime Architecture Refactor Plan

## Purpose

This document is a self-contained execution plan for the next architectural refactor of this repository.

It focuses on six structural improvements:

1. replace the full-document workspace API with command or patch style mutations
2. decouple durable workspace persistence from runtime side effects
3. split the client realtime store by domain and reduce `App.tsx` ownership
4. break `BackendRuntimeManager` into adapters instead of one combined orchestrator
5. move backend provisioning logic out of the route layer
6. resolve whether `selectedNodeId` is durable collaborative state or local UI state

This plan is intended to be executable from empty context later. It includes:

- repository context
- the current workspace write path
- what is inside `Workspace`
- why the current model becomes brittle
- a staged execution plan
- file-level guidance
- acceptance criteria

## Repository Context

Relevant runtime boundaries:

- `src/shared/`: durable schemas and transport contracts
- `src/server/persistence/`: workspace file IO and in-memory workspace service
- `src/server/routes/`: HTTP entrypoints for workspace, markdown, backends, filesystem, health
- `src/server/runtime/`: local and remote backend orchestration
- `src/server/pty/`: PTY lifecycle and runtime session state
- `src/server/ws/`: websocket transport for workspace, sessions, attention, markdown
- `src/web/state/`: workspace persistence client and websocket client state
- `src/web/app/`: top-level React composition
- `src/web/canvas/`: canvas-local UI state and rendered node interactions
- `src/web/markdown/`: markdown rendering and editing
- `src/web/terminals/`: terminal presentation and interaction

## Current Model

### What `Workspace` Contains

The shared `Workspace` schema lives in `src/shared/workspace.ts`.

Today `Workspace` contains:

- metadata:
  - `version`
  - `id`
  - `name`
  - `createdAt`
  - `updatedAt`
- persisted canvas state:
  - `layoutMode`
  - `selectedNodeId`
  - `currentViewport`
  - `cameraPresets`
  - `filters`
- terminal node metadata:
  - `terminals[]`
  - each terminal stores `id`, `backendId`, `label`, `repoLabel`, `taskLabel`, `shell`, `cwd`, `agentType`, `status`, `bounds`, `tags`
- markdown node metadata:
  - `markdown[]`
  - each node stores `id`, `label`, `filePath`, `readOnly`, `bounds`
- remote backend configuration:
  - `backends[]`
  - each backend stores `id`, `label`, `baseUrl`, `token`, `transport`, optional SSH config, and `enabled`

This means `Workspace` is currently a mixed document containing:

- durable layout state
- durable backend configuration
- some state that looks collaborative
- some state that behaves more like local UI state

### What Is Not In `Workspace`

Live terminal runtime state is not stored in `Workspace`.

That state is carried in `TerminalSessionSnapshot` from `src/shared/terminalSessions.ts`, including:

- `pid`
- `connected`
- `recoveryState`
- `lastActivityAt`
- `lastOutputAt`
- `previewLines`
- `scrollback`
- `unreadCount`
- `exitCode`
- `disconnectReason`
- `cols` and `rows`
- `liveCwd`
- `projectRoot`
- integration state

Markdown document content is also not persisted inside `Workspace`; it is handled separately by `MarkdownService` and the markdown routes.

### Current UI Write Path

The current generic workspace flow is:

1. the client loads the full workspace via `GET /api/workspace`
2. `useWorkspace()` stores the whole object in React state and refs
3. user actions mutate a local copy of the whole object
4. `useWorkspace.updateWorkspace()` applies the new object optimistically in the browser
5. the client schedules an autosave
6. autosave sends the full `Workspace` back through `PUT /api/workspace`
7. the server validates and rewrites the whole workspace file
8. the server broadcasts a new `workspace.updated` websocket event
9. clients compare timestamps and may replace local workspace state with the server copy

Important files:

- `src/web/state/useWorkspace.ts`
- `src/web/state/workspaceClient.ts`
- `src/web/state/workspaceActions.ts`
- `src/server/routes/workspace.ts`
- `src/server/persistence/workspaceService.ts`
- `src/server/persistence/workspaceStore.ts`
- `src/server/ws/registerWorkspaceSocket.ts`

### Current Conflict Model

The client sends the full document plus a base revision header:

- header: `x-tsheet-workspace-base-updated-at`

The server compares that header to `currentWorkspace.updatedAt`.

If they differ:

- the server returns `409` or `428`
- the client throws `WorkspaceConflictError`
- the client currently replaces local workspace state with the server workspace

This is not a semantic merge. It is a document replacement.

### Important Existing Exception

The codebase already contains a second mutation model:

- markdown create and open do not use `PUT /api/workspace`
- they use dedicated command endpoints like `POST /api/markdown/create`
- the server performs the mutation and returns the updated workspace plus the document

That is important because it shows the architecture is already partly transitioning away from a pure full-document write model.

## Why The Current Model Becomes Fragile

The main issue is not that the current code is invalid. The issue is that the ownership boundaries are weak.

A small UI action such as:

- moving the viewport
- removing one terminal
- changing layout mode
- adding one backend

can become:

- local full-document mutation
- full-document HTTP write
- file rewrite
- runtime reconciliation
- websocket full-document broadcast
- full-document client refresh

That creates these failure modes:

- small changes contend with each other at full-document granularity
- local UI state is easy to accidentally persist
- conflict handling is document-level instead of intent-level
- server persistence is tightly coupled to runtime reconciliation
- adding more clients or more backend behavior increases hidden coupling
- the top-level client becomes a coordination hub rather than a composition shell

## Design Principles

### 1. Durable state and ephemeral state must be separated

Persist only what needs to survive reloads or synchronize intentionally across clients.

### 2. The server should own domain mutations

The client should express intent such as:

- add terminal
- move node
- set layout mode
- add backend

rather than sending back an entire replacement document for most actions.

### 3. Persistence should not be the same thing as reconciliation

Writing the workspace file and reconciling PTYs, markdown watchers, or SSH tunnels are different responsibilities.

### 4. Realtime state should be organized by domain

Workspace document state, terminal session state, markdown document state, backend status state, and attention state should not all be managed through one broad hook and one large app shell.

### 5. Runtime transports should be interchangeable

Local backend runtime, direct remote backend runtime, and SSH-tunneled backend runtime should share a common interface rather than being embedded into one class.

### 6. Persisted fields should have one clear semantic meaning

If `selectedNodeId` is local-only, it should not live in the durable shared workspace. If it is collaborative, the client should stop treating it as mostly local.

## Refactor Goals

By the end of this plan, the repository should have:

- intent-oriented workspace mutations
- a thinner persistence layer
- async or event-driven reconciliation after workspace commits
- smaller, clearer client-side state boundaries
- a backend adapter abstraction
- a backend provisioning service layer
- one explicit answer for `selectedNodeId`

## Execution Plan

The order matters. The first two stages create the most leverage for the rest.

### Stage 0: Characterize Existing Behavior

Goal:

Capture the current behavior before moving architectural boundaries.

Focus test areas:

- `src/web/state/useWorkspace.test.ts` if added
- `src/web/state/workspaceActions.test.ts`
- `src/server/routes/workspace` tests if added
- `src/server/persistence/workspaceStore.test.ts`
- `src/server/runtime/backendRuntimeManager.test.ts`
- `src/server/routes/backends` tests if added

Add characterization coverage for:

- optimistic local workspace updates followed by autosave
- conflict behavior replacing local state with server state
- websocket `workspace.updated` refresh behavior
- backend add or remove affecting workspace and runtime state
- markdown create or open returning updated workspace out-of-band

Exit criteria:

- the current document-write behavior is locked down enough that later refactors can preserve intended behavior while changing ownership

### Stage 1: Replace The Full-Document Workspace API

Goal:

Move from generic full-document replacement toward explicit mutation commands for workspace-level changes.

Why first:

- this is the largest source of coupling
- it improves conflict semantics
- it creates a clean server-owned mutation boundary for later stages

Current behavior:

- the UI computes the next whole `Workspace`
- the server accepts the next whole `Workspace`
- conflicts happen at document granularity

Target behavior:

- the client sends intent-oriented mutations
- the server validates and applies the mutation against current workspace state
- the server returns the updated workspace or emits the resulting event

Possible API shapes:

- `POST /api/workspace/mutations`
- one discriminated union request type such as:
  - `add-terminal`
  - `remove-terminal`
  - `update-terminal`
  - `move-node`
  - `resize-node`
  - `set-viewport`
  - `save-camera-preset`
  - `set-layout-mode`
- or explicit per-command endpoints if that is simpler

Recommended first moves:

- keep `GET /api/workspace`
- keep websocket `workspace.updated`
- add mutation endpoints alongside `PUT /api/workspace`
- migrate the client action by action
- remove `PUT /api/workspace` only after the UI no longer depends on it for normal operation

Suggested module additions:

- `src/shared/workspaceCommands.ts`
- `src/server/workspace/workspaceCommandService.ts`
- `src/server/workspace/workspaceCommandHandlers.ts`

Likely files to change:

- `src/shared/workspace.ts`
- `src/shared/workspaceTransport.ts`
- `src/web/state/workspaceClient.ts`
- `src/web/state/useWorkspace.ts`
- `src/web/state/workspaceActions.ts`
- `src/server/routes/workspace.ts`
- `src/server/persistence/workspaceService.ts`

Key implementation notes:

- the server should generate IDs and timestamps for command results where practical
- viewport mutations can remain debounced on the client, but they should still be expressed as an explicit mutation
- command responses should be small and deterministic
- conflict semantics should move from "replace entire document" toward "cannot apply this mutation to current revision"

Exit criteria:

- normal workspace changes no longer rely on `PUT /api/workspace` with the full document
- the client does not need to synthesize the whole next workspace for most mutations
- conflict behavior is tied to a specific command, not a full-document replacement

### Stage 2: Decouple Workspace Persistence From Runtime Side Effects

Goal:

Separate durable workspace commit from operational reconciliation.

Current behavior:

- `WorkspaceService.saveWorkspace()` writes the file
- then it synchronously notifies listeners
- those listeners trigger markdown sync, tunnel sync, and runtime sync

That means "save the workspace" currently also means:

- re-evaluate markdown node watches
- re-evaluate SSH tunnels
- re-evaluate PTY session set

Target behavior:

- persistence service commits durable state
- an event or reconciliation layer reacts afterward
- save success is not conceptually the same as full system convergence

Recommended structure:

- keep a thin `WorkspaceRepository` or `WorkspaceStore`
- add an event emitter or domain event bus
- let reconcilers subscribe to workspace committed events

Possible modules:

- `src/server/workspace/workspaceEvents.ts`
- `src/server/workspace/workspaceCommitPublisher.ts`
- `src/server/workspace/workspaceReconciler.ts`

Likely files to change:

- `src/server/persistence/workspaceService.ts`
- `src/server/app.ts`
- `src/server/markdown/markdownService.ts`
- `src/server/runtime/backendRuntimeManager.ts`
- `src/server/runtime/sshTunnelManager.ts`

Key implementation notes:

- it is acceptable for first pass reconciliation to remain in-process and synchronous after commit, as long as the responsibilities are separated structurally
- the persisted workspace in memory should update before subscribers are notified
- listener failures should not blur the distinction between "workspace save failed" and "reconciler failed"

Exit criteria:

- workspace persistence code no longer directly owns all runtime side effects
- runtime sync, markdown sync, and tunnel sync each live behind a clearer reconciliation boundary

### Stage 3: Split The Client Realtime Store And Reduce `App.tsx`

Goal:

Stop making the top-level app component and one websocket hook coordinate every domain.

Current behavior:

- `useTerminalSessions()` owns sessions, attention events, markdown documents, markdown links, workspace snapshot, socket state, and websocket behavior
- `App.tsx` then composes that together with toolbar state, modal state, notifications, focus behavior, and workspace persistence

Target behavior:

- separate domain stores or reducers:
  - workspace document store
  - terminal session store
  - markdown document store
  - attention store
  - backend status store if needed
- a thin realtime transport layer dispatches parsed events to the correct domain store
- `App.tsx` becomes composition and page-level wiring, not a behavior hub

Recommended structure:

- extract a websocket transport layer
- route incoming server messages to domain-specific state handlers
- keep websocket lifecycle separate from domain mutation logic

Possible modules:

- `src/web/state/useWorkspaceRealtime.ts`
- `src/web/state/useSessionStore.ts`
- `src/web/state/useAttentionStore.ts`
- `src/web/state/useMarkdownRealtime.ts`
- `src/web/state/useWorkspaceSocket.ts`

Likely files to change:

- `src/web/app/App.tsx`
- `src/web/state/useTerminalSessions.ts`
- `src/web/state/useWorkspace.ts`
- `src/web/state/useMarkdownDocuments.ts`

Key implementation notes:

- avoid introducing a heavy generic state library unless there is a clear reason
- a small reducer-based model is sufficient if the ownership is explicit
- preserve the current websocket protocol until server-side refactors are complete

Exit criteria:

- `App.tsx` is materially smaller and more declarative
- the websocket client is not also the primary owner of unrelated UI behavior
- each major realtime domain has a clearer local owner

### Stage 4: Break `BackendRuntimeManager` Into Adapters

Goal:

Turn backend runtime handling into a polymorphic adapter boundary rather than a single combined manager with embedded transport logic.

Current behavior:

- `BackendRuntimeManager` owns:
  - local PTY runtime integration
  - remote client lifecycle
  - session routing
  - attention routing
  - backend status aggregation
- `RemoteBackendClient` is nested inside it and implements one remote transport path inline

Target behavior:

- define a backend adapter interface
- implement local and remote adapters behind that interface
- let a small coordinator aggregate adapters

Suggested adapter responsibilities:

- `getSnapshots()`
- `getAttentionEvents()`
- `getStatus()`
- `sendInput()`
- `resizeSession()`
- `restartSession()`
- `markRead()`
- `subscribeSession()`
- `subscribeAttention()`
- `syncWithWorkspace()`
- `close()`

Possible modules:

- `src/server/runtime/backendAdapter.ts`
- `src/server/runtime/localBackendAdapter.ts`
- `src/server/runtime/remoteBackendAdapter.ts`
- `src/server/runtime/backendAdapterRegistry.ts`

Likely files to change:

- `src/server/runtime/backendRuntimeManager.ts`
- `src/server/ws/registerWorkspaceSocket.ts`
- `src/server/routes/sessions.ts`

Key implementation notes:

- preserve protocol compatibility while extracting interfaces
- keep session-to-backend indexing, but move transport-specific behavior into adapters
- do not duplicate local and remote command routing logic after extraction

Exit criteria:

- `BackendRuntimeManager` becomes a coordinator, not a transport implementation
- remote transport logic is no longer an inner class embedded in the manager

### Stage 5: Move Backend Provisioning Out Of The Route Layer

Goal:

Make backend routes thin HTTP adapters over a service layer.

Current behavior:

`src/server/routes/backends.ts` currently handles:

- request validation
- role checks
- SSH install setup
- token resolution
- tunnel provisioning
- tunnel readiness waiting
- remote health checks
- remote workspace import
- remote terminal create flow
- workspace mutation
- route-specific error shaping

Target behavior:

- routes parse and authorize requests
- a backend provisioning service performs the domain operation
- routes translate typed results or typed errors into HTTP responses

Possible modules:

- `src/server/backends/backendProvisioningService.ts`
- `src/server/backends/backendRegistrationService.ts`
- `src/server/backends/backendHealthClient.ts`
- `src/server/backends/remoteWorkspaceClient.ts`

Likely files to change:

- `src/server/routes/backends.ts`
- `src/server/runtime/sshSetupService.ts`
- `src/server/runtime/sshTunnelManager.ts`
- `src/server/persistence/workspaceService.ts`

Key implementation notes:

- this stage becomes much easier after Stages 1 and 2 because backend registration can become a workspace mutation command rather than manual route-local object surgery
- preserve route responses initially to avoid unnecessary frontend churn
- centralize tunnel-aware error enrichment in the service layer instead of in the route file

Exit criteria:

- `backends.ts` becomes substantially smaller
- backend provisioning logic is unit-testable without going through Fastify handlers

### Stage 6: Resolve `selectedNodeId`

Goal:

Remove the current ambiguity around whether `selectedNodeId` is collaborative durable state or local ephemeral UI state.

Current behavior:

- `selectedNodeId` exists in the shared `Workspace` schema
- `useCanvasUiState()` hydrates initial local selection from `workspace.selectedNodeId`
- after that, selection is primarily local UI state

That means the field currently has mixed semantics.

Decision options:

Option A: local-only UI state

- remove `selectedNodeId` from active durable ownership
- keep it local in `useCanvasUiState()`
- optionally leave schema compatibility for old saved workspaces during migration

Option B: collaborative durable state

- keep it in `Workspace`
- drive client selection directly from workspace mutations
- persist and broadcast intentional selection changes

Recommendation:

- choose Option A unless collaborative shared selection is a deliberate product requirement

Why:

- the current UI already behaves mostly this way
- it reduces workspace churn
- it aligns with the broader principle of separating durable document state from local interaction state

Likely files to change:

- `src/shared/workspace.ts`
- `src/web/canvas/useCanvasUiState.ts`
- `src/web/app/App.tsx`
- `src/web/state/useWorkspace.ts`
- tests referencing workspace-level selection behavior

Migration note:

- if removing the field from the durable schema is too disruptive initially, mark it as deprecated compatibility data first and stop writing it before deleting it

Exit criteria:

- there is one clear semantic owner for selection
- selection changes no longer ambiguously straddle persisted and local state

## Recommended Sequencing

Recommended PR order:

1. Stage 0 characterization tests
2. Stage 1 workspace command API
3. Stage 2 persistence versus reconciliation split
4. Stage 6 `selectedNodeId` resolution
5. Stage 3 client store split
6. Stage 4 backend adapter extraction
7. Stage 5 backend provisioning service extraction

Reasoning:

- Stages 1 and 2 create the strongest server-side boundaries
- Stage 6 is small but clarifies state ownership early
- Stage 3 benefits from the clearer mutation model
- Stages 4 and 5 are easier once workspace mutation ownership is explicit

## Acceptance Criteria

The refactor is complete when all of the following are true:

- normal workspace mutations are expressed as server-owned commands or patches rather than full-document replacement
- the generic UI path no longer depends on `PUT /api/workspace` with the whole workspace body
- workspace persistence and runtime reconciliation are distinct responsibilities
- the client’s realtime state is split by domain rather than centered in one broad hook
- `App.tsx` is no longer a coordination hub for most business logic
- backend runtime transport logic lives behind a clear adapter interface
- backend provisioning is implemented in a service layer rather than primarily in Fastify route handlers
- `selectedNodeId` has one clear semantic meaning and one clear owner

## Manual Validation Matrix

Run these scenarios after each behavior-changing stage:

- start the app and confirm initial workspace load still works
- add, remove, and update terminals
- pan and zoom the canvas
- change layout mode
- save a camera preset
- create and open markdown documents
- add and remove a backend
- create a remote terminal from a backend
- restart the server and confirm persisted workspace state reloads correctly
- verify websocket `workspace.updated` behavior with at least two browser tabs if practical
- verify conflict behavior during concurrent mutations if two clients are open

## Suggested Commands

Recommended verification commands:

```bash
npm run typecheck
npm run test
npx vitest run src/server/runtime/backendRuntimeManager.test.ts
npx vitest run src/server/persistence/workspaceStore.test.ts
npx vitest run src/web/state/workspaceActions.test.ts
npx vitest run src/web/state/useTerminalSessions.test.ts
```

Add focused test commands for any new modules introduced during the refactor.

## Implementation Notes

- prefer incremental migration over big-bang replacement
- keep the websocket protocol stable until the mutation boundary is in place
- preserve backward compatibility for loading existing workspace files where practical
- centralize ID generation and revision handling on the server as the mutation model matures
- avoid introducing new abstractions that only rename the current coupling
- when in doubt, prefer an explicit owner over a shared helper

## Summary

The core architectural problem is that the repository still treats durable workspace state too much like a replaceable client-owned document, while also using realtime server-driven state for other domains.

The most important changes are:

- make workspace mutations intent-oriented
- separate persistence from reconciliation
- shrink the client coordination surface
- turn backend runtime into adapters
- move provisioning into services
- resolve selection ownership explicitly

If done in the sequence above, the codebase should become easier to reason about, easier to test, and less likely to regress as more collaborative or multi-backend behavior is added.
