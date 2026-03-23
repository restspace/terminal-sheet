import type { Workspace } from '../../shared/workspace';
import {
  applyWorkspaceCommands,
  type WorkspaceMutationCommand,
} from '../../shared/workspaceCommands';
import { WorkspaceCommitService } from './workspaceCommitService';

export class WorkspaceMutationError extends Error {
  constructor(
    readonly statusCode: 409 | 428,
    message: string,
    readonly workspace: Workspace,
  ) {
    super(message);
    this.name = 'WorkspaceMutationError';
  }
}

export class WorkspaceCommandService {
  private commandQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly workspaceCommitService: WorkspaceCommitService) {}

  async applyCommands(input: {
    baseUpdatedAt: string | null;
    commands: readonly WorkspaceMutationCommand[];
  }): Promise<Workspace> {
    const execution = this.commandQueue.then(() => this.doApplyCommands(input));
    this.commandQueue = execution.catch(() => {});
    return execution;
  }

  private async doApplyCommands(input: {
    baseUpdatedAt: string | null;
    commands: readonly WorkspaceMutationCommand[];
  }): Promise<Workspace> {
    const currentWorkspace = this.workspaceCommitService.getWorkspace();

    if (!input.baseUpdatedAt) {
      throw new WorkspaceMutationError(
        428,
        'Workspace save requires a base revision.',
        currentWorkspace,
      );
    }

    if (currentWorkspace.updatedAt !== input.baseUpdatedAt) {
      throw new WorkspaceMutationError(
        409,
        'Workspace state is out of date.',
        currentWorkspace,
      );
    }

    const nextWorkspace = applyWorkspaceCommands(
      currentWorkspace,
      input.commands,
    );
    return this.workspaceCommitService.commitWorkspace(nextWorkspace);
  }
}
