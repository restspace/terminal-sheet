import { describe, expect, it } from 'vitest';

import { createDefaultWorkspace } from '../../shared/workspace';
import {
  compareWorkspaceUpdatedAt,
  isNewerWorkspaceSnapshot,
  isStaleWorkspaceSnapshot,
} from './workspaceFreshness';

describe('workspace freshness', () => {
  it('treats older snapshots as stale and newer snapshots as fresh', () => {
    const currentWorkspace = {
      ...createDefaultWorkspace(),
      updatedAt: '2026-03-22T14:10:00.000Z',
    };
    const staleWorkspace = {
      ...currentWorkspace,
      updatedAt: '2026-03-22T14:09:59.000Z',
    };
    const freshWorkspace = {
      ...currentWorkspace,
      updatedAt: '2026-03-22T14:10:01.000Z',
    };

    expect(compareWorkspaceUpdatedAt(staleWorkspace, currentWorkspace)).toBe(-1);
    expect(compareWorkspaceUpdatedAt(freshWorkspace, currentWorkspace)).toBe(1);
    expect(isStaleWorkspaceSnapshot(staleWorkspace, currentWorkspace)).toBe(true);
    expect(isNewerWorkspaceSnapshot(staleWorkspace, currentWorkspace)).toBe(false);
    expect(isNewerWorkspaceSnapshot(freshWorkspace, currentWorkspace)).toBe(true);
  });

  it('treats matching timestamps as neither newer nor stale', () => {
    const workspace = {
      ...createDefaultWorkspace(),
      updatedAt: '2026-03-22T14:10:00.000Z',
    };

    expect(compareWorkspaceUpdatedAt(workspace, workspace)).toBe(0);
    expect(isStaleWorkspaceSnapshot(workspace, workspace)).toBe(false);
    expect(isNewerWorkspaceSnapshot(workspace, workspace)).toBe(false);
  });
});
