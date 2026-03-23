import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDefaultWorkspace,
  createMarkdownNode,
  createPlaceholderTerminal,
} from '../shared/workspace';
import { WORKSPACE_BASE_UPDATED_AT_HEADER } from '../shared/workspaceTransport';
import { createServer } from './app';

describe('createServer web entrypoint', () => {
  let tempDirectory: string | null = null;

  afterEach(async () => {
    vi.unstubAllGlobals();

    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true, force: true });
      tempDirectory = null;
    }
  });

  it('redirects to the dev frontend when it is reachable', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-app-'));
    const webRoot = await createWebRoot(tempDirectory);
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const app = await createServer({
      port: 4312,
      workspaceFilePath: join(tempDirectory, 'workspace.json'),
      devWebUrl: 'http://127.0.0.1:4313',
      webRoot,
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/',
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('http://127.0.0.1:4313');
      expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4313', {
        redirect: 'manual',
        signal: expect.any(AbortSignal),
      });
    } finally {
      await app.close();
    }
  }, 10_000);

  it('serves built assets when the dev frontend is unavailable', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-app-'));
    const webRoot = await createWebRoot(tempDirectory);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:4313');
    }));

    const app = await createServer({
      port: 4312,
      workspaceFilePath: join(tempDirectory, 'workspace.json'),
      devWebUrl: 'http://127.0.0.1:4313',
      webRoot,
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('Terminal Canvas Test');
    } finally {
      await app.close();
    }
  });

  it('returns a backend error instead of redirecting to a dead dev port', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-app-'));
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:4313');
    }));

    const app = await createServer({
      port: 4312,
      workspaceFilePath: join(tempDirectory, 'workspace.json'),
      devWebUrl: 'http://127.0.0.1:4313',
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/',
      });

      expect(response.statusCode).toBe(503);
      expect(response.body).toContain(
        'Frontend dev server unavailable at http://127.0.0.1:4313',
      );
    } finally {
      await app.close();
    }
  });

  it('opens relative markdown files from the server content root', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-app-'));
    const contentRoot = join(tempDirectory, 'project');
    const workspaceDirectory = join(tempDirectory, '.terminal-canvas');
    await mkdir(contentRoot, { recursive: true });
    await mkdir(workspaceDirectory, { recursive: true });
    await writeFile(join(contentRoot, 'DISCOVERY.md'), '# Discovery\n', 'utf8');

    const app = await createServer({
      port: 4312,
      workspaceFilePath: join(workspaceDirectory, 'workspace.json'),
      contentRoot,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/markdown/open',
        payload: {
          filePath: 'DISCOVERY.md',
          createIfMissing: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        workspace: {
          markdown: [
            expect.objectContaining({
              label: 'DISCOVERY',
              filePath: './DISCOVERY.md',
            }),
          ],
        },
        node: {
          label: 'DISCOVERY',
          filePath: './DISCOVERY.md',
        },
        document: {
          filePath: './DISCOVERY.md',
          content: '# Discovery\n',
        },
      });
    } finally {
      await app.close();
    }
  });

  it('returns legacy markdown contents for an existing workspace node', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-app-'));
    const contentRoot = join(tempDirectory, 'project');
    const workspaceDirectory = join(tempDirectory, '.terminal-canvas');
    const workspaceFilePath = join(workspaceDirectory, 'workspace.json');
    await mkdir(contentRoot, { recursive: true });
    await mkdir(workspaceDirectory, { recursive: true });
    await writeFile(join(workspaceDirectory, 'DISCOVERY.md'), 'abc\n', 'utf8');
    await writeFile(
      workspaceFilePath,
      JSON.stringify(
        {
          ...createDefaultWorkspace(),
          markdown: [
            createMarkdownNode(
              {
                label: 'Discovery',
                filePath: './DISCOVERY.md',
              },
              0,
            ),
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    const app = await createServer({
      port: 4312,
      workspaceFilePath,
      contentRoot,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/markdown/open',
        payload: {
          filePath: 'DISCOVERY.md',
          createIfMissing: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        workspace: {
          markdown: [
            expect.objectContaining({
              label: 'Discovery',
              filePath: './DISCOVERY.md',
            }),
          ],
        },
        node: {
          label: 'Discovery',
          filePath: './DISCOVERY.md',
        },
        document: {
          filePath: './DISCOVERY.md',
          content: 'abc\n',
        },
      });
      await expect(access(join(contentRoot, 'DISCOVERY.md'))).rejects.toBeDefined();
    } finally {
      await app.close();
    }
  });

  it('opens a legacy markdown file without creating a new empty content-root file', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-app-'));
    const contentRoot = join(tempDirectory, 'project');
    const workspaceDirectory = join(tempDirectory, '.terminal-canvas');
    const workspaceFilePath = join(workspaceDirectory, 'workspace.json');
    await mkdir(contentRoot, { recursive: true });
    await mkdir(workspaceDirectory, { recursive: true });
    await writeFile(join(workspaceDirectory, 'DISCOVERY.md'), 'abc\n', 'utf8');

    const app = await createServer({
      port: 4312,
      workspaceFilePath,
      contentRoot,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/markdown/open',
        payload: {
          filePath: 'DISCOVERY.md',
          createIfMissing: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        workspace: {
          markdown: [
            expect.objectContaining({
              filePath: './DISCOVERY.md',
            }),
          ],
        },
        node: {
          filePath: './DISCOVERY.md',
        },
        document: {
          filePath: './DISCOVERY.md',
          content: 'abc\n',
        },
      });
    } finally {
      await app.close();
    }
  });

  it('lists directories and filtered files from the filesystem API', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-app-'));
    const contentRoot = join(tempDirectory, 'project');
    const workspaceDirectory = join(tempDirectory, '.terminal-canvas');
    await mkdir(contentRoot, { recursive: true });
    await mkdir(workspaceDirectory, { recursive: true });
    await mkdir(join(contentRoot, 'docs'), { recursive: true });
    await writeFile(join(contentRoot, 'README.md'), '# Readme\n', 'utf8');
    await writeFile(join(contentRoot, 'Guide.MARKDOWN'), '# Guide\n', 'utf8');
    await writeFile(join(contentRoot, 'notes.txt'), 'notes\n', 'utf8');

    const app = await createServer({
      port: 4312,
      workspaceFilePath: join(workspaceDirectory, 'workspace.json'),
      contentRoot,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/filesystem/list',
        payload: {
          server: 'local',
          directoryPath: '.',
          includeFiles: true,
          extensions: ['.md', '.markdown'],
        },
      });

      expect(response.statusCode).toBe(200);

      const payload = response.json() as {
        directoryPath: string;
        parentDirectoryPath: string | null;
        entries: Array<{
          name: string;
          path: string;
          kind: 'directory' | 'file';
        }>;
      };

      expect(payload.directoryPath).toBe(contentRoot);
      expect(payload.parentDirectoryPath).toBe(tempDirectory);
      expect(payload.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'docs',
            kind: 'directory',
          }),
          expect.objectContaining({
            name: 'README.md',
            kind: 'file',
          }),
          expect.objectContaining({
            name: 'Guide.MARKDOWN',
            kind: 'file',
          }),
        ]),
      );
      expect(payload.entries).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'notes.txt',
          }),
        ]),
      );
    } finally {
      await app.close();
    }
  });

  it('returns directories only when includeFiles is false', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-app-'));
    const contentRoot = join(tempDirectory, 'project');
    const workspaceDirectory = join(tempDirectory, '.terminal-canvas');
    await mkdir(contentRoot, { recursive: true });
    await mkdir(workspaceDirectory, { recursive: true });
    await mkdir(join(contentRoot, 'src'), { recursive: true });
    await writeFile(join(contentRoot, 'README.md'), '# Readme\n', 'utf8');

    const app = await createServer({
      port: 4312,
      workspaceFilePath: join(workspaceDirectory, 'workspace.json'),
      contentRoot,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/filesystem/list',
        payload: {
          server: 'local',
          directoryPath: '.',
          includeFiles: false,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(
        response
          .json()
          .entries.every((entry: { kind: string }) => entry.kind === 'directory'),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('rejects unsupported filesystem servers', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-app-'));
    const app = await createServer({
      port: 4312,
      workspaceFilePath: join(tempDirectory, 'workspace.json'),
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/filesystem/list',
        payload: {
          server: 'remote-server-1',
        },
      });

      expect(response.statusCode).toBe(501);
      expect(response.json()).toMatchObject({
        message:
          "Filesystem server 'remote-server-1' is not supported yet.",
      });
    } finally {
      await app.close();
    }
  });

  it('rejects stale workspace saves with a conflict response', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-app-'));
    const app = await createServer({
      port: 4312,
      workspaceFilePath: join(tempDirectory, 'workspace.json'),
    });

    try {
      const initialWorkspaceResponse = await app.inject({
        method: 'GET',
        url: '/api/workspace',
      });
      const initialWorkspace = initialWorkspaceResponse.json();
      const firstUpdate = {
        ...initialWorkspace,
        currentViewport: {
          x: 120,
          y: 24,
          zoom: 0.9,
        },
      };

      const firstSaveResponse = await app.inject({
        method: 'PUT',
        url: '/api/workspace',
        headers: {
          [WORKSPACE_BASE_UPDATED_AT_HEADER]: initialWorkspace.updatedAt,
        },
        payload: firstUpdate,
      });

      expect(firstSaveResponse.statusCode).toBe(200);
      const savedWorkspace = firstSaveResponse.json();

      const staleSaveResponse = await app.inject({
        method: 'PUT',
        url: '/api/workspace',
        headers: {
          [WORKSPACE_BASE_UPDATED_AT_HEADER]: initialWorkspace.updatedAt,
        },
        payload: {
          ...initialWorkspace,
          currentViewport: {
            x: -500,
            y: 0,
            zoom: 0.72,
          },
        },
      });

      expect(staleSaveResponse.statusCode).toBe(409);
      expect(staleSaveResponse.json()).toMatchObject({
        message: 'Workspace state is out of date.',
        workspace: savedWorkspace,
      });
    } finally {
      await app.close();
    }
  });

  it('creates markdown nodes and returns the updated workspace out of band', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-app-'));
    const contentRoot = join(tempDirectory, 'project');
    const workspaceDirectory = join(tempDirectory, '.terminal-canvas');
    await mkdir(contentRoot, { recursive: true });
    await mkdir(workspaceDirectory, { recursive: true });

    const app = await createServer({
      port: 4312,
      workspaceFilePath: join(workspaceDirectory, 'workspace.json'),
      contentRoot,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/markdown/create',
        payload: {
          label: 'Discovery',
          filePath: 'DISCOVERY.md',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        workspace: {
          markdown: [
            expect.objectContaining({
              label: 'Discovery',
              filePath: 'DISCOVERY.md',
            }),
          ],
        },
        node: expect.objectContaining({
          label: 'Discovery',
          filePath: 'DISCOVERY.md',
        }),
        document: expect.objectContaining({
          filePath: 'DISCOVERY.md',
        }),
      });
    } finally {
      await app.close();
    }
  });

  it('registers and removes backends through the workspace and runtime-visible backend list', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-app-'));
    const workspaceDirectory = join(tempDirectory, '.terminal-canvas');
    await mkdir(workspaceDirectory, { recursive: true });

    vi.stubGlobal('fetch', createRemoteBackendFetchMock());
    vi.stubGlobal('WebSocket', FakeWebSocket as never);

    const app = await createServer({
      port: 4312,
      role: 'home',
      workspaceFilePath: join(workspaceDirectory, 'workspace.json'),
    });

    try {
      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/backends',
        payload: {
          label: 'Remote backend',
          baseUrl: 'http://remote-backend.example',
          token: 'token-123',
        },
      });

      expect(createResponse.statusCode).toBe(200);

      const created = createResponse.json() as {
        backend: { id: string; label: string };
        importedTerminalCount: number;
        workspace: { backends: Array<{ id: string; label: string }> };
      };

      expect(created.importedTerminalCount).toBe(0);
      expect(created.workspace.backends).toHaveLength(1);
      expect(created.workspace.backends[0]?.label).toBe('Remote backend');

      await tick();

      const backendsResponse = await app.inject({
        method: 'GET',
        url: '/api/backends',
      });

      expect(backendsResponse.statusCode).toBe(200);
      expect(backendsResponse.json()).toMatchObject({
        backends: [
          expect.objectContaining({
            id: created.backend.id,
            label: 'Remote backend',
            status: expect.objectContaining({
              state: 'connected',
            }),
          }),
        ],
      });

      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: `/api/backends/${created.backend.id}`,
      });

      expect(deleteResponse.statusCode).toBe(200);
      expect(deleteResponse.json()).toMatchObject({
        backendId: created.backend.id,
        workspace: {
          backends: [],
          terminals: [],
        },
      });

      const afterDeleteResponse = await app.inject({
        method: 'GET',
        url: '/api/backends',
      });

      expect(afterDeleteResponse.statusCode).toBe(200);
      expect(afterDeleteResponse.json()).toMatchObject({
        backends: [],
      });
    } finally {
      await app.close();
    }
  });

  it('applies explicit workspace mutations and persists the updated workspace', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-app-'));
    const workspaceDirectory = join(tempDirectory, '.terminal-canvas');
    await mkdir(workspaceDirectory, { recursive: true });

    const workspace = createDefaultWorkspace();
    const terminal = createPlaceholderTerminal(0);
    const markdown = createMarkdownNode(
      {
        label: 'Discovery',
        filePath: './DISCOVERY.md',
      },
      0,
    );
    const workspaceFilePath = join(workspaceDirectory, 'workspace.json');
    await writeFile(
      workspaceFilePath,
      JSON.stringify(
        {
          ...workspace,
          terminals: [terminal],
          markdown: [markdown],
          filters: {
            attentionOnly: false,
            activeMarkdownId: markdown.id,
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(join(workspaceDirectory, 'DISCOVERY.md'), 'abc\n', 'utf8');

    const app = await createServer({
      port: 4312,
      workspaceFilePath,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/workspace/mutations',
        headers: {
          [WORKSPACE_BASE_UPDATED_AT_HEADER]: workspace.updatedAt,
        },
        payload: {
          commands: [
            {
              type: 'update-terminal',
              terminalId: terminal.id,
              patch: {
                label: 'Build worker',
                cwd: 'C:/dev/terminal-sheet',
              },
            },
            {
              type: 'set-node-bounds',
              nodeId: terminal.id,
              bounds: {
                x: 240,
                y: 180,
                width: 420,
                height: 300,
              },
            },
            {
              type: 'remove-node',
              nodeId: markdown.id,
            },
            {
              type: 'set-viewport',
              viewport: {
                x: 140,
                y: -60,
                zoom: 1.05,
              },
            },
            {
              type: 'save-viewport-to-preset',
              presetId: 'writing-surface',
            },
            {
              type: 'set-layout-mode',
              layoutMode: 'focus-tiles',
            },
            {
              type: 'add-terminal',
              input: {
                label: 'Review worker',
                shell: 'powershell.exe',
                cwd: 'C:/dev/terminal-sheet',
                agentType: 'codex',
              },
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        workspace: {
          layoutMode: 'focus-tiles',
          currentViewport: {
            x: 140,
            y: -60,
            zoom: 1.05,
          },
          terminals: [
            expect.objectContaining({
              id: terminal.id,
              label: 'Build worker',
              cwd: 'C:/dev/terminal-sheet',
              bounds: {
                x: 240,
                y: 180,
                width: 420,
                height: 300,
              },
            }),
            expect.objectContaining({
              label: 'Review worker',
              shell: 'powershell.exe',
              cwd: 'C:/dev/terminal-sheet',
              agentType: 'codex',
            }),
          ],
          markdown: [],
          filters: {
            attentionOnly: false,
            activeMarkdownId: null,
          },
          cameraPresets: expect.arrayContaining([
            expect.objectContaining({
              id: 'writing-surface',
              viewport: {
                x: 140,
                y: -60,
                zoom: 1.05,
              },
            }),
          ]),
        },
      });
    } finally {
      await app.close();
    }
  });

  it('rejects workspace mutations without a base revision', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-app-'));
    const workspaceFilePath = join(tempDirectory, 'workspace.json');
    const workspace = createDefaultWorkspace();
    await writeFile(workspaceFilePath, JSON.stringify(workspace, null, 2), 'utf8');

    const app = await createServer({
      port: 4312,
      workspaceFilePath,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/workspace/mutations',
        payload: {
          commands: [
            {
              type: 'set-layout-mode',
              layoutMode: 'focus-tiles',
            },
          ],
        },
      });

      expect(response.statusCode).toBe(428);
      expect(response.json()).toMatchObject({
        message: 'Workspace save requires a base revision.',
        workspace,
      });
    } finally {
      await app.close();
    }
  });

  it('rejects stale workspace mutations with a conflict response', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-app-'));
    const workspaceFilePath = join(tempDirectory, 'workspace.json');
    const workspace = createDefaultWorkspace();
    await writeFile(workspaceFilePath, JSON.stringify(workspace, null, 2), 'utf8');

    const app = await createServer({
      port: 4312,
      workspaceFilePath,
    });

    try {
      const initialMutation = await app.inject({
        method: 'POST',
        url: '/api/workspace/mutations',
        headers: {
          [WORKSPACE_BASE_UPDATED_AT_HEADER]: workspace.updatedAt,
        },
        payload: {
          commands: [
            {
              type: 'set-layout-mode',
              layoutMode: 'focus-tiles',
            },
          ],
        },
      });

      expect(initialMutation.statusCode).toBe(200);
      const savedWorkspace = initialMutation.json() as {
        workspace: ReturnType<typeof createDefaultWorkspace>;
      };

      const staleMutation = await app.inject({
        method: 'POST',
        url: '/api/workspace/mutations',
        headers: {
          [WORKSPACE_BASE_UPDATED_AT_HEADER]: workspace.updatedAt,
        },
        payload: {
          commands: [
            {
              type: 'set-viewport',
              viewport: {
                x: -500,
                y: 0,
                zoom: 0.72,
              },
            },
          ],
        },
      });

      expect(staleMutation.statusCode).toBe(409);
      expect(staleMutation.json()).toMatchObject({
        message: 'Workspace state is out of date.',
        workspace: savedWorkspace.workspace,
      });
    } finally {
      await app.close();
    }
  });
});

async function createWebRoot(tempDirectory: string): Promise<string> {
  const webRoot = join(tempDirectory, 'web');
  await mkdir(webRoot, { recursive: true });
  await writeFile(
    join(webRoot, 'index.html'),
    '<!doctype html><html><body>Terminal Canvas Test</body></html>',
    'utf8',
  );

  return webRoot;
}

function createRemoteBackendFetchMock(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));

    if (url.pathname === '/api/backend/health') {
      return jsonResponse({
        status: 'ok',
      });
    }

    if (url.pathname === '/api/backend/workspace') {
      return jsonResponse({
        terminals: [],
      });
    }

    throw new Error(`Unexpected remote fetch request: ${url.toString()}`);
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;

  constructor(readonly url: string) {
    super();

    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) {
        return;
      }

      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event('open'));
    });
  }

  send(): void {}

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}
