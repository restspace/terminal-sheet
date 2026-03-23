import type { Workspace } from '../../shared/workspace';
import { loadOrCreateWorkspace, saveWorkspace } from './workspaceStore';

export class WorkspaceService {
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
    const savedWorkspace = await saveWorkspace(
      this.workspaceFilePath,
      nextWorkspace,
    );
    this.workspace = savedWorkspace;

    return savedWorkspace;
  }
}
