import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultWorkspace } from '../../shared/workspace';
import { WorkspaceService } from '../persistence/workspaceService';
import { WorkspaceCommitPublisher } from './workspaceCommitPublisher';
import { WorkspaceCommitService } from './workspaceCommitService';

describe('WorkspaceCommitService', () => {
  let tempDirectory: string | null = null;

  afterEach(async () => {
    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true, force: true });
      tempDirectory = null;
    }
  });

  it('persists before publishing and ignores listener failures', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-commit-'));
    const workspaceFile = join(tempDirectory, 'workspace.json');
    const workspaceService = await WorkspaceService.create(workspaceFile);
    const publisher = new WorkspaceCommitPublisher();
    const commitService = new WorkspaceCommitService(workspaceService, publisher);
    const observedWorkspaces: string[] = [];

    const unsubscribeObserved = publisher.subscribe((workspace) => {
      observedWorkspaces.push(workspace.updatedAt);
      expect(workspaceService.getWorkspace().updatedAt).toBe(workspace.updatedAt);
    });
    const unsubscribeFailing = publisher.subscribe(() => {
      throw new Error('listener failed');
    });

    const nextWorkspace = {
      ...createDefaultWorkspace(),
      layoutMode: 'focus-tiles' as const,
    };
    const savedWorkspace = await commitService.commitWorkspace(nextWorkspace);

    expect(savedWorkspace.layoutMode).toBe('focus-tiles');
    expect(workspaceService.getWorkspace()).toEqual(savedWorkspace);
    expect(observedWorkspaces).toHaveLength(1);

    unsubscribeObserved();
    unsubscribeFailing();
  });
});
