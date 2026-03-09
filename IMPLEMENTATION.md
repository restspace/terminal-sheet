# Implementation Plan: Terminal Canvas

## 1. Purpose

This document turns `PRD.md` into an execution plan for a v1 release of Terminal Canvas: a local-first Node CLI that launches a browser workspace for supervising 4-6 AI-driven terminal sessions alongside Markdown files, with support for up to 8 live read-only terminal previews and one focused read/write terminal.

The plan is milestone-based rather than date-based so it can scale to a solo builder or a small team.

## 2. Recommended v1 decisions

These choices close the main open questions in the PRD so implementation can start without churn:

- Backend: use `Fastify` with WebSocket support for a small, typed local server.
- Frontend: use `React` + `Vite`.
- Canvas: use `React Flow` for pan/zoom, selection, and node positioning.
- Terminal rendering: use `xterm.js`.
- PTY layer: use `node-pty`.
- Markdown editor: use `CodeMirror 6` with a rendered preview pane.
- Persistence: store workspace state in local JSON files for v1.
- Notifications: support browser notifications in v1; keep sound optional and native OS notifications out of scope unless trivial.
- Codex integration: support `notify` in v1; defer app-server integration to post-MVP.
- Session durability: persist layout and session metadata in v1, but do not attempt tmux-backed process resurrection yet.
- Zoom strategy: below the overview threshold, suspend live xterm rendering and show semantic cards instead.
- Terminal mounting strategy: allow up to 8 non-focused live read-only xterm previews while keeping exactly one focused terminal read/write.

## 3. Target v1 scope

The implementation should deliver:

- `terminal-canvas` CLI with `--port`, `--workspace`, and `--no-open`
- localhost-only server startup
- browser canvas with PTY-backed terminal nodes, supporting up to 8 live read-only previews plus one focused read/write terminal
- semantic zoom with Overview, Inspect, and Focus modes
- Markdown nodes with edit and preview
- attention pipeline for Claude hooks, Codex `notify`, and PTY fallback detection
- event feed, filters, and jump-to-attention interactions
- local workspace persistence and restore

The implementation should explicitly defer:

- multi-user collaboration
- remote hosting
- non-Markdown documents
- direct Codex app-server integration
- tmux-backed session durability

## 4. Proposed repository structure

Use a single TypeScript project unless repo scale forces a monorepo later.

```text
src/
  cli/
    index.ts
  server/
    app.ts
    routes/
    ws/
    pty/
    integrations/
    persistence/
  web/
    main.tsx
    app/
    canvas/
    terminals/
    markdown/
    event-feed/
    state/
  shared/
    schema.ts
    events.ts
    workspace.ts
docs/
  PRD.md
  IMPLEMENTATION.md
```

If build complexity grows, split later into `packages/server`, `packages/web`, and `packages/shared`.

## 5. Core architecture

### Backend responsibilities

- Parse CLI arguments and start the local server.
- Spawn and manage PTY sessions per terminal node.
- Stream PTY output to the browser over WebSocket.
- Accept external attention events from Claude and Codex integrations.
- Normalize all activity into a shared internal event schema.
- Persist workspace state and reload it on startup.

### Frontend responsibilities

- Render the canvas and camera controls.
- Switch node presentation by semantic zoom level.
- Render up to 8 live read-only terminals in Inspect/Focus within the preview budget.
- Render exactly one read/write terminal in Focus mode.
- Render Markdown nodes as card, preview, or editor.
- Show attention badges, minimap markers, event feed, and filters.
- Keep local UI state synchronized with server state.

### Shared contracts

Define shared TypeScript schemas early for:

- `Workspace`
- `NodeLayout`
- `TerminalNode`
- `MarkdownNode`
- `AttentionEvent`
- `TerminalStatus`
- `CameraPreset`

This schema layer is a first milestone deliverable because it prevents backend and frontend drift.

## 6. Milestones

### Milestone 0: Foundation and project bootstrap

#### Status

Completed on 2026-03-09.

#### Goals

- Create the TypeScript project skeleton.
- Establish the build, dev, and test workflow.
- Lock the shared schema and initial architecture.

#### Tasks

- Initialize Node + TypeScript + Vite project.
- Add linting, formatting, and test runner.
- Define shared types for workspace, nodes, and normalized events.
- Implement a minimal Fastify server and React app shell.
- Add CLI entrypoint with argument parsing.
- Add a dev command that starts server and web client together.

#### Exit criteria

- `terminal-canvas` starts a localhost server.
- Browser opens automatically unless `--no-open` is passed.
- A blank canvas loads successfully.
- Shared types are imported by both server and frontend.

### Milestone 1: Workspace shell and persistence

#### Status

Completed on 2026-03-09.

#### Goals

- Deliver the base canvas interaction model.
- Make workspace state durable.

#### Tasks

