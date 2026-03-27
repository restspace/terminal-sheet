# Sub-Agent Spawning via the tsheet API

This document explains how to integrate sub-agent spawning into a custom agent harness so that child agents run as visible terminal windows on the Terminal Canvas workspace.

## Overview

When a process runs inside a tsheet terminal, it has access to environment variables and HTTP endpoints that let it create new sibling terminals on the canvas. Each spawned terminal gets its own PTY, appears visually next to its parent, and can report structured results back.

The intended use is building an **orchestrator agent** -- a custom agent loop where the only way to parallelise work is to spawn visible child terminals. Unlike context-based instructions (CLAUDE.md, skills), this approach guarantees visibility because the tool set is defined by the harness, not by the model.

## Environment Variables

Every process running inside a tsheet PTY has these variables available:

| Variable | Description |
|----------|-------------|
| `TERMINAL_CANVAS_SESSION_ID` | This terminal's unique ID |
| `TERMINAL_CANVAS_SPAWN_URL` | Base URL for the spawn API (e.g. `http://127.0.0.1:4312/api/spawn`) |
| `TERMINAL_CANVAS_ATTENTION_TOKEN` | Auth token for all spawn API calls |
| `TERMINAL_CANVAS_ATTENTION_URL` | Attention webhook URL (for notification hooks) |
| `TERMINAL_CANVAS_AGENT_TYPE` | This terminal's agent type (`shell`, `claude`, `codex`) |

Spawned child terminals additionally receive:

| Variable | Description |
|----------|-------------|
| `TERMINAL_CANVAS_PARENT_ID` | The parent terminal's ID |
| `TERMINAL_CANVAS_RESULT_URL` | Pre-built URL to POST structured results to (e.g. `http://127.0.0.1:4312/api/spawn/{id}/result`) |

## Authentication

All API calls require the `x-terminal-canvas-token` header set to the value of `TERMINAL_CANVAS_ATTENTION_TOKEN`.

To identify which terminal is making the call, include `x-terminal-canvas-session-id` set to `TERMINAL_CANVAS_SESSION_ID`. This establishes the parent-child relationship.

## API Reference

### POST /api/spawn

Create a new terminal on the canvas. The new terminal spawns a PTY running the given command and is positioned adjacent to the calling terminal.

**Request:**

```json
{
  "command": "python solve.py --input data.json",
  "label": "Solver agent",
  "cwd": "/home/user/project",
  "agentType": "shell",
  "tags": ["batch-1"]
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `command` | Yes | -- | Shell command to run in the new terminal |
| `label` | No | Truncated command | Display name on the canvas |
| `cwd` | No | Parent's live working directory | Working directory for the child |
| `agentType` | No | `shell` | One of `shell`, `claude`, `codex` |
| `tags` | No | `[]` | Arbitrary tags for grouping |

**Response (200):**

```json
{
  "ok": true,
  "terminalId": "terminal-abc123",
  "sessionId": "terminal-abc123"
}
```

The `terminalId` is used in all subsequent calls to wait, read, or get results.

### GET /api/spawn/:terminalId/wait

Long-poll until the terminal's process exits. The connection stays open until the child exits or the timeout is reached.

**Query parameters:**

| Param | Default | Max | Description |
|-------|---------|-----|-------------|
| `timeout` | 300 | 600 | Seconds to wait before timing out |

**Response (200):**

```json
{
  "terminalId": "terminal-abc123",
  "exitCode": 0,
  "timedOut": false
}
```

If the timeout is reached, `exitCode` is `null` and `timedOut` is `true`.

### GET /api/spawn/:terminalId/read

Read the terminal's raw output. Useful for inspecting what the child printed.

**Response (200):**

```json
{
  "terminalId": "terminal-abc123",
  "scrollback": "...",
  "lastOutputLine": "Done: 42 files processed",
  "exitCode": 0
}
```

Note: `scrollback` contains raw terminal output including ANSI escape codes. For structured data exchange, use the result endpoint instead.

### POST /api/spawn/:terminalId/result

Post a structured result from inside a child terminal. The child calls this before exiting so the parent can read the result.

**Request:**

```json
{
  "data": {
    "files_changed": ["src/app.ts", "src/utils.ts"],
    "summary": "Fixed 3 type errors"
  }
}
```

The `data` field accepts any valid JSON value.

**Response (200):**

```json
{
  "ok": true,
  "terminalId": "terminal-abc123"
}
```

### GET /api/spawn/:terminalId/result

Read the structured result posted by a child terminal.

**Response (200):**

```json
{
  "terminalId": "terminal-abc123",
  "hasResult": true,
  "data": {
    "files_changed": ["src/app.ts", "src/utils.ts"],
    "summary": "Fixed 3 type errors"
  }
}
```

If the child hasn't posted a result yet, `hasResult` is `false` and `data` is absent.

## CLI Shortcut

The `tsheet spawn` command wraps the HTTP API for use from shell scripts and simple integrations:

```bash
# Spawn and forget (prints terminal ID to stdout)
tsheet spawn --command "npm test" --label "Tests"

