import { z } from 'zod';

import { agentTypeSchema } from './agentTypes';

export const spawnRequestSchema = z.object({
  command: z.string().trim().min(1),
  label: z.string().trim().optional(),
  cwd: z.string().trim().optional(),
  agentType: agentTypeSchema.optional(),
  tags: z.array(z.string()).optional(),
});

export const spawnResponseSchema = z.object({
  ok: z.literal(true),
  terminalId: z.string(),
  sessionId: z.string(),
});

export const spawnWaitResponseSchema = z.object({
  terminalId: z.string(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
});

export const spawnReadResponseSchema = z.object({
  terminalId: z.string(),
  scrollback: z.string(),
  lastOutputLine: z.string().nullable(),
  exitCode: z.number().int().nullable(),
});

export const spawnResultPayloadSchema = z.object({
  data: z.unknown(),
});

export const spawnResultResponseSchema = z.object({
  terminalId: z.string(),
  hasResult: z.boolean(),
  data: z.unknown().optional(),
});

export type SpawnRequest = z.infer<typeof spawnRequestSchema>;
export type SpawnResponse = z.infer<typeof spawnResponseSchema>;
export type SpawnWaitResponse = z.infer<typeof spawnWaitResponseSchema>;
export type SpawnReadResponse = z.infer<typeof spawnReadResponseSchema>;
export type SpawnResultPayload = z.infer<typeof spawnResultPayloadSchema>;
export type SpawnResultResponse = z.infer<typeof spawnResultResponseSchema>;