- Add React Flow canvas with pan, zoom, selection, and drag.
- Define semantic zoom thresholds for Overview, Inspect, and Focus.
- Implement camera presets: All sessions, Needs attention, Active pair, Writing surface.
- Create local JSON persistence format for workspace state.
- Persist node positions, sizes, tags, links, filters, and camera presets.
- Restore the last workspace on startup by default.

#### Exit criteria

- Users can create, move, resize, and persist placeholder nodes.
- Camera presets can be saved and recalled.
- Reloading the page preserves layout and workspace metadata.

### Milestone 2: PTY session manager and terminal nodes

#### Status

Completed on 2026-03-09.

#### Goals

- Turn terminal nodes into real local sessions.
- Support reconnects, live previews, and interactive focus.

#### Tasks

- Build PTY session manager on top of `node-pty`.
- Add terminal node creation with shell, cwd, label, and agent type.
- Stream PTY output and input over WebSocket.
- Attach `xterm.js` for up to 8 non-focused read-only previews and one focused read/write terminal.
- Enforce single-terminal input ownership so only the focused terminal can send keyboard input.
- Store scrollback and a rolling output summary per session.
- Reconnect the browser to live sessions after refresh.
- Mark disconnected sessions and expose recovery states.

#### Exit criteria

- Multiple concurrent terminals can run side by side.
- A refreshed browser reconnects without losing session identity.
- Up to 8 non-focused terminals can remain mounted as live read-only previews.
- Users can type into the focused terminal and see live output.
- Overview mode no longer depends on live tiny text rendering.

### Milestone 3: Semantic node rendering

#### Goals

- Make the 4-6 terminal supervision use case actually readable.

#### Tasks

- Build terminal card view for Overview mode.
- Build live read-only terminal preview view for Inspect mode.
- Build fully interactive terminal view for the focused terminal in Focus mode.
- Keep up to 8 non-focused terminals mounted as live read-only previews while the focused terminal remains read/write.
- Add unread activity count, status stripe, last event time, and last meaningful line.
- Add smooth camera transition and delayed input focus when entering Focus mode.
- Dim non-focused nodes while preserving spatial orientation.

#### Exit criteria

- Overview shows all 4-6 sessions clearly as supervision objects.
- Inspect mode exposes enough live context for comparison without stealing input focus.
- Focus mode feels immediate and stable.

### Milestone 4: Attention event pipeline

#### Goals

- Convert agent events into visible, actionable attention states.

#### Tasks

- Implement normalized event schema on the backend.
- Add local hook receiver endpoint with shared-token validation.
- Build Claude Notification hook integration and setup helper output.
- Build Codex `notify` integration and setup helper output.
- Add PTY fallback heuristics for bell, OSC, and known waiting prompts.
- Map events to terminal statuses: idle, running, active-output, needs-input, approval-needed, completed, failed, disconnected.
- Add event feed, badge updates, and jump-to-next-attention shortcut.
- Add optional browser notifications and optional sound toggle.

#### Exit criteria

- Claude and Codex can both trigger attention states for the correct node.
- The event feed updates in real time.
- Users can jump directly to the next node needing action.
- Fallback detection works but is marked as lower confidence.

### Milestone 5: Markdown nodes and linking

#### Goals

- Make Markdown files first-class workspace objects.

#### Tasks

- Add Markdown node creation and open-from-disk flow.
- Implement low-zoom card, medium-zoom preview, and close-zoom editor modes.
- Add CodeMirror editing with syntax highlighting.
- Add rendered preview pane with checklist, heading, link, and code fence support.
- Add autosave, read-only mode, and external-change detection.
- Add links from Markdown nodes to terminal nodes with relationship labels such as `plan`, `spec`, and `notes`.
- Add filter for terminals linked to the selected Markdown node.

#### Exit criteria

- Markdown nodes can be edited inline and saved to disk.
- A Markdown node can stay spatially paired with several terminals.
- Linked-node filters work from the canvas UI.

### Milestone 6: Organization, filtering, and event ergonomics

#### Goals

- Improve operational supervision for larger workspaces.

#### Tasks

- Add filters for agent type, attention state, repo, tag, running/completed, and linked Markdown node.
- Add grouping metadata for task, repo, agent, and urgency.
- Add minimap markers for attention nodes.
- Add unread indicators and event timestamps.
- Add keyboard shortcuts from the PRD: `F`, `Shift+F`, `1`, `2`, `Esc`.
- Add initial 2 x 3 supervision-grid starter layout with a central Markdown area and right-side event rail.

#### Exit criteria

- Users can isolate the most important sessions quickly.
- First-launch layout supports the 4-6 terminal supervision workflow.
- Keyboard navigation reduces pointer-only interaction.

### Milestone 7: Hardening, packaging, and release prep

#### Goals

- Make the product stable enough for daily local use.

#### Tasks