# Spawn and wait for completion (exits with child's exit code)
tsheet spawn --command "npm test" --label "Tests" --wait

# With options
tsheet spawn \
  --command "claude --task 'fix the auth bug'" \
  --label "Auth fix" \
  --cwd /home/user/project \
  --agent-type claude \
  --wait \
  --timeout 120
```

The CLI reads environment variables automatically, so it only works from inside a tsheet terminal.

## Writing an Orchestrator Agent

An orchestrator is a custom agent loop that uses `spawn` as its mechanism for parallel work. Here's the pattern:

### Tool Definitions

Define these tools for your agent's tool set:

| Tool | Maps to | Description |
|------|---------|-------------|
| `spawn_agent` | `POST /api/spawn` | Create a visible child terminal |
| `wait_agent` | `GET /api/spawn/:id/wait` | Block until child exits |
| `read_agent_output` | `GET /api/spawn/:id/read` | Read child's raw terminal output |
| `get_agent_result` | `GET /api/spawn/:id/result` | Read child's structured result |

Do **not** include a tool that spawns invisible subprocesses. The point is that `spawn_agent` is the only way to parallelise, guaranteeing all work is visible on the canvas.

### Example: TypeScript Agent Loop

```typescript
import Anthropic from "@anthropic-ai/sdk";

const SPAWN_URL = process.env.TERMINAL_CANVAS_SPAWN_URL;
const TOKEN = process.env.TERMINAL_CANVAS_ATTENTION_TOKEN;
const SESSION_ID = process.env.TERMINAL_CANVAS_SESSION_ID;

const headers = {
  "Content-Type": "application/json",
  "x-terminal-canvas-token": TOKEN,
  "x-terminal-canvas-session-id": SESSION_ID,
};

// Tool implementations
async function spawnAgent(command: string, label: string) {
  const res = await fetch(SPAWN_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ command, label }),
  });
  return res.json(); // { ok, terminalId, sessionId }
}

async function waitAgent(terminalId: string, timeout = 300) {
  const res = await fetch(
    `${SPAWN_URL}/${terminalId}/wait?timeout=${timeout}`,
    { headers }
  );
  return res.json(); // { terminalId, exitCode, timedOut }
}

async function getAgentResult(terminalId: string) {
  const res = await fetch(
    `${SPAWN_URL}/${terminalId}/result`,
    { headers }
  );
  return res.json(); // { terminalId, hasResult, data? }
}
```

### Example: Child Script That Posts a Result

The child process uses `TERMINAL_CANVAS_RESULT_URL` to send structured data back:

```bash
#!/bin/bash
# Do the work
output=$(grep -r "TODO" src/ --count)

# Post result back to parent
curl -s -X POST "$TERMINAL_CANVAS_RESULT_URL" \
  -H "Content-Type: application/json" \
  -H "x-terminal-canvas-token: $TERMINAL_CANVAS_ATTENTION_TOKEN" \
  -d "{\"data\": {\"todo_count\": \"$output\"}}"
```

Or in Python:

```python
import os, json, urllib.request

result_url = os.environ["TERMINAL_CANVAS_RESULT_URL"]
token = os.environ["TERMINAL_CANVAS_ATTENTION_TOKEN"]

# Do work...
findings = {"files": ["a.py", "b.py"], "issues": 3}

# Post result
req = urllib.request.Request(
    result_url,
    data=json.dumps({"data": findings}).encode(),
    headers={
        "Content-Type": "application/json",
        "x-terminal-canvas-token": token,
    },
    method="POST",
)
urllib.request.urlopen(req)
```

### Typical Orchestrator Flow

```
1. Orchestrator agent receives task from user
2. Agent decides to parallelise: calls spawn_agent 3 times
   -> 3 new terminals appear on canvas, user watches all of them
3. Agent calls wait_agent for each child
   -> blocks until each finishes
4. Agent calls get_agent_result for each child
   -> reads structured JSON results
5. Agent synthesises results and responds to user
```

## Canvas Behaviour

- Spawned terminals are positioned adjacent to their parent (right, below, left, above -- first non-overlapping position wins)
- Each spawned terminal has `parentTerminalId` and `spawnGroup` fields linking it to its parent
- When a child exits, the parent receives an **attention event** (visible as a notification badge on the canvas)
- Child terminals persist after exit so the user can inspect their output
- Nested spawning works: a child can spawn its own children, forming a tree of visible terminals

## Shared Types

TypeScript types for all request/response schemas are exported from `src/shared/spawnProtocol.ts`:

```typescript
import type {
  SpawnRequest,
  SpawnResponse,
  SpawnWaitResponse,
  SpawnReadResponse,
  SpawnResultPayload,
  SpawnResultResponse,
} from "./shared/spawnProtocol";
```
