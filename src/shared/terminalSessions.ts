import { z } from 'zod';

import { LOCAL_BACKEND_ID } from './backends';
import { attentionEventSchema } from './events';
import {
  frontendSessionOwnerSchema,
  frontendSessionLockedResponseSchema,
} from './frontendSessionTransport';
import {
  markdownDocumentInitMessageSchema,
  markdownDocumentMessageSchema,
  markdownLinkInitMessageSchema,
  markdownLinkMessageSchema,
} from './markdown';
import { workspaceSchema } from './workspace';
import { agentTypeSchema, terminalStatusSchema } from './workspace';

export const terminalRecoveryStateSchema = z.enum([
  'live',
  'restartable',
  'spawn-failed',
]);

export const terminalCommandStateSchema = z.enum([
  'idle-at-prompt',
  'running-command',
]);

export const terminalIntegrationStatusSchema = z.enum([
  'not-required',
  'not-configured',
  'configuring',
  'configured',
  'conflict',
  'error',
]);

export const terminalIntegrationStateSchema = z.object({
  owner: agentTypeSchema.nullable(),
  status: terminalIntegrationStatusSchema,
  message: z.string().nullable(),
  updatedAt: z.iso.datetime().nullable(),
});

export const terminalSessionSnapshotSchema = z.object({
  sessionId: z.string(),
  backendId: z.string().default(LOCAL_BACKEND_ID),
  pid: z.number().int().nullable(),
  status: terminalStatusSchema,
  commandState: terminalCommandStateSchema,
  connected: z.boolean(),
  recoveryState: terminalRecoveryStateSchema,
  startedAt: z.iso.datetime().nullable(),
  lastActivityAt: z.iso.datetime().nullable(),
  lastOutputAt: z.iso.datetime().nullable(),
  lastOutputLine: z.string().nullable(),
  previewLines: z.array(z.string()),
  scrollback: z.string(),
  unreadCount: z.number().int().nonnegative(),
  summary: z.string(),
  exitCode: z.number().int().nullable(),
  disconnectReason: z.string().nullable(),
  cols: z.number().int().positive().nullable(),
  rows: z.number().int().positive().nullable(),
  appliedResizeGeneration: z.number().int().nonnegative().nullable(),
  liveCwd: z.string().nullable(),
  projectRoot: z.string().nullable(),
  integration: terminalIntegrationStateSchema,
});

export const terminalSessionOutputStateSchema =
  terminalSessionSnapshotSchema.omit({
    sessionId: true,
    backendId: true,
    scrollback: true,
  });

export const terminalSocketReadyMessageSchema = z.object({
  type: z.literal('ready'),
  timestamp: z.iso.datetime(),
});
export const frontendLeaseMessageSchema = z.object({
  type: z.literal('frontend.lease'),
  lease: frontendSessionOwnerSchema,
});

export const frontendLockedMessageSchema = z.object({
  type: z.literal('frontend.locked'),
  lock: frontendSessionLockedResponseSchema,
});

export const workspaceUpdatedMessageSchema = z.object({
  type: z.literal('workspace.updated'),
  workspace: workspaceSchema,
});

export const terminalSessionInitMessageSchema = z.object({
  type: z.literal('session.init'),
  sessions: z.array(terminalSessionSnapshotSchema),
});

export const terminalSessionSnapshotMessageSchema = z.object({
  type: z.literal('session.snapshot'),
  session: terminalSessionSnapshotSchema,
});

export const terminalSessionOutputMessageSchema = z.object({
  type: z.literal('session.output'),
  sessionId: z.string(),
  backendId: z.string().default(LOCAL_BACKEND_ID),
  data: z.string(),
  state: terminalSessionOutputStateSchema,
});

export const terminalSessionRemovedMessageSchema = z.object({
  type: z.literal('session.removed'),
  sessionId: z.string(),
  backendId: z.string().default(LOCAL_BACKEND_ID),
});

export const attentionInitMessageSchema = z.object({
  type: z.literal('attention.init'),
  events: z.array(attentionEventSchema),
});

export const attentionEventMessageSchema = z.object({
  type: z.literal('attention.event'),
  event: attentionEventSchema,
});

export const terminalServerSocketMessageSchema = z.discriminatedUnion('type', [
  frontendLeaseMessageSchema,
  frontendLockedMessageSchema,
  terminalSocketReadyMessageSchema,
  workspaceUpdatedMessageSchema,
  terminalSessionInitMessageSchema,
  terminalSessionSnapshotMessageSchema,
  terminalSessionOutputMessageSchema,
  terminalSessionRemovedMessageSchema,
  attentionInitMessageSchema,
  attentionEventMessageSchema,
  markdownDocumentInitMessageSchema,
  markdownDocumentMessageSchema,
  markdownLinkInitMessageSchema,
  markdownLinkMessageSchema,
]);

export const terminalInputMessageSchema = z.object({
  type: z.literal('terminal.input'),
  sessionId: z.string(),
  data: z.string(),
});
export const frontendHeartbeatMessageSchema = z.object({
  type: z.literal('frontend.heartbeat'),
  timestamp: z.iso.datetime(),
});

export const terminalResizeMessageSchema = z.object({
  type: z.literal('terminal.resize'),
  sessionId: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  generation: z.number().int().positive(),
});

export const terminalRestartMessageSchema = z.object({
  type: z.literal('terminal.restart'),
  sessionId: z.string(),
});

export const terminalMarkReadMessageSchema = z.object({
  type: z.literal('terminal.mark-read'),
  sessionId: z.string(),
});

export const terminalClientSocketMessageSchema = z.discriminatedUnion('type', [
  frontendHeartbeatMessageSchema,
  terminalInputMessageSchema,
  terminalResizeMessageSchema,
  terminalRestartMessageSchema,
  terminalMarkReadMessageSchema,
]);

export type TerminalRecoveryState = z.infer<typeof terminalRecoveryStateSchema>;
export type TerminalCommandState = z.infer<typeof terminalCommandStateSchema>;
export type TerminalIntegrationStatus = z.infer<
  typeof terminalIntegrationStatusSchema
>;
export type TerminalIntegrationState = z.infer<
  typeof terminalIntegrationStateSchema
>;
export type TerminalSessionSnapshot = z.infer<
  typeof terminalSessionSnapshotSchema
>;
export type TerminalSessionOutputState = z.infer<
  typeof terminalSessionOutputStateSchema
>;
export type TerminalServerSocketMessage = z.infer<
  typeof terminalServerSocketMessageSchema
>;
export type TerminalClientSocketMessage = z.infer<
  typeof terminalClientSocketMessageSchema
>;
