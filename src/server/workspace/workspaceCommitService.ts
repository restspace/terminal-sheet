import type { Workspace } from '../../shared/workspace';
import type { WorkspaceService } from '../persistence/workspaceService';
import { WorkspaceCommitPublisher } from './workspaceCommitPublisher';

export class WorkspaceCommitService {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly publisher: WorkspaceCommitPublisher,
  ) {}

  getWorkspace(): Workspace {
    return this.workspaceService.getWorkspace();
  }

  async commitWorkspace(nextWorkspace: Workspace): Promise<Workspace> {
    const savedWorkspace = await this.workspaceService.saveWorkspace(nextWorkspace);
    await this.publisher.publish(savedWorkspace);
    return savedWorkspace;
  }
}
