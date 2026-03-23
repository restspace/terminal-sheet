/** @vitest-environment jsdom */

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultWorkspace, type Workspace } from '../../shared/workspace';
import { useWorkspaceRealtime } from './useWorkspaceRealtime';

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let latestState: ReturnType<typeof useWorkspaceRealtime> | null = null;

describe('useWorkspaceRealtime', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    latestState = null;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    latestState = null;
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    document.body.innerHTML = '';
  });

  it('refreshes workspace state when a newer realtime snapshot arrives', async () => {
    const workspace = createDefaultWorkspace();
    const newerUpdatedAt = new Date(
      new Date(workspace.updatedAt).getTime() + 60_000,
    ).toISOString();
    const refreshWorkspaceFromServer = vi.fn(async () => true);

    act(() => {
      root.render(
        createElement(Harness, {
          workspace,
          refreshWorkspaceFromServer,
        }),
      );
    });

    act(() => {
      latestState?.handleWorkspaceMessage({
        type: 'workspace.updated',
        workspace: {
          ...workspace,
          updatedAt: newerUpdatedAt,
        },
      });
    });

    await vi.waitFor(() => {
      expect(refreshWorkspaceFromServer).toHaveBeenCalledWith(
        expect.objectContaining({
          updatedAt: newerUpdatedAt,
        }),
      );
    });
  });

  it('ignores older or equal realtime snapshots', async () => {
    const workspace = {
      ...createDefaultWorkspace(),
      updatedAt: '2026-03-23T10:15:00.000Z',
    };
    const refreshWorkspaceFromServer = vi.fn(async () => true);

    act(() => {
      root.render(
        createElement(Harness, {
          workspace,
          refreshWorkspaceFromServer,
        }),
      );
    });

    act(() => {
      latestState?.handleWorkspaceMessage({
        type: 'workspace.updated',
        workspace: {
          ...workspace,
        },
      });
    });

    act(() => {
      latestState?.handleWorkspaceMessage({
        type: 'workspace.updated',
        workspace: {
          ...workspace,
          updatedAt: '2026-03-23T10:14:59.000Z',
        },
      });
    });

    await vi.waitFor(() => {
      expect(refreshWorkspaceFromServer).not.toHaveBeenCalled();
    });
  });
});

function Harness({
  workspace,
  refreshWorkspaceFromServer,
}: {
  workspace: Workspace | null;
  refreshWorkspaceFromServer: (nextWorkspace?: Workspace | null) => Promise<boolean>;
}) {
  latestState = useWorkspaceRealtime({
    workspace,
    refreshWorkspaceFromServer,
  });
  return createElement('div');
}
