import { z } from 'zod';

export const eventSourceSchema = z.enum(['claude', 'codex', 'pty']);

export const eventTypeSchema = z.enum([
  'needs-input',
  'approval-needed',
  'completed',
  'error',
  'activity',
]);

export const confidenceSchema = z.enum(['high', 'medium', 'low']);

export const attentionEventSchema = z.object({
  sessionId: z.string(),
  source: eventSourceSchema,
  eventType: eventTypeSchema,
  timestamp: z.iso.datetime(),
  title: z.string(),
  detail: z.string(),
  confidence: confidenceSchema,
});

export type AttentionEvent = z.infer<typeof attentionEventSchema>;
