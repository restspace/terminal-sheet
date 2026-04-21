# Terminal Sheet

Terminal Sheet is a local-first, browser-based workspace for arranging live terminals and Markdown editors on an infinite zoomable canvas. Think of it as a Miro-style work surface for developer workflows: terminals, agent sessions, notes, plans, and project documents can sit side by side, stay where you put them, and be zoomed between overview and focus.

The main use case is supervising several terminal-based coding agents at once. You can keep multiple PTY-backed sessions visible, spot which one needs attention, zoom into the active terminal to type, and keep Markdown notes or specs on the same canvas.

## Status

This is an early local development project. The app currently runs as a Node CLI that starts a localhost Fastify server and serves a React/Vite canvas UI.

## Features

- Infinite pan/zoom canvas for terminal and Markdown nodes.
- Real PTY-backed terminal sessions through `node-pty`.
- Browser terminal rendering through `xterm.js`.
- One focused read/write terminal with background live previews.
- Markdown documents as first-class workspace objects with editing and preview.
- Local JSON workspace persistence.
- Attention/event plumbing for agent-oriented workflows.
- Optional home/remote server roles for hosting terminals from other machines through one browser-facing home server.

## Quick Start

Requirements:

- Node.js `>=20.11.0`

Install dependencies:

```sh
npm install
```

Run the full development stack:

```sh
npm run dev
```

Run the web and server processes separately:

```sh
npm run dev:web
npm run dev:server
```

Build and start the production output:

```sh
npm run build
npm run start
```

The default server binds to `127.0.0.1:4312`. Local workspace state is stored under `.terminal-canvas/workspace.json` unless a custom workspace path is supplied.

## CLI

The built CLI is exposed as both `tsheet` and `terminal-canvas`.

```sh
tsheet serve [--port <n>] [--workspace <path>] [--role <standalone|home|remote>] [--no-open]
tsheet open <path> [--server <url>]
tsheet spawn --command "..." [--label "..."] [--cwd "."] [--agent-type shell]
tsheet token <show|rotate> [--workspace <path>]
tsheet backend add --label <name> --url <remote-url> --token <token> [--server <url>]
tsheet backend list [--server <url>]
tsheet backend remove <backend-id> [--server <url>]
```

During development, `npm run dev:server` runs the CLI in watch mode and serves the Vite frontend from `npm run dev:web`.

## Basic Architecture

The project is a single TypeScript codebase split by runtime boundary:

- `src/web/`: React + Vite frontend. It renders the canvas, terminal surfaces, Markdown editors, workspace state, and UI controls.
- `src/server/`: Fastify server. It owns HTTP routes, WebSocket wiring, PTY lifecycle, persistence, backend management, and attention integrations.
- `src/shared/`: Shared schemas, commands, events, and transport types used by both the browser and server.
- `src/cli/`: CLI entrypoint for serving the app, opening Markdown files, spawning sessions, managing tokens, and configuring remote backends.
- `src/dev/`: Development launch helpers.

At runtime, the browser talks to one local server. The server owns workspace persistence and PTY processes, streams terminal snapshots and events over WebSockets, and accepts user actions from the canvas. The frontend renders terminals in different modes depending on focus and zoom: a focused terminal is interactive, background terminals can remain live read-only previews, and far zoom levels can use summarized presentations.

Remote hosting is modeled as a home/remote topology. The home server remains the browser-facing workspace authority, while remote servers own PTY lifecycle on other machines and stream their runtime state back to the home server.

## Development Commands

```sh
npm run typecheck
npm run lint
npm run test
npm run test:watch
```

Tests are co-located with source files as `src/**/*.test.ts` and run with Vitest.

## Feedback Wanted

I would like feedback on the core idea: a Miro-style infinite canvas for terminals and Markdown editors, aimed at supervising multiple coding agents and keeping notes/specs beside the work.

Useful questions to react to:

- Would this fit how you actually run multiple terminal or agent sessions?
- What would make the canvas feel indispensable instead of just visually interesting?
- Which workflows should be fastest: spawning sessions, reviewing output, routing attention, comparing branches, editing notes, or something else?
- What integrations would make it more useful: Git worktrees, GitHub issues, task queues, tmux, Claude Code, Codex, SSH hosts, or local files?
- Should Markdown nodes stay simple, or should they grow into richer planning/checklist/spec objects?

The goal is not to build a generic whiteboard. The goal is a dense, practical command center for terminal-heavy development.
