# PRD: Terminal Canvas

## 1) Product summary

**Terminal Canvas** is a local-first Node application that starts from a single CLI command, launches a local web server, and opens a browser-based infinite workspace for supervising multiple AI-assisted terminal sessions side by side. The core use case is a developer watching **4–6 active terminals at once**, quickly spotting which agent needs attention, and zooming fluidly between a bird’s-eye overview and an interactive close-up.

The product supports:

- live terminal sessions on a pan/zoom work surface
- attention hooks for **Claude Code** and **Codex**
- Markdown files as first-class workspace objects, viewable and editable on the same surface
- local-only operation by default

This approach matches the current ecosystem well: **Claude Code** offers official hooks including a **Notification** hook for attention events, while **Codex** supports a configurable external `notify` program and also exposes a richer **app-server** interface for structured client integrations. 

------

## 2) Problem

Developers increasingly run multiple agent sessions in parallel, but today the monitoring experience is fragmented:

- terminals are stacked in tabs or windows with poor situational awareness
- important events are easy to miss
- zooming out to manage many sessions usually makes terminals unreadable
- notes, plans, and Markdown specs live in separate apps instead of alongside the terminals doing the work

For users supervising 4–6 sessions, the real need is not just “more terminals.” It is:

- **fast attention routing**
- **stable spatial memory**
- **smooth transitions between overview and focus**
- **shared surface for terminals and project documents**

------

## 3) Target user

**Primary user:** software engineer / technical lead / AI-heavy developer who runs several terminal-based coding agents in parallel.

**Common scenarios:**

- monitoring 4–6 Claude Code / Codex sessions across related tasks
- comparing output between branches, repos, or worktrees
- keeping a plan/spec Markdown file visible while agents work
- noticing which session needs approval, input, or review

------

## 4) Goals

### User goals

- See all active sessions at once.
- Know immediately which session requires attention.
- Zoom into any session with minimal friction.
- Keep Markdown specs, notes, or task checklists on the same workspace.
- Restore the workspace later exactly as it was.

### Product goals

- Launch from a single Node CLI installation.
- Work locally in a browser with low setup overhead.
- Support 4–6 live terminals smoothly on mainstream developer hardware.
- Integrate with official Claude Code and Codex notification mechanisms where available.
- Remain useful even when structured hooks are unavailable by falling back to PTY-level detection.

------

## 5) Non-goals

- Replace full-featured IDEs.
- Become a generic whiteboard tool like Miro.
- Depend on cloud infrastructure for core operation.
- Build a custom terminal renderer from scratch.
- Provide remote multi-user collaboration in v1.

------

## 6) Product principles

1. **Local first**
    The app runs on localhost and stores workspaces locally by default.
2. **Real terminals, not screenshots**
    Each terminal remains a true interactive terminal widget, preserving keyboard input, selection, mouse support, and TUI compatibility.
3. **Overview first, focus fast**
    The user should always be able to answer: “Which session needs me right now?”
4. **Spatial consistency**
    Terminal and Markdown nodes stay where the user placed them, enabling long-term memory of the workspace.
5. **Graceful detail scaling**
    At far zoom levels, terminals should degrade into summaries/previews instead of tiny unreadable live text.

------

## 7) Proposed solution

A Node CLI tool starts a local server and serves a browser UI containing:

- an infinite pan/zoom workspace
- draggable terminal nodes
- draggable Markdown editor/viewer nodes
- an attention layer showing which nodes need user action

Each terminal node is backed by a PTY and rendered in the browser with a terminal component. This is the right architectural shape because xterm.js is built for browser terminal rendering, and `node-pty` is the standard Node PTY layer, including Windows support through ConPTY-backed behavior in its Windows implementation. 

------

## 8) Core user experience

## 8.1 Workspace modes

### Overview mode

Used when zoomed out enough to monitor all 4–6 sessions.

Each terminal node shows:

- title
- repo / branch / task label
- agent type badge: Claude / Codex / Shell
- status color
- unread activity count
- attention badge if action needed
- last event time
- tiny text preview or last line summary
- optional sparkline-style activity pulse

Each Markdown node shows:

- filename
- small content preview
- pinned / linked status

In this mode, terminals are **not optimized for line-by-line reading**. They are supervision objects.

### Focus mode

Used when zoomed in to work directly in one terminal or Markdown file.

The selected terminal becomes fully interactive:

- keyboard capture enabled
- xterm instance at readable font size
- scrollback visible
- command input immediate
- notifications visible in side rail

The rest of the canvas remains visible but de-emphasized.

### Inspect mode

A middle zoom band between Overview and Focus.

Terminal node shows:

- recent transcript preview
- current prompt / status line
- key metadata
- condensed recent events

This bridges the gap between “map” and “terminal.”

