import { z } from 'zod';

import { LOCAL_BACKEND_ID } from './backends';
import type { TerminalStatus } from './workspace';
import { terminalStatusSchema } from './workspace';

export const attentionEventSourceSchema = z.enum(['claude', 'codex', 'pty']);

export const attentionEventTypeSchema = z.enum([
  'activity',
  'needs-input',
  'approval-needed',
  'completed',
  'failed',
  'disconnected',
]);

export const attentionEventConfidenceSchema = z.enum(['high', 'medium', 'low']);

export const attentionEventSchema = z.object({
  id: z.string(),
  backendId: z.string().default(LOCAL_BACKEND_ID),
  sessionId: z.string(),
  source: attentionEventSourceSchema,
  eventType: attentionEventTypeSchema,
  status: terminalStatusSchema,
  timestamp: z.iso.datetime(),
  title: z.string(),
  detail: z.string(),
  confidence: attentionEventConfidenceSchema,
});

export const attentionIntegrationSetupSchema = z.object({
  receiverUrl: z.string(),
  token: z.string(),
  bash: z.object({
    claudeHookCommand: z.string(),
    codexNotifyCommand: z.string(),
  }),
  powershell: z.object({
    claudeHookCommand: z.string(),
    codexNotifyCommand: z.string(),
  }),
});

export type AttentionEventSource = z.infer<typeof attentionEventSourceSchema>;
export type AttentionEventType = z.infer<typeof attentionEventTypeSchema>;
export type AttentionEventConfidence = z.infer<
  typeof attentionEventConfidenceSchema
>;
export type AttentionEvent = z.infer<typeof attentionEventSchema>;
export type AttentionIntegrationSetup = z.infer<
  typeof attentionIntegrationSetupSchema
>;

export const ATTENTION_REQUIRED_STATUSES: readonly TerminalStatus[] = [
  'needs-input',
  'approval-needed',
  'failed',
  'disconnected',
] as const;

export function mapAttentionEventTypeToStatus(
  eventType: AttentionEventType,
): z.infer<typeof terminalStatusSchema> {
  switch (eventType) {
    case 'activity':
      return 'active-output';
    case 'needs-input':
      return 'needs-input';
    case 'approval-needed':
      return 'approval-needed';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'disconnected':
      return 'disconnected';
  }
}

export function isAttentionRequiredStatus(
  status: TerminalStatus,
): boolean {
  return ATTENTION_REQUIRED_STATUSES.includes(status);
}

export function shouldNotifyForAttentionEvent(
  event: Pick<AttentionEvent, 'eventType'>,
): boolean {
  return event.eventType !== 'activity';
}
