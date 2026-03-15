import type { AgentType } from '../../shared/workspace';
import type {
  AgentIntegrationProvider,
  AgentIntegrationRegistry,
} from './agentIntegration';
import { ClaudeIntegrationProvider } from './claudeIntegrationProvider';
import { CodexIntegrationProvider } from './codexIntegrationProvider';

export function createAgentIntegrationRegistry(options: {
  attentionReceiverUrl: string;
}): AgentIntegrationRegistry {
  const providers: AgentIntegrationProvider[] = [
    new ClaudeIntegrationProvider({
      attentionReceiverUrl: options.attentionReceiverUrl,
    }),
    new CodexIntegrationProvider(),
  ];

  return {
    get(agentType: AgentType): AgentIntegrationProvider | null {
      return (
        providers.find((provider) => provider.supports(agentType)) ?? null
      );
    },
  };
}
