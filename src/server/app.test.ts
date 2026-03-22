import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultWorkspace, createMarkdownNode } from '../shared/workspace';
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
  });

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
