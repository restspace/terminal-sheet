import { z } from 'zod';

export const LOCAL_BACKEND_ID = 'local';

export const serverRoleSchema = z.enum(['standalone', 'home', 'remote']);

export const backendConnectionSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  baseUrl: z.url().trim(),
  token: z.string().trim().min(1),
  enabled: z.boolean().default(true),
});

export const backendStatusSchema = z.object({
  id: z.string(),
  label: z.string(),
  baseUrl: z.string(),
  state: z.enum(['connecting', 'connected', 'disconnected', 'auth-failed', 'error']),
  lastError: z.string().nullable(),
  connectedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});

export const backendCreateRequestSchema = z.object({
  label: z.string().trim().min(1),
  baseUrl: z.url().trim(),
  token: z.string().trim().min(1),
});

export const backendInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  baseUrl: z.string(),
  enabled: z.boolean(),
});

export const backendWorkspaceSnapshotSchema = z.object({
  terminals: z.array(z.unknown()),
});

export const machineHealthSchema = z.object({
  status: z.literal('ok'),
  role: serverRoleSchema,
  serverId: z.string(),
  timestamp: z.iso.datetime(),
});

export type ServerRole = z.infer<typeof serverRoleSchema>;
export type BackendConnection = z.infer<typeof backendConnectionSchema>;
export type BackendStatus = z.infer<typeof backendStatusSchema>;
export type BackendCreateRequest = z.infer<typeof backendCreateRequestSchema>;
export type BackendInfo = z.infer<typeof backendInfoSchema>;
export type MachineHealth = z.infer<typeof machineHealthSchema>;