- Profile CPU and memory with up to 8 read-only live terminals, 1 focused read/write terminal, and 2 Markdown nodes.
- Cap render frequency for live previews, overview summaries, and event-feed updates.
- Test on macOS, Linux, and Windows with special focus on ConPTY behavior.
- Add crash-safe persistence writes and workspace-file validation.
- Package CLI for `npx terminal-canvas` and global install.
- Write setup docs for Claude hooks and Codex `notify`.
- Add a short demo workspace and smoke-test scenario.

#### Exit criteria

- v1 performance is acceptable on mainstream developer hardware.
- Windows PTY behavior is validated early enough to avoid late surprises.
- A new user can install, launch, and connect Claude/Codex with written docs only.

## 7. Parallel workstreams

These can run partly in parallel after Milestone 0:

- Workstream A: backend server, PTY manager, event normalization, persistence
- Workstream B: canvas, node rendering, camera transitions, filters
- Workstream C: Markdown editing and linked-node workflows
- Workstream D: Claude/Codex setup helpers and attention integrations
- Workstream E: testing, fixtures, performance instrumentation, release docs

Main dependency constraints:

- Shared schema must land before backend/frontend work diverges.
- PTY manager must exist before true terminal node UX can be validated.
- Semantic zoom must exist before performance tuning has real meaning.
- Attention integrations depend on stable session identity and event routing.

## 8. Testing strategy

### Unit tests

- workspace schema validation
- event normalization
- persistence serialization/deserialization
- PTY summary extraction and fallback heuristics
- Markdown link and autosave logic

### Integration tests

- CLI startup with flags
- WebSocket session attach/reconnect
- hook receiver authorization and event routing
- workspace restore across relaunch
- file change detection for Markdown nodes

### End-to-end tests

- launch app, create 8 terminal nodes, keep one focused terminal read/write while others remain live read-only, and restore workspace
- trigger Claude and Codex notifications into the correct nodes
- zoom from overview to focus and back
- edit Markdown beside active terminals
- jump to attention node via keyboard shortcut

### Manual acceptance pass

Run one realistic scenario:

- open a workspace with 6-8 terminals
- keep a plan Markdown node in the center
- trigger at least one Claude attention event and one Codex attention event
- verify up to 8 terminals stay live in read-only mode while one focused terminal remains read/write
- navigate entirely through overview, inspect, and focus modes
- close and relaunch the app and verify workspace restore

## 9. Risks and mitigations

### Risk: xterm performance collapses with many live sessions

Mitigation:

- limit live xterm mounts to one focused read/write terminal plus up to 8 read-only previews
- fall back from live previews to summaries when the preview budget is exceeded
- throttle non-critical UI updates

### Risk: Claude and Codex event payloads differ too much

Mitigation:

- normalize immediately at the server boundary
- treat source adapters as isolated modules with fixtures
- ship v1 with `notify` for Codex and avoid app-server scope creep

### Risk: session restoration is interpreted as process resurrection

Mitigation:

- separate "workspace restore" from "process survives restart"
- persist session metadata and disconnected state clearly
- defer durable shell resurrection to post-MVP

### Risk: Windows PTY behavior causes late-stage regressions

Mitigation:

- validate ConPTY behavior by Milestone 2, not at release time
- keep shell launch and resize logic under integration tests

### Risk: file-system edits and external Markdown changes conflict

Mitigation:

- autosave frequently
- add visible unsaved/external-change states
- define simple conflict handling for v1: reload, overwrite, or keep buffer

## 10. Definition of done for v1

The v1 release is complete when all of the following are true:

- Users can launch the app from the CLI and reach a local browser workspace.
- Users can supervise 4-6 active terminal sessions on one canvas, with up to 8 non-focused live read-only previews and one focused read/write terminal.
- Overview, Inspect, and Focus modes behave as distinct semantic zoom states.
- Claude Notification hooks and Codex `notify` both map into visible attention states.
- Markdown nodes can be edited and previewed on the same surface.
- Workspace layout, links, filters, and camera presets persist across relaunch.
- Performance is acceptable with up to 8 read-only live terminals, 1 focused read/write terminal, and 2 Markdown nodes on mainstream hardware.
- Basic setup documentation is sufficient for another developer to install and use the product locally.

## 11. Recommended implementation order

Build in this order to reduce rework:

1. Shared schemas, CLI shell, and blank canvas
2. Workspace persistence and semantic zoom scaffolding
3. PTY manager and focused terminal interaction
4. Overview and Inspect terminal representations
5. Attention pipeline and event feed
6. Markdown nodes and linking
7. Filters, shortcuts, starter layout, and polish
8. Packaging, docs, cross-platform validation, and release hardening

## 12. Immediate next actions

The first engineering sprint should produce:

- project scaffold with TypeScript, Fastify, Vite, React, React Flow, xterm.js, CodeMirror, and node-pty
- shared schema definitions
- CLI startup path with `--port`, `--workspace`, and `--no-open`
- blank persisted canvas with placeholder terminal and Markdown nodes

That is the minimum foundation needed before building the live terminal and attention workflows.
