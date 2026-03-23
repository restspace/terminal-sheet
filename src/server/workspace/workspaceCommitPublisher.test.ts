import { describe, expect, it, vi } from 'vitest';

import { createDefaultWorkspace } from '../../shared/workspace';
import { WorkspaceCommitPublisher } from './workspaceCommitPublisher';

describe('WorkspaceCommitPublisher', () => {
  it('publishes to active subscribers and ignores listener failures', async () => {
    const publisher = new WorkspaceCommitPublisher();
    const workspace = createDefaultWorkspace();
    const observedWorkspaces: string[] = [];
    const listener = vi.fn((nextWorkspace) => {
      observedWorkspaces.push(nextWorkspace.updatedAt);
    });

    const unsubscribeListener = publisher.subscribe(listener);
    const unsubscribeThrowing = publisher.subscribe(() => {
      throw new Error('listener failed');
    });

    await expect(publisher.publish(workspace)).resolves.toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(observedWorkspaces).toEqual([workspace.updatedAt]);

    unsubscribeListener();
    unsubscribeThrowing();

    await expect(publisher.publish({
      ...workspace,
      updatedAt: '2026-03-23T12:34:56.000Z',
    })).resolves.toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
