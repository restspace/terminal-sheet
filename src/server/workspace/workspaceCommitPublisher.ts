import type { Workspace } from '../../shared/workspace';

export type WorkspaceCommitListener = (
  workspace: Workspace,
) => void | Promise<void>;

export class WorkspaceCommitPublisher {
  private readonly listeners = new Set<WorkspaceCommitListener>();

  subscribe(listener: WorkspaceCommitListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  async publish(workspace: Workspace): Promise<void> {
    await Promise.allSettled(
      [...this.listeners].map((listener) =>
        Promise.resolve().then(() => listener(workspace)),
      ),
    );
  }
}
