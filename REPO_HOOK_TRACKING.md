# Repo Hook Tracking Plan

## Goal

Build repo-aware terminal integration tracking in a way that is reusable for Claude, Codex, and future agent types.

The design goal is a single generic pipeline:

`PTY cwd change -> session context update -> project root resolution -> agent provider prepare step -> generic status surfaced to UI`

Claude should be the first provider built on top of that pipeline, not the architecture itself.

## Plan

### 1. Add a generic live terminal context model on the server

Track per-session runtime state in `src/server/pty/ptySessionManager.ts`, separate from persisted launch metadata.

Include:

- live cwd
- resolved project root
- active agent type
- integration status per agent
- last integration result or error

This state should be runtime-only and derived from the live shell session.

### 2. Separate shell cwd detection from agent integration

Build cwd tracking as neutral infrastructure.

For PowerShell, inject a prompt or profile snippet that emits a machine-readable cwd marker whenever the prompt renders.

The PTY manager should parse that marker and update session context.

This layer should know nothing about Claude, Codex, or any other agent-specific config.

### 3. Introduce a generic agent integration interface

Create an integration abstraction instead of calling Claude setup logic directly from the PTY manager.

The interface should cover concepts like:

- `supports(agentType)`
- `resolveProjectRoot(cwd)`
- `prepareForProject(session, projectRoot)`
- `describeStatus(result)`

Claude becomes one provider implementation. Codex and future agents can plug into the same lifecycle later.

### 4. Move Claude hook logic behind that interface

Wrap `src/server/integrations/claudeHookSetup.ts` as a `claude` integration provider.

The Claude provider should own:

- repo discovery policy
- local config bootstrap
- managed hook merge and conflict rules
- status reporting

The PTY manager should orchestrate provider calls, not know Claude file formats.

### 5. Drive integration work from project-root changes, not Claude-only branches

When live cwd changes:

1. resolve the new project root
2. compare it with the last prepared root
3. invoke the current agent provider if preparation is needed

That makes repo transitions reusable for any agent type that needs per-project setup.

### 6. Support first-time bootstrap generically

Define shared integration statuses for all providers:

- `not-required`
- `not-configured`
- `configuring`
- `configured`
- `conflict`
- `error`

Claude can implement `not-configured -> configured` by creating `.claude/settings.local.json` with only the managed Notification hook.

Codex can later use the same lifecycle for its own repo-local bootstrap without changing the PTY or session model.

### 7. Keep provider-specific writes narrowly owned

Each provider should only modify files and config entries it owns.

Examples:

- Claude: only the Terminal Canvas managed Notification hook entry
- Codex: only Codex-specific repo-local configuration if and when needed

This avoids spreading format-specific logic into the session manager.

### 8. Serialize and debounce integration work per session

Keep one in-flight integration task per session and project root.

Track:

- current live cwd
- current resolved project root
- last prepared project root
- integration currently running
- last integration result

This prevents prompt redraws or repeated cwd reports from causing duplicate writes.

### 9. Expose generic integration state to the UI

Extend `src/shared/terminalSessions.ts` so the frontend can display:

- live cwd
- resolved project root
- integration owner or agent type
- integration state
- integration message

The UI should present one consistent status model across Claude, Codex, and future providers.

### 10. Add provider registration rather than branching everywhere

Create an integration registry under `src/server/integrations/` that maps `agentType` to provider.

Session logic should become:

1. look up provider for `terminal.agentType`
2. if no provider exists, skip integration work
3. if a provider exists, run the shared lifecycle

This keeps Claude and Codex conditionals from spreading through the backend.

### 11. Make non-repo and fresh-repo behavior explicit

For directories that are not yet identifiable as a repo or project root, do not create agent config eagerly.

The provider should defer setup until a valid project root can be resolved.

For fresh repos with no Claude config yet:

- detect the repo root
- create the minimal repo-local file owned by Terminal Canvas
- mark the integration as configured

For repos with incompatible existing config:

- do not overwrite it
- mark the integration as conflict
- surface a clear message in the session snapshot and UI

### 12. Add focused tests for the framework and the first provider

Generic framework tests:

- cwd changes update live session context
- project-root changes trigger provider preparation exactly once
- repeated cwd reports are deduped
- non-integrated agent types do nothing

Claude provider tests:

- moving within the same repo does not rewrite config
- moving into a new repo triggers setup
- entering a repo with no Claude config bootstraps the managed local file
- incompatible existing Notification hooks report conflict
- non-repo directories do not get `.claude` created prematurely

### 13. Roll out in stages

Stage 1:

- generic cwd tracking
- runtime session context
- integration provider interface and registry

Stage 2:

- Claude provider migrated onto the shared integration framework

Stage 3:

- UI support for generic integration state

Stage 4:

- Codex provider
- future provider implementations as needed

## Expected Outcome

The finished system should behave like this:

- moving within the same repo does nothing
- moving into a fresh repo can bootstrap supported agent integration cleanly
- moving into a repo with conflicting config is visible but non-destructive
- adding Codex or another agent later does not require redesigning the PTY/session lifecycle
