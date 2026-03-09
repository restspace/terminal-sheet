import { z } from 'zod';

export const terminalStatusSchema = z.enum([
  'idle',
  'running',
  'active-output',
  'needs-input',
  'approval-needed',
  'completed',
  'failed',
  'disconnected',
]);

export const agentTypeSchema = z.enum(['claude', 'codex', 'shell']);

export const nodeBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});

export const cameraViewportSchema = z.object({
  x: z.number(),
  y: z.number(),
  zoom: z.number().positive(),
});

export const cameraPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  viewport: cameraViewportSchema,
});

export const terminalNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  repoLabel: z.string().optional(),
  taskLabel: z.string().optional(),
  shell: z.string(),
  cwd: z.string(),
  agentType: agentTypeSchema,
  status: terminalStatusSchema,
  bounds: nodeBoundsSchema,
  tags: z.array(z.string()),
});

export const markdownNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  filePath: z.string(),
  readOnly: z.boolean(),
  bounds: nodeBoundsSchema,
  linkedTerminalIds: z.array(z.string()),
});

export const workspaceFiltersSchema = z.object({
  attentionOnly: z.boolean(),
  activeMarkdownId: z.string().nullable(),
});

export const workspaceSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  currentViewport: cameraViewportSchema,
  terminals: z.array(terminalNodeSchema),
  markdown: z.array(markdownNodeSchema),
  cameraPresets: z.array(cameraPresetSchema),
  filters: workspaceFiltersSchema,
});

export const semanticZoomModeSchema = z.enum(['overview', 'inspect', 'focus']);

export type TerminalStatus = z.infer<typeof terminalStatusSchema>;
export type AgentType = z.infer<typeof agentTypeSchema>;
export type CameraViewport = z.infer<typeof cameraViewportSchema>;
export type CameraPreset = z.infer<typeof cameraPresetSchema>;
export type TerminalNode = z.infer<typeof terminalNodeSchema>;
export type MarkdownNode = z.infer<typeof markdownNodeSchema>;
export type WorkspaceFilters = z.infer<typeof workspaceFiltersSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type SemanticZoomMode = z.infer<typeof semanticZoomModeSchema>;

export interface CreateTerminalNodeInput {
  label: string;
  shell: string;
  cwd: string;
  agentType: AgentType;
  repoLabel?: string;
  taskLabel?: string;
  tags?: string[];
}

const overviewThreshold = 0.68;
const inspectThreshold = 1.12;

export function getSemanticZoomMode(zoom: number): SemanticZoomMode {
  if (zoom < overviewThreshold) {
    return 'overview';
  }

  if (zoom < inspectThreshold) {
    return 'inspect';
  }

  return 'focus';
}

export function createDefaultWorkspace(): Workspace {
  const timestamp = new Date().toISOString();

  return {
    version: 1,
    id: 'workspace-default',
    name: 'Terminal Canvas',
    createdAt: timestamp,
    updatedAt: timestamp,
    currentViewport: { x: 0, y: 0, zoom: 0.72 },
    terminals: [],
    markdown: [],
    cameraPresets: createDefaultCameraPresets(),
    filters: {
      attentionOnly: false,
      activeMarkdownId: null,
    },
  };
}

export function createPlaceholderTerminal(
  index: number,
  viewport?: CameraViewport,
): TerminalNode {
  return createTerminalNode(
    {
      label: `Shell ${index + 1}`,
      repoLabel: 'local workspace',
      taskLabel: 'placeholder session',
      shell: defaultShell(),
      cwd: '.',
      agentType: 'shell',
      tags: [],
    },
    index,
    viewport,
  );
}

export function createTerminalNode(
  input: CreateTerminalNodeInput,
  index: number,
  viewport?: CameraViewport,
): TerminalNode {
  const id = createId('terminal');
  const column = index % 2;
  const row = Math.floor(index / 2);
  const visibleOrigin = getVisibleOrigin(viewport);

  return {
    id,
    label: input.label,
    repoLabel: input.repoLabel,
    taskLabel: input.taskLabel,
    shell: input.shell,
    cwd: input.cwd,
    agentType: input.agentType,
    status: 'idle',
    bounds: {
      x: visibleOrigin.x + column * 360,
      y: visibleOrigin.y + row * 250,
      width: 320,
      height: 220,
    },
    tags: input.tags ?? [],
  };
}

export function createPlaceholderMarkdown(
  index: number,
  viewport?: CameraViewport,
): MarkdownNode {
  const id = createId('markdown');
  const column = index % 2;
  const row = Math.floor(index / 2);
  const visibleOrigin = getVisibleOrigin(viewport);

  return {
    id,
    label: `Notes ${index + 1}`,
    filePath: `./notes-${index + 1}.md`,
    readOnly: false,
    bounds: {
      x: visibleOrigin.x + 100 + column * 320,
      y: visibleOrigin.y + 40 + row * 260,
      width: 280,
      height: 220,
    },
    linkedTerminalIds: [],
  };
}

export function touchWorkspace(workspace: Workspace): Workspace {
  return {
    ...workspace,
    updatedAt: new Date().toISOString(),
  };
}

export function createDefaultCameraPresets(): CameraPreset[] {
  return [
    {
      id: 'all-sessions',
      name: 'All sessions',
      viewport: { x: 0, y: 0, zoom: 0.72 },
    },
    {
      id: 'needs-attention',
      name: 'Needs attention',
      viewport: { x: 60, y: -10, zoom: 0.9 },
    },
    {
      id: 'active-pair',
      name: 'Active pair',
      viewport: { x: 180, y: 0, zoom: 1.04 },
    },
    {
      id: 'writing-surface',
      name: 'Writing surface',
      viewport: { x: -120, y: 80, zoom: 1.15 },
    },
  ];
}

function createId(prefix: string): string {
  const token =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.round(Math.random() * 10_000)}`;

  return `${prefix}-${token}`;
}

function defaultShell(): string {
  if (typeof navigator !== 'undefined' && navigator.userAgent.includes('Win')) {
    return 'powershell.exe';
  }

  return 'bash';
}

function getVisibleOrigin(viewport?: CameraViewport): { x: number; y: number } {
  if (!viewport) {
    return { x: 80, y: 80 };
  }

  return {
    x: Math.round(-viewport.x / viewport.zoom + 80),
    y: Math.round(-viewport.y / viewport.zoom + 80),
  };
}
