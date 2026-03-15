import type { AgentType } from '../../shared/workspace';
import type {
  AgentIntegrationPrepareContext,
  AgentIntegrationPrepareResult,
  AgentIntegrationProvider,
} from './agentIntegration';
import { prepareCodexNotifySetup } from './codexNotifySetup';
import { findNearestProjectRoot } from './projectRoot';

export class CodexIntegrationProvider implements AgentIntegrationProvider {
  readonly agentType = 'codex' as const;

  supports(agentType: AgentType): boolean {
    return agentType === this.agentType;
  }

  resolveProjectRoot(cwd: string): Promise<string | null> {
    return findNearestProjectRoot(cwd, ['.git', '.codex']);
  }

  async prepareForProject(
    context: AgentIntegrationPrepareContext,
  ): Promise<AgentIntegrationPrepareResult> {
    const result = await prepareCodexNotifySetup({
      projectRoot: context.projectRoot,
    });

    switch (result.phase) {
      case 'created':
      case 'updated':
      case 'unchanged':
        return {
          status: 'configured',
          message: result.message,
        };
      case 'conflict':
        return {
          status: 'conflict',
          message: result.message,
        };
      case 'error':
        return {
          status: 'error',
          message: result.message,
        };
    }
  }
}
