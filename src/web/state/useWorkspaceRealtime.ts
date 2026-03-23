import { useCallback, useEffect, useState } from 'react';

import type { TerminalServerSocketMessage } from '../../shared/terminalSessions';
import type { Workspace } from '../../shared/workspace';
import {
  logStateDebug,
  summarizeWorkspaceDiffForDebug,
  summarizeWorkspaceForDebug,
} from '../debug/stateDebug';
import { isNewerWorkspaceSnapshot } from './workspaceFreshness';

interface UseWorkspaceRealtimeOptions {
  workspace: Workspace | null;
  refreshWorkspaceFromServer: (nextWorkspace?: Workspace | null) => Promise<boolean>;
}

interface WorkspaceRealtimeStore {
  handleWorkspaceMessage: (message: TerminalServerSocketMessage) => void;
}

export function useWorkspaceRealtime({
  workspace,
  refreshWorkspaceFromServer,
}: UseWorkspaceRealtimeOptions): WorkspaceRealtimeStore {
  const [workspaceSnapshot, setWorkspaceSnapshot] = useState<Workspace | null>(
    null,
  );

  const handleWorkspaceMessage = useCallback(
    (message: TerminalServerSocketMessage) => {
      setWorkspaceSnapshot((current) => {
        const nextWorkspace = applyWorkspaceMessage(current, message);

        if (message.type === 'workspace.updated') {
          logStateDebug('socket', 'workspace.updated', {
            workspace: summarizeWorkspaceForDebug(nextWorkspace),
            diff: summarizeWorkspaceDiffForDebug(current, nextWorkspace),
          });
        }

        return nextWorkspace;
      });
    },
    [],
  );

  useEffect(() => {
    if (!workspaceSnapshot || !workspace) {
      return;
    }

    const shouldRefreshWorkspace = isNewerWorkspaceSnapshot(
      workspaceSnapshot,
      workspace,
    );
    logStateDebug('workspaceRealtime', 'workspaceSnapshotObserved', {
      localWorkspace: summarizeWorkspaceForDebug(workspace),
      snapshotWorkspace: summarizeWorkspaceForDebug(workspaceSnapshot),
      shouldRefreshWorkspace,
    });

    if (!shouldRefreshWorkspace) {
      return;
    }

    void refreshWorkspaceFromServer(workspaceSnapshot);
  }, [refreshWorkspaceFromServer, workspace, workspaceSnapshot]);

  return {
    handleWorkspaceMessage,
  };
}

export function applyWorkspaceMessage(
  current: Workspace | null,
  message: TerminalServerSocketMessage,
): Workspace | null {
  switch (message.type) {
    case 'workspace.updated':
      return message.workspace;
    default:
      return current;
  }
}
