import { z } from 'zod';

export const agentTypeSchema = z.enum(['claude', 'codex', 'shell']);
export type AgentType = z.infer<typeof agentTypeSchema>;
