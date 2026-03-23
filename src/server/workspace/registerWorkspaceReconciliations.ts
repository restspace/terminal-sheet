import type { FastifyBaseLogger } from 'fastify';

import type { MarkdownService } from '../markdown/markdownService';
import type { WorkspaceService } from '../persistence/workspaceService';
import type { BackendRuntimeManager } from '../runtime/backendRuntimeManager';
import type { SshTunnelManager } from '../runtime/sshTunnelManager';
import { WorkspaceCommitPublisher } from './workspaceCommitPublisher';

export async function registerWorkspaceReconciliations(
  logger: FastifyBaseLogger,
  options: {
    workspaceService: WorkspaceService;
    workspaceCommitPublisher: WorkspaceCommitPublisher;
    markdownService: MarkdownService;
    runtimeManager: BackendRuntimeManager;
    tunnelManager: SshTunnelManager;
  },
): Promise<() => void> {
  const workspace = options.workspaceService.getWorkspace();

  await Promise.all([
    options.markdownService.syncWithWorkspace(workspace),
    options.tunnelManager.syncWithWorkspace(workspace),
    options.runtimeManager.syncWithWorkspace(workspace),
  ]);

  const unsubscribe = options.workspaceCommitPublisher.subscribe((nextWorkspace) => {
    void options.markdownService.syncWithWorkspace(nextWorkspace).catch((error) => {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to sync markdown documents with workspace commit',
      );
    });
    void options.tunnelManager.syncWithWorkspace(nextWorkspace).catch((error) => {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to sync SSH tunnels with workspace commit',
      );
    });
    void options.runtimeManager.syncWithWorkspace(nextWorkspace).catch((error) => {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to sync PTY sessions with workspace commit',
      );
    });
  });

  return unsubscribe;
}
