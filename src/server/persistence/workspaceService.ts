import type { Workspace } from '../../shared/workspace';
import { loadOrCreateWorkspace, saveWorkspace } from './workspaceStore';

type WorkspaceListener = (workspace: Workspace) => void | Promise<void>;

export class WorkspaceService {
  private readonly listeners = new Set<WorkspaceListener>();

  private constructor(
    private readonly workspaceFilePath: string,
    private workspace: Workspace,
  ) {}

  static async create(workspaceFilePath: string): Promise<WorkspaceService> {
    const workspace = await loadOrCreateWorkspace(workspaceFilePath);
    return new WorkspaceService(workspaceFilePath, workspace);
  }

  getWorkspace(): Workspace {
    return this.workspace;
  }

  async saveWorkspace(nextWorkspace: Workspace): Promise<Workspace> {
    const savedWorkspace = await saveWorkspace(this.workspaceFilePath, nextWorkspace);
    this.workspace = savedWorkspace;

    await Promise.all(
      [...this.listeners].map((listener) => listener(savedWorkspace)),
    );

    return savedWorkspace;
  }

  subscribe(listener: WorkspaceListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }
}