------

## 8.2 Zoom behavior for 4–6 terminals

The zoom model should be **semantic**, not just geometric.

### Zoomed far out

Best for monitoring 4–6 sessions simultaneously.

- each terminal appears as a card, not a mini terminal
- no live tiny text rendering
- show status, labels, last event, and attention indicators
- clicking a card centers it and zooms to Inspect

### Medium zoom

Best for comparing 2–3 sessions.

- terminal preview becomes richer
- a few readable transcript lines appear
- user can glance at outputs without fully entering terminal interaction

### Close zoom

Best for active work in one session.

- terminal becomes full xterm interactive surface
- Markdown nodes become full editor panes
- surrounding nodes remain in peripheral vision

### Recommended interaction shortcuts

- mouse wheel / trackpad pinch: semantic zoom
- double-click terminal: zoom to Focus
- `Space` + drag: pan canvas
- `F`: focus selected node
- `Shift+F`: return to previous overview framing
- `1`: fit all active attention nodes
- `2`: fit all active terminals
- `Esc`: exit terminal input and return to canvas navigation

### Camera presets

For the 4–6 terminal use case, include:

- **All sessions**
- **Needs attention**
- **Active pair**
- **Writing surface** (Markdown + linked terminals)

This is more useful than freeform zoom alone.

------

## 9) Functional requirements

## 9.1 CLI and startup

The product must support:

- `npx terminal-canvas`
- `terminal-canvas`
- `terminal-canvas --port 4312`
- `terminal-canvas --workspace ./workspace.json`
- `terminal-canvas --no-open`

Behavior:

- start a local server
- open browser automatically unless disabled
- restore last workspace by default
- expose a localhost-only interface by default

------

## 9.2 Terminal nodes

Users can:

- create a terminal node
- assign a shell, working directory, and label
- launch Claude Code / Codex / plain shell in that node
- resize and move node
- duplicate node layout
- persist terminal metadata and layout

System must support:

- PTY-backed session per node
- scrollback
- reconnect after page refresh
- session restoration metadata
- terminal grouping/tagging

------

## 9.3 Notification and attention system

### Claude Code

Claude Code supports hooks, including a **Notification** hook specifically intended for attention events, and hook workflows can execute custom shell commands with structured input. This is the primary integration for Claude-based attention signals. 

**Requirement:**

- app provides a local hook receiver
- setup helper generates Claude hook config or command snippet
- when Claude needs attention, the relevant terminal node is marked as:
  - `needs-input`
  - `approval-needed`
  - `task-finished`
  - `error`

### Codex

Codex supports an external **`notify`** command in advanced configuration, and official docs describe event-driven notifications such as `agent-turn-complete`. Codex also documents a richer **app-server** interface for structured client integration over JSON-RPC. 

**Requirement:**

- v1 supports Codex attention through `notify`
- v1.1 or advanced mode may support direct app-server integration
- app provides a generated config snippet for Codex
- Node backend maps Codex events into internal attention states

### Fallback detection

When no structured hook exists:

- inspect PTY output for bell / OSC notifications where available
- optionally pattern-detect known “approval” or “waiting” prompts
- label these as lower-confidence attention events

### Attention states

Every terminal node can be in one of:

- idle
- running
- active-output
- needs-input
- approval-needed
- completed
- failed
- disconnected

### Notification surfaces

When a node requires attention:

- red or amber badge appears on node
- minimap marks node location
- optional browser notification
- optional sound
- “needs attention” filter updates instantly
- keyboard shortcut jumps to next attention node

------

## 9.4 Markdown nodes

Users can:

- create a Markdown file node
- open an existing `.md` file from disk
- edit Markdown inline on the canvas
- split view between source and rendered preview
- pin a Markdown file beside one or more terminals
- link terminal nodes to a Markdown node as “plan,” “spec,” or “notes”

### Markdown node modes

- card preview at low zoom
- rendered preview at medium zoom
- full editor at close zoom

### Editor requirements

- syntax-highlighted Markdown source
- rendered preview pane
- autosave to file
- local unsaved-state indicator
- support for checklists, code fences, links, headings
- optional read-only mode

### Spatial workflow

A user should be able to place:

- a project plan Markdown node in the center
- 4–6 terminal nodes around it
- zoom out to supervise
- zoom in to edit plan and compare terminal outputs nearby

------

## 9.5 Workspace persistence

Must persist:

- node positions and sizes
- zoom/camera presets
- terminal labels and launch commands
- Markdown file references
- linked-node relationships
- filters and grouping

Should persist:

- terminal session metadata
- last known statuses
- node colors / tags

------

## 9.6 Filtering and organization

User can filter workspace by:

- agent type
- attention state
- repo
- tag
- running/completed
- linked to current Markdown file

User can group by:

