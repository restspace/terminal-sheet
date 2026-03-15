import type { AgentType } from '../../shared/workspace';
import type {
  AgentIntegrationPrepareContext,
  AgentIntegrationPrepareResult,
  AgentIntegrationProvider,
} from './agentIntegration';
import { prepareClaudeHookSetup } from './claudeHookSetup';
import { findNearestProjectRoot } from './projectRoot';

export class ClaudeIntegrationProvider implements AgentIntegrationProvider {
  readonly agentType = 'claude' as const;

  constructor(
    private readonly options: {
      attentionReceiverUrl: string;
    },
  ) {}

  supports(agentType: AgentType): boolean {
    return agentType === this.agentType;
  }

  resolveProjectRoot(cwd: string): Promise<string | null> {
    return findNearestProjectRoot(cwd, ['.git', '.claude']);
  }

  async prepareForProject(
    context: AgentIntegrationPrepareContext,
  ): Promise<AgentIntegrationPrepareResult> {
    const result = await prepareClaudeHookSetup({
      projectRoot: context.projectRoot,
      attentionReceiverUrl: this.options.attentionReceiverUrl,
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
