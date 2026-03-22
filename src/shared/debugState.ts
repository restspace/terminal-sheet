import { z } from 'zod';

export const stateDebugEventSchema = z.object({
  timestamp: z.iso.datetime(),
  scope: z.string(),
  event: z.string(),
  details: z.unknown(),
});

export const stateDebugEventBatchSchema = z.object({
  sessionId: z.string().nullable(),
  events: z.array(stateDebugEventSchema).max(200),
});

export type StateDebugEvent = z.infer<typeof stateDebugEventSchema>;
export type StateDebugEventBatch = z.infer<typeof stateDebugEventBatchSchema>;
