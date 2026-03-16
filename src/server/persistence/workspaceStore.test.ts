import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { createPlaceholderMarkdown, createPlaceholderTerminal } from '../../shared/workspace';
import { loadOrCreateWorkspace, saveWorkspace } from './workspaceStore';

describe('workspace store', () => {
  let tempDirectory: string | null = null;

  afterEach(async () => {
    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true, force: true });
      tempDirectory = null;
    }
  });

  it('creates a default workspace when no file exists', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-'));
    const workspaceFile = join(tempDirectory, 'workspace.json');

    const workspace = await loadOrCreateWorkspace(workspaceFile);

    expect(workspace.name).toBe('Terminal Canvas');
    expect(workspace.version).toBe(2);
    expect(workspace.layoutMode).toBe('free');
    expect(workspace.cameraPresets).toHaveLength(3);
    expect(workspace.currentViewport.zoom).toBeGreaterThan(0);
  });

  it('persists and reloads workspace changes', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-'));
    const workspaceFile = join(tempDirectory, 'workspace.json');
    const workspace = await loadOrCreateWorkspace(workspaceFile);

    const changed = {
      ...workspace,
      terminals: [createPlaceholderTerminal(0)],
      markdown: [createPlaceholderMarkdown(0)],
    };

    await saveWorkspace(workspaceFile, changed);
    const reloaded = await loadOrCreateWorkspace(workspaceFile);

    expect(reloaded.terminals).toHaveLength(1);
    expect(reloaded.markdown).toHaveLength(1);
    expect(reloaded.terminals[0]?.label).toBe('Shell 1');
    expect(Date.parse(reloaded.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(workspace.updatedAt),
    );
  });

  it('replaces older workspace versions with a fresh default workspace', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-'));
    const workspaceFile = join(tempDirectory, 'workspace.json');

    await writeFile(
      workspaceFile,
      JSON.stringify({
        version: 1,
        id: 'workspace-default',
        name: 'Old Workspace',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        currentViewport: { x: 0, y: 0, zoom: 1 },
        terminals: [],
        markdown: [],
        cameraPresets: [],
        filters: {
          attentionOnly: false,
          activeMarkdownId: null,
        },
      }),
      'utf8',
    );

    const workspace = await loadOrCreateWorkspace(workspaceFile);

    expect(workspace.version).toBe(2);
    expect(workspace.name).toBe('Terminal Canvas');
  });
});
