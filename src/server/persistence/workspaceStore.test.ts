import { mkdtemp, rm } from 'node:fs/promises';
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
    expect(workspace.cameraPresets).toHaveLength(4);
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
  });
});
