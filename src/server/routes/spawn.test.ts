import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultWorkspace, createPlaceholderTerminal } from '../../shared/workspace';
import { createServer } from '../app';

const SPAWN_TOKEN = 'spawn-test-token';

describe('spawn routes', () => {
  let tempDirectory: string | null = null;

  afterEach(async () => {
    vi.unstubAllEnvs();

    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true, force: true });
      tempDirectory = null;
    }
  });

  it('creates an unlinked terminal when the parent session header is stale', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-spawn-'));
    const workspaceFilePath = join(tempDirectory, 'workspace.json');
    vi.stubEnv('TERMINAL_CANVAS_ATTENTION_TOKEN', SPAWN_TOKEN);

    const app = await createServer({
      port: 4312,
      workspaceFilePath,
    });

    try {
      const spawnResponse = await app.inject({
        method: 'POST',
        url: '/api/spawn',
        headers: {
          'x-terminal-canvas-token': SPAWN_TOKEN,
          'x-terminal-canvas-session-id': 'terminal-does-not-exist',
        },
        payload: {
          command: 'node -e "process.exit(0)"',
          label: 'stale-parent-child',
        },
      });

      expect(spawnResponse.statusCode).toBe(200);
      const { terminalId } = spawnResponse.json() as { terminalId: string };

      const workspace = await readWorkspace(workspaceFilePath);
      const spawned = workspace.terminals.find((terminal) => terminal.id === terminalId);

      expect(spawned).toBeDefined();
      expect(spawned?.id).toBe(terminalId);
      expect(spawned).not.toHaveProperty('parentTerminalId');
      expect(spawned).not.toHaveProperty('spawnGroup');
    } finally {
      await app.close();
    }
  });

  it('inherits parent cwd when parent has no live cwd snapshot yet', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-spawn-'));
    const workspaceFilePath = join(tempDirectory, 'workspace.json');
    vi.stubEnv('TERMINAL_CANVAS_ATTENTION_TOKEN', SPAWN_TOKEN);

    const parent = {
      ...createPlaceholderTerminal(0),
      id: 'terminal-parent-for-cwd',
      cwd: 'C:/dev/terminal-sheet',
      spawnGroup: undefined,
    };
    const workspace = {
      ...createDefaultWorkspace(),
      terminals: [parent],
    };
    await writeFile(workspaceFilePath, JSON.stringify(workspace, null, 2), 'utf8');

    const app = await createServer({
      port: 4312,
      workspaceFilePath,
    });

    try {
      const spawnResponse = await app.inject({
        method: 'POST',
        url: '/api/spawn',
        headers: {
          'x-terminal-canvas-token': SPAWN_TOKEN,
          'x-terminal-canvas-session-id': parent.id,
        },
        payload: {
          command: 'node -e "process.exit(0)"',
          label: 'cwd-inheritance-child',
        },
      });

      expect(spawnResponse.statusCode).toBe(200);
      const { terminalId } = spawnResponse.json() as { terminalId: string };

      const savedWorkspace = await readWorkspace(workspaceFilePath);
      const spawned = savedWorkspace.terminals.find(
        (terminal) => terminal.id === terminalId,
      );

      expect(spawned).toBeDefined();
      expect(spawned?.id).toBe(terminalId);
      expect(normalizePathForAssertions(spawned?.cwd ?? '')).toBe(
        normalizePathForAssertions(parent.cwd),
      );
      expect(spawned?.parentTerminalId).toBe(parent.id);
      expect(spawned?.spawnGroup).toBe(parent.id);
    } finally {
      await app.close();
    }
  });

  it('returns 404 when waiting for an unknown terminal id', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-spawn-'));
    const workspaceFilePath = join(tempDirectory, 'workspace.json');
    vi.stubEnv('TERMINAL_CANVAS_ATTENTION_TOKEN', SPAWN_TOKEN);

    const app = await createServer({
      port: 4312,
      workspaceFilePath,
    });

    try {
      const waitResponse = await app.inject({
        method: 'GET',
        url: '/api/spawn/terminal-missing/wait?timeout=1',
        headers: {
          'x-terminal-canvas-token': SPAWN_TOKEN,
        },
      });

      expect(waitResponse.statusCode).toBe(404);
      expect(waitResponse.json()).toMatchObject({
        message: 'Session not found',
      });
    } finally {
      await app.close();
    }
  });

  it('does not time out when waiting on a terminal that already exited', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-spawn-'));
    const workspaceFilePath = join(tempDirectory, 'workspace.json');
    vi.stubEnv('TERMINAL_CANVAS_ATTENTION_TOKEN', SPAWN_TOKEN);

    const app = await createServer({
      port: 4312,
      workspaceFilePath,
    });

    try {
      const spawnResponse = await app.inject({
        method: 'POST',
        url: '/api/spawn',
        headers: {
          'x-terminal-canvas-token': SPAWN_TOKEN,
        },
        payload: {
          command: 'node -e "process.exit(0)"',
          label: 'already-exited',
        },
      });

      expect(spawnResponse.statusCode).toBe(200);
      const { terminalId } = spawnResponse.json() as { terminalId: string };

      await waitForTerminalExit(app, terminalId, 10_000);

      const waitResponse = await app.inject({
        method: 'GET',
        url: `/api/spawn/${encodeURIComponent(terminalId)}/wait?timeout=10`,
        headers: {
          'x-terminal-canvas-token': SPAWN_TOKEN,
        },
      });

      expect(waitResponse.statusCode).toBe(200);
      expect(waitResponse.json()).toMatchObject({
        terminalId,
        timedOut: false,
        exitCode: 0,
      });
    } finally {
      await app.close();
    }
  });
});

async function readWorkspace(path: string): Promise<{
  terminals: Array<{
    id: string;
    cwd: string;
    parentTerminalId?: string;
    spawnGroup?: string;
  }>;
}> {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as {
    terminals: Array<{
      id: string;
      cwd: string;
      parentTerminalId?: string;
      spawnGroup?: string;
    }>;
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizePathForAssertions(path: string): string {
  return path.replace(/\\/g, '/');
}

async function waitForTerminalExit(
  app: Awaited<ReturnType<typeof createServer>>,
  terminalId: string,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const readResponse = await app.inject({
      method: 'GET',
      url: `/api/spawn/${encodeURIComponent(terminalId)}/read`,
      headers: {
        'x-terminal-canvas-token': SPAWN_TOKEN,
      },
    });

    if (readResponse.statusCode === 200) {
      const payload = readResponse.json() as { exitCode: number | null };
      if (payload.exitCode !== null) {
        return;
      }
    }

    await sleep(100);
  }

  throw new Error(`Timed out waiting for terminal ${terminalId} to exit`);
}
