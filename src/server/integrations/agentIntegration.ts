import type { TerminalIntegrationStatus } from '../../shared/terminalSessions';
import type { AgentType, TerminalNode } from '../../shared/workspace';

export interface AgentIntegrationPrepareContext {
  terminal: TerminalNode;
  projectRoot: string;
}

export interface AgentIntegrationPrepareResult {
  status: Exclude<
    TerminalIntegrationStatus,
    'not-required' | 'not-configured' | 'configuring'
  >;
  message: string;
}

export interface AgentIntegrationProvider {
  readonly agentType: AgentType;

  supports(agentType: AgentType): boolean;

  resolveProjectRoot(cwd: string): Promise<string | null>;

  prepareForProject(
    context: AgentIntegrationPrepareContext,
  ): Promise<AgentIntegrationPrepareResult>;
}

export interface AgentIntegrationRegistry {
  get(agentType: AgentType): AgentIntegrationProvider | null;
}
