import { z } from 'zod';

export const LOCAL_BACKEND_ID = 'local';
const portSchema = z.number().int().min(1).max(65_535);

export const serverRoleSchema = z.enum(['standalone', 'home', 'remote']);

export const backendTransportSchema = z.enum(['direct', 'ssh-tunnel']);

export const backendSshTunnelConfigSchema = z.object({
  target: z.string().trim().min(1),
  port: portSchema.optional(),
  identityFile: z.string().trim().min(1).optional(),
  remoteHost: z.string().trim().min(1).default('127.0.0.1'),
  remotePort: portSchema.default(4312),
  localHost: z.string().trim().min(1).default('127.0.0.1'),
  localPort: portSchema,
});

export const backendConnectionSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  baseUrl: z.url().trim(),
  token: z.string().trim().min(1),
  transport: backendTransportSchema.default('direct'),
  ssh: backendSshTunnelConfigSchema.optional(),
  enabled: z.boolean().default(true),
}).superRefine((value, context) => {
  if (value.transport === 'ssh-tunnel' && !value.ssh) {
    context.addIssue({
      code: 'custom',
      message: 'SSH tunnel transport requires SSH configuration.',
      path: ['ssh'],
    });
  }
});

export const backendTunnelStatusSchema = z.object({
  backendId: z.string(),
  state: z.enum(['starting', 'connected', 'disconnected', 'error']),
  localUrl: z.string(),
  lastError: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});

export const backendStatusSchema = z.object({
  id: z.string(),
  label: z.string(),
  baseUrl: z.string(),
  state: z.enum(['connecting', 'connected', 'disconnected', 'auth-failed', 'error']),
  lastError: z.string().nullable(),
  connectedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
  tunnel: backendTunnelStatusSchema.nullable().optional().default(null),
});

export const backendCreateRequestSchema = z.object({
  label: z.string().trim().min(1),
  baseUrl: z.url().trim(),
  token: z.string().trim().min(1),
});

const backendTerminalAgentTypeSchema = z.enum(['claude', 'codex', 'shell']);

export const backendTerminalCreateRequestSchema = z.object({
  id: z.string().trim().min(1).optional(),
  label: z.string().trim().min(1),
  shell: z.string().trim().min(1),
  cwd: z.string().trim().min(1),
  agentType: backendTerminalAgentTypeSchema,
  repoLabel: z.string().trim().min(1).optional(),
  taskLabel: z.string().trim().min(1).optional(),
  tags: z.array(z.string()).default([]),
});

export const backendSshTokenModeSchema = z.enum([
  'install-output',
  'manual',
  'file',
]);

export const backendSshSetupRequestSchema = z.object({
  label: z.string().trim().min(1),
  sshTarget: z.string().trim().min(1),
  sshPort: portSchema.optional(),
  sshIdentityFile: z.string().trim().min(1).optional(),
  remotePort: portSchema.default(4312),
  localPort: portSchema.optional(),
  tokenMode: backendSshTokenModeSchema.default('manual'),
  token: z.string().trim().min(1).optional(),
  tokenPath: z.string().trim().min(1).optional(),
  runInstall: z.boolean().default(true),
}).superRefine((value, context) => {
  if (value.tokenMode === 'manual' && !value.token?.trim()) {
    context.addIssue({
      code: 'custom',
      message: 'Token is required for manual mode.',
      path: ['token'],
    });
  }

  if (value.tokenMode === 'file' && !value.tokenPath?.trim()) {
    context.addIssue({
      code: 'custom',
      message: 'Token path is required for file mode.',
      path: ['tokenPath'],
    });
  }

  if (value.tokenMode === 'install-output' && !value.runInstall) {
    context.addIssue({
      code: 'custom',
      message: 'Install-output token mode requires running the install script.',
      path: ['runInstall'],
    });
  }
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
export type BackendTransport = z.infer<typeof backendTransportSchema>;
export type BackendSshTunnelConfig = z.infer<typeof backendSshTunnelConfigSchema>;
export type BackendTunnelStatus = z.infer<typeof backendTunnelStatusSchema>;
export type BackendStatus = z.infer<typeof backendStatusSchema>;
export type BackendCreateRequest = z.infer<typeof backendCreateRequestSchema>;
export type BackendTerminalCreateRequest = z.infer<typeof backendTerminalCreateRequestSchema>;
export type BackendSshTokenMode = z.infer<typeof backendSshTokenModeSchema>;
export type BackendSshSetupRequest = z.infer<typeof backendSshSetupRequestSchema>;
export type BackendInfo = z.infer<typeof backendInfoSchema>;
export type MachineHealth = z.infer<typeof machineHealthSchema>;
