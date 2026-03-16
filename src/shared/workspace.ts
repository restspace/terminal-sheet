import { z } from 'zod';

import { updateById } from './collections';
import {
  backendConnectionSchema,
  LOCAL_BACKEND_ID,
} from './backends';
import { getDefaultShell } from './platform';

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
  backendId: z.string().default(LOCAL_BACKEND_ID),
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
});

export const workspaceFiltersSchema = z.object({
  attentionOnly: z.boolean(),
  activeMarkdownId: z.string().nullable(),
});

export const workspaceLayoutModeSchema = z.enum(['free', 'focus-tiles']);

export const workspaceSchema = z.object({
  version: z.literal(2),
  id: z.string(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  layoutMode: workspaceLayoutModeSchema.default('free'),
  currentViewport: cameraViewportSchema,
  terminals: z.array(terminalNodeSchema),
  markdown: z.array(markdownNodeSchema),
  backends: z.array(backendConnectionSchema).default([]),
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
export type WorkspaceBackend = z.infer<typeof backendConnectionSchema>;
export type WorkspaceFilters = z.infer<typeof workspaceFiltersSchema>;
export type WorkspaceLayoutMode = z.infer<typeof workspaceLayoutModeSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type SemanticZoomMode = z.infer<typeof semanticZoomModeSchema>;
export type TerminalNodePatch = Partial<
  Pick<
    TerminalNode,
    | 'label'
    | 'repoLabel'
    | 'taskLabel'
    | 'shell'
    | 'cwd'
    | 'agentType'
    | 'status'
    | 'tags'
  >
>;

export const MAX_LIVE_TERMINAL_SURFACES = 8;
export const MAX_LIVE_READ_ONLY_TERMINAL_PREVIEWS = MAX_LIVE_TERMINAL_SURFACES;

export interface CreateTerminalNodeInput {
  label: string;
  shell: string;
  cwd: string;
  agentType: AgentType;
  backendId?: string;
  repoLabel?: string;
  taskLabel?: string;
  tags?: string[];
}

export interface CreateMarkdownNodeInput {
  label: string;
  filePath: string;
  readOnly?: boolean;
}

interface PositionedNodeBounds {
  bounds: z.infer<typeof nodeBoundsSchema>;
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

export function getReadOnlyPreviewTerminalIds(
  terminals: readonly TerminalNode[],
  selectedNodeId: string | null,
  mode: SemanticZoomMode,
  maxPreviews = MAX_LIVE_READ_ONLY_TERMINAL_PREVIEWS,
): string[] {
  if (mode === 'overview' || maxPreviews <= 0) {
    return [];
  }

  const selectedTerminal =
    selectedNodeId === null
      ? null
      : (terminals.find((terminal) => terminal.id === selectedNodeId) ?? null);
  const orderedCandidates = terminals.filter((terminal) =>
    mode === 'focus' && selectedTerminal
      ? terminal.id !== selectedTerminal.id
      : true,
  );
  const previewBudget =
    mode === 'focus' && selectedTerminal
      ? Math.max(0, maxPreviews - 1)
      : maxPreviews;

  if (!selectedTerminal) {
    return orderedCandidates
      .slice(0, previewBudget)
      .map((terminal) => terminal.id);
  }

  const terminalOrder = new Map(
    terminals.map((terminal, index) => [terminal.id, index] as const),
  );
  const selectedCenter = getNodeCenter(selectedTerminal.bounds);

  return [...orderedCandidates]
    .sort((left, right) => {
      const leftDistance = distanceBetweenCenters(
        getNodeCenter(left.bounds),
        selectedCenter,
      );
      const rightDistance = distanceBetweenCenters(
        getNodeCenter(right.bounds),
        selectedCenter,
      );

      if (leftDistance !== rightDistance) {
        return leftDistance - rightDistance;
      }

      return (
        (terminalOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (terminalOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      );
    })
    .slice(0, previewBudget)
    .map((terminal) => terminal.id);
}

export function createDefaultWorkspace(): Workspace {
  const timestamp = new Date().toISOString();

  return {
    version: 2,
    id: 'workspace-default',
    name: 'Terminal Canvas',
    createdAt: timestamp,
    updatedAt: timestamp,
    layoutMode: 'free',
    currentViewport: { x: 0, y: 0, zoom: 0.72 },
    terminals: [],
    markdown: [],
    backends: [],
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
      backendId: LOCAL_BACKEND_ID,
      repoLabel: 'local workspace',
      taskLabel: 'placeholder session',
      shell: getDefaultShell(),
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
    backendId: input.backendId ?? LOCAL_BACKEND_ID,
    label: input.label,
    repoLabel: input.repoLabel,
    taskLabel: input.taskLabel,
    shell: input.shell,
    cwd: input.cwd,
    agentType: input.agentType,
    status: 'idle',
    bounds: {
      x: visibleOrigin.x + column * 440,
      y: visibleOrigin.y + row * 320,
      width: 400,
      height: 280,
    },
    tags: input.tags ?? [],
  };
}

export function createPlaceholderMarkdown(
  index: number,
  viewport?: CameraViewport,
): MarkdownNode {
  return createMarkdownNode(
    {
      label: `Notes ${index + 1}`,
      filePath: `./notes-${index + 1}.md`,
      readOnly: false,
    },
    index,
    viewport,
  );
}

export function createMarkdownNode(
  input: CreateMarkdownNodeInput,
  index: number,
  viewport?: CameraViewport,
): MarkdownNode {
  const id = createId('markdown');
  const column = index % 2;
  const row = Math.floor(index / 2);
  const visibleOrigin = getVisibleOrigin(viewport);

  return {
    id,
    label: input.label,
    filePath: input.filePath,
    readOnly: input.readOnly ?? false,
    bounds: {
      x: visibleOrigin.x + 120 + column * 360,
      y: visibleOrigin.y + 60 + row * 300,
      width: 320,
      height: 250,
    },
  };
}

export function createWorkspaceMarkdownNode(
  workspace: Workspace,
  input: CreateMarkdownNodeInput,
): MarkdownNode {
  const id = createId('markdown');
  const bounds = getNextMarkdownBounds(workspace);

  return {
    id,
    label: input.label,
    filePath: input.filePath,
    readOnly: input.readOnly ?? false,
    bounds,
  };
}

export function touchWorkspace(workspace: Workspace): Workspace {
  return {
    ...workspace,
    updatedAt: new Date().toISOString(),
  };
}

export function updateTerminalNode(
  workspace: Workspace,
  terminalId: string,
  patch: TerminalNodePatch,
): Workspace {
  const result = updateById(workspace.terminals, terminalId, (terminal) =>
    applyTerminalPatch(terminal, patch),
  );

  if (!result.found || !result.changed) {
    return workspace;
  }

  return {
    ...workspace,
    terminals: result.items,
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

function applyTerminalPatch(
  terminal: TerminalNode,
  patch: TerminalNodePatch,
): TerminalNode {
  const label = normalizeEditableText(patch.label, terminal.label);
  const repoLabel = normalizeOptionalText(patch.repoLabel, terminal.repoLabel);
  const taskLabel = normalizeOptionalText(patch.taskLabel, terminal.taskLabel);
  const shell = normalizeEditableText(patch.shell, terminal.shell);
  const cwd = normalizeEditableText(patch.cwd, terminal.cwd);

  return {
    ...terminal,
    label,
    repoLabel,
    taskLabel,
    shell,
    cwd,
    agentType: patch.agentType ?? terminal.agentType,
    status: patch.status ?? terminal.status,
    tags: patch.tags ?? terminal.tags,
  };
}

function normalizeEditableText(
  value: string | undefined,
  fallback: string,
): string {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim();

  return normalized || fallback;
}

function normalizeOptionalText(
  value: string | undefined,
  fallback: string | undefined,
): string | undefined {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim();

  return normalized || fallback;
}

function getNodeCenter(bounds: z.infer<typeof nodeBoundsSchema>): {
  x: number;
  y: number;
} {
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
}

function distanceBetweenCenters(
  left: { x: number; y: number },
  right: { x: number; y: number },
): number {
  const deltaX = left.x - right.x;
  const deltaY = left.y - right.y;

  return deltaX * deltaX + deltaY * deltaY;
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

function getNextMarkdownBounds(
  workspace: Workspace,
): z.infer<typeof nodeBoundsSchema> {
  const defaultBounds = createMarkdownNode(
    {
      label: 'Notes',
      filePath: './notes.md',
      readOnly: false,
    },
    workspace.markdown.length,
    workspace.currentViewport,
  ).bounds;
  const anchor = getViewportAnchorNode(workspace);

  if (!anchor) {
    return defaultBounds;
  }

  const preferredPositions = [
    {
      x: anchor.bounds.x + anchor.bounds.width + 40,
      y: anchor.bounds.y,
    },
    {
      x: anchor.bounds.x - defaultBounds.width - 40,
      y: anchor.bounds.y,
    },
    {
      x: anchor.bounds.x,
      y: anchor.bounds.y + anchor.bounds.height + 40,
    },
    {
      x: anchor.bounds.x,
      y: anchor.bounds.y - defaultBounds.height - 40,
    },
  ];

  for (const position of preferredPositions) {
    const candidate = {
      ...defaultBounds,
      x: position.x,
      y: position.y,
    };

    if (!hasNodeOverlap(candidate, workspace)) {
      return candidate;
    }
  }

  let candidate = {
    ...defaultBounds,
    x: anchor.bounds.x + anchor.bounds.width + 40,
    y: anchor.bounds.y,
  };

  while (hasNodeOverlap(candidate, workspace)) {
    candidate = {
      ...candidate,
      y: candidate.y + candidate.height + 32,
    };
  }

  return candidate;
}

function getViewportAnchorNode(workspace: Workspace): PositionedNodeBounds | null {
  const candidates: PositionedNodeBounds[] = [
    ...workspace.terminals,
    ...workspace.markdown,
  ];

  if (!candidates.length) {
    return null;
  }

  const viewportCenter = getViewportCenter(workspace.currentViewport);

  return [...candidates].sort((left, right) => {
    const leftDistance = distanceBetweenCenters(
      getNodeCenter(left.bounds),
      viewportCenter,
    );
    const rightDistance = distanceBetweenCenters(
      getNodeCenter(right.bounds),
      viewportCenter,
    );

    return leftDistance - rightDistance;
  })[0] ?? null;
}

function getViewportCenter(viewport: CameraViewport): { x: number; y: number } {
  const estimatedCanvasWidth = 1080;
  const estimatedCanvasHeight = 720;

  return {
    x: (estimatedCanvasWidth / 2 - viewport.x) / viewport.zoom,
    y: (estimatedCanvasHeight / 2 - viewport.y) / viewport.zoom,
  };
}

function hasNodeOverlap(
  bounds: z.infer<typeof nodeBoundsSchema>,
  workspace: Workspace,
): boolean {
  const allBounds = [
    ...workspace.terminals.map((terminal) => terminal.bounds),
    ...workspace.markdown.map((markdown) => markdown.bounds),
  ];

  return allBounds.some((candidate) => rectanglesOverlap(bounds, candidate, 24));
}

function rectanglesOverlap(
  left: z.infer<typeof nodeBoundsSchema>,
  right: z.infer<typeof nodeBoundsSchema>,
  gap: number,
): boolean {
  return !(
    left.x + left.width + gap <= right.x ||
    right.x + right.width + gap <= left.x ||
    left.y + left.height + gap <= right.y ||
    right.y + right.height + gap <= left.y
  );
}
