import { z } from 'zod';

import { terminalStatusSchema } from './workspace';

export const terminalRecoveryStateSchema = z.enum([
  'live',
  'restartable',
  'spawn-failed',
]);

export const terminalSessionSnapshotSchema = z.object({
  sessionId: z.string(),
  pid: z.number().int().nullable(),
  status: terminalStatusSchema,
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
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

export const terminalSocketReadyMessageSchema = z.object({
  type: z.literal('ready'),
  timestamp: z.iso.datetime(),
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
  data: z.string(),
});

export const terminalSessionRemovedMessageSchema = z.object({
  type: z.literal('session.removed'),
  sessionId: z.string(),
});

export const terminalServerSocketMessageSchema = z.discriminatedUnion('type', [
  terminalSocketReadyMessageSchema,
  terminalSessionInitMessageSchema,
  terminalSessionSnapshotMessageSchema,
  terminalSessionOutputMessageSchema,
  terminalSessionRemovedMessageSchema,
]);

export const terminalInputMessageSchema = z.object({
  type: z.literal('terminal.input'),
  sessionId: z.string(),
  data: z.string(),
});

export const terminalResizeMessageSchema = z.object({
  type: z.literal('terminal.resize'),
  sessionId: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
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
  terminalInputMessageSchema,
  terminalResizeMessageSchema,
  terminalRestartMessageSchema,
  terminalMarkReadMessageSchema,
]);

export type TerminalRecoveryState = z.infer<typeof terminalRecoveryStateSchema>;
export type TerminalSessionSnapshot = z.infer<
  typeof terminalSessionSnapshotSchema
>;
export type TerminalServerSocketMessage = z.infer<
  typeof terminalServerSocketMessageSchema
>;
export type TerminalClientSocketMessage = z.infer<
  typeof terminalClientSocketMessageSchema
>;