- task
- repo
- agent
- urgency

------

## 10) UX details

## 10.1 Recommended default layout for 4–6 terminals

On first launch:

- canvas opens with a **2 x 3 supervision grid**
- center area reserved for a Markdown spec or note node
- right rail shows event feed
- top bar includes:
  - add terminal
  - add Markdown
  - focus filters
  - jump to attention

This layout directly supports “watch 4–6 terminals at once.”

## 10.2 Event feed

A compact event rail shows:

- terminal A needs approval
- terminal C finished task
- terminal D waiting for input
- Markdown file changed externally

Clicking an event centers and zooms to the node.

## 10.3 Terminal low-zoom representation

At overview zoom, do **not** render full tiny glyph output. Instead show:

- title
- colored status stripe
- most recent meaningful line
- elapsed task time
- unread dot
- optional agent icon

This is critical for readability.

## 10.4 Focus transition

When opening a terminal from overview:

- animated camera move to node
- node expands slightly
- input focus delayed until camera settles
- background nodes dim but remain visible

This preserves orientation.

------

## 11) Technical architecture

## 11.1 Stack

### Backend

- Node.js CLI
- Fastify or Express
- WebSocket server
- PTY manager via `node-pty`
- local persistence in JSON initially, SQLite later

### Frontend

- React
- React Flow or equivalent pan/zoom scene graph
- xterm.js for terminal rendering
- Monaco or CodeMirror for Markdown source editing
- Markdown renderer for preview

### Integration layer

- local HTTP endpoint for hooks
- optional local Unix socket / named pipe alternative
- notification normalization service mapping Claude/Codex events to internal states

------

## 11.2 Event pipeline

1. terminal session launches
2. agent runs inside PTY
3. agent emits hook or notify event
4. local receiver accepts event
5. event normalized to internal schema
6. workspace UI updates target node
7. optional browser/system notification shown

### Internal normalized event schema

```
{
  "sessionId": "abc123",
  "source": "claude|codex|pty",
  "eventType": "needs-input|approval-needed|completed|error|activity",
  "timestamp": "2026-03-09T12:00:00Z",
  "title": "Claude needs approval",
  "detail": "Review proposed file edits",
  "confidence": "high|medium|low"
}
```

------

## 12) Security and privacy

- localhost-only bind by default
- no cloud sync in v1
- all terminal traffic stays local unless user’s agents themselves access remote services
- hook receiver should validate local origin or shared token
- workspace files stored locally
- clear warning when exposing server beyond localhost

------

## 13) Success metrics

### Primary

- user can monitor 4–6 terminals without switching OS windows
- time to locate next attention-demanding terminal is under 2 seconds
- user can move from overview to interactive terminal in one gesture plus one click
- user keeps Markdown spec on canvas during active sessions in at least 50% of sessions

### Secondary

- attention events correctly mapped for Claude and Codex
- workspace restored successfully across relaunches
- acceptable performance with 6 live terminals and 2 Markdown nodes

------

## 14) MVP scope

### In scope

- Node CLI startup
- browser workspace
- 4–6 PTY-backed terminal nodes
- pan/zoom canvas
- semantic zoom states
- Claude Notification hook integration
- Codex `notify` integration
- Markdown nodes with edit + preview
- local persistence
- attention filters and jump shortcuts

### Out of scope

- multi-user collaboration
- remote deployment
- Git visualization
- rich drawing tools
- non-Markdown document types
- direct Codex app-server integration in first release

------

## 15) Post-MVP roadmap

### Phase 2

- Codex app-server integration for richer structured events
- task timelines per terminal
- saved workspace templates
- tmux-backed session durability
- cross-workspace search

### Phase 3

- collaborative shared canvases
- voice / audio alerts with priority classes
- links between Markdown checklist items and terminals
- snapshots / replay mode
- remote agents and cloud workspace sync

The roadmap is justified by current official docs: Claude already supports hooks for attention automation, while Codex’s app-server offers the richer future-facing structured client model beyond simple notify callbacks. 

------

## 16) Open questions

- Should v1 support only browser notifications, or also native OS notifications?
- Should terminal sessions persist independently via tmux/screen on Unix?
- Should Markdown nodes allow embedded terminal references or command snippets?
- How aggressively should the app suspend live terminal rendering at far zoom levels?
- Should Codex app-server integration replace `notify` entirely in a later release, or remain optional?

------

## 17) Recommendation

Build v1 as a **local Node CLI + browser app** with:

- `node-pty`
- xterm.js
- React Flow
- Markdown editor/viewer nodes
- official Claude hook support
- Codex `notify` support
- semantic zoom tuned specifically for supervising **4–6 terminals**

That gives you the right first product: a **terminal operations surface**, not just a terminal multiplexer with prettier windows.