import { z } from 'zod';

import { updateById } from './collections';
import { getDefaultShell } from './platform';
import {
  agentTypeSchema,
  cameraViewportSchema,
  createTerminalNode,
  createWorkspaceMarkdownNode,
  nodeBoundsSchema,
  markdownNodeSchema,
  terminalNodeSchema,
  workspaceSchema,
  terminalStatusSchema,
  type CreateMarkdownNodeInput,
  type CreateTerminalNodeInput,
  type TerminalNodePatch,
  type Workspace,
  type WorkspaceLayoutMode,
  updateTerminalNode,
  workspaceLayoutModeSchema,
} from './workspace';

export const workspaceAddTerminalCommandInputSchema = z.object({
  label: z.string().optional(),
  shell: z.string().optional(),
  cwd: z.string().optional(),
  agentType: agentTypeSchema.optional(),
  backendId: z.string().optional(),
  repoLabel: z.string().optional(),
  taskLabel: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const workspaceAddMarkdownCommandInputSchema = z.object({
  label: z.string().optional(),
  filePath: z.string().optional(),
  readOnly: z.boolean().optional(),
});

export const workspaceTerminalPatchSchema = z.object({
  label: z.string().optional(),
  repoLabel: z.string().optional(),
  taskLabel: z.string().optional(),
  shell: z.string().optional(),
  cwd: z.string().optional(),
  agentType: agentTypeSchema.optional(),
  status: terminalStatusSchema.optional(),
  tags: z.array(z.string()).optional(),
});

export const workspaceAddTerminalCommandSchema = z.object({
  type: z.literal('add-terminal'),
  terminal: terminalNodeSchema.optional(),
  input: workspaceAddTerminalCommandInputSchema.default({}).optional(),
}).superRefine((value, context) => {
  if (!value.terminal && !value.input) {
    context.addIssue({
      code: 'custom',
      path: ['terminal'],
      message: 'add-terminal requires a terminal or input payload.',
    });
  }
});

export const workspaceAddMarkdownCommandSchema = z.object({
  type: z.literal('add-markdown'),
  input: workspaceAddMarkdownCommandInputSchema.default({}),
});

export const workspaceUpdateTerminalCommandSchema = z.object({
  type: z.literal('update-terminal'),
  terminalId: z.string().trim().min(1),
  patch: workspaceTerminalPatchSchema,
});

export const workspaceRemoveNodeCommandSchema = z.object({
  type: z.literal('remove-node'),
  nodeId: z.string().trim().min(1),
});

export const workspaceRemoveTerminalCommandSchema = z.object({
  type: z.literal('remove-terminal'),
  terminalId: z.string().trim().min(1),
});

export const workspaceRemoveMarkdownCommandSchema = z.object({
  type: z.literal('remove-markdown'),
  markdownId: z.string().trim().min(1),
});

export const workspaceSetNodeBoundsCommandSchema = z.object({
  type: z.literal('set-node-bounds'),
  nodeId: z.string().trim().min(1),
  bounds: nodeBoundsSchema.partial(),
});

export const workspaceSetViewportCommandSchema = z.object({
  type: z.literal('set-viewport'),
  viewport: cameraViewportSchema,
});

export const workspaceSaveViewportToPresetCommandSchema = z.object({
  type: z.literal('save-viewport-to-preset'),
  presetId: z.string().trim().min(1),
});

export const workspaceSaveCameraPresetCommandSchema = z.object({
  type: z.literal('save-camera-preset'),
  presetId: z.string().trim().min(1),
});

export const workspaceSetLayoutModeCommandSchema = z.object({
  type: z.literal('set-layout-mode'),
  layoutMode: workspaceLayoutModeSchema,
});

export const workspaceMutationCommandSchema = z.discriminatedUnion('type', [
  workspaceAddTerminalCommandSchema,
  workspaceAddMarkdownCommandSchema,
  workspaceUpdateTerminalCommandSchema,
  workspaceRemoveNodeCommandSchema,
  workspaceRemoveTerminalCommandSchema,
  workspaceRemoveMarkdownCommandSchema,
  workspaceSetNodeBoundsCommandSchema,
  workspaceSetViewportCommandSchema,
  workspaceSaveViewportToPresetCommandSchema,
  workspaceSaveCameraPresetCommandSchema,
  workspaceSetLayoutModeCommandSchema,
]);

const workspaceMutationBaseRequestSchema = z.object({
  baseUpdatedAt: z.string().nullable().optional(),
});

const workspaceMutationBatchRequestSchema = workspaceMutationBaseRequestSchema.extend({
  commands: z.array(workspaceMutationCommandSchema).min(1),
});

const workspaceMutationLegacyRequestSchema = workspaceMutationBaseRequestSchema.extend({
  command: workspaceMutationCommandSchema,
});

export const workspaceMutationRequestSchema = z.union([
  workspaceMutationBatchRequestSchema,
  workspaceMutationLegacyRequestSchema,
]).transform((value) => {
  if ('commands' in value) {
    return {
      commands: value.commands,
      baseUpdatedAt: normalizeBaseUpdatedAt(value.baseUpdatedAt),
    };
  }

  return {
    commands: [value.command],
    baseUpdatedAt: normalizeBaseUpdatedAt(value.baseUpdatedAt),
  };
});

export const workspaceCommandRequestSchema = workspaceMutationRequestSchema;

export const workspaceCommandResponseSchema = z.object({
  workspace: workspaceSchema,
  terminal: terminalNodeSchema.optional(),
  markdownNode: markdownNodeSchema.optional(),
});

export type WorkspaceAddTerminalCommandInput = z.infer<
  typeof workspaceAddTerminalCommandInputSchema
>;
export type WorkspaceAddMarkdownCommandInput = z.infer<
  typeof workspaceAddMarkdownCommandInputSchema
>;
export type WorkspaceTerminalPatch = z.infer<typeof workspaceTerminalPatchSchema>;
export type WorkspaceMutationCommand = z.infer<
  typeof workspaceMutationCommandSchema
>;
export type WorkspaceMutationRequest = z.infer<
  typeof workspaceMutationRequestSchema
>;
export type WorkspaceCommand = z.input<typeof workspaceMutationCommandSchema>;
export type WorkspaceCommandResponse = z.infer<
  typeof workspaceCommandResponseSchema
>;

export function applyWorkspaceCommands(
  workspace: Workspace,
  commands: readonly WorkspaceMutationCommand[],
): Workspace {
  let nextWorkspace = workspace;

  for (const command of commands) {
    nextWorkspace = applyWorkspaceCommand(nextWorkspace, command);
  }

  return nextWorkspace;
}

export function applyWorkspaceCommand(
  workspace: Workspace,
  command: WorkspaceMutationCommand,
): Workspace {
  switch (command.type) {
    case 'add-terminal':
      return command.terminal
        ? {
            ...workspace,
            terminals: [...workspace.terminals, command.terminal],
          }
        : addTerminalToWorkspace(workspace, command.input);
    case 'add-markdown':
      return addMarkdownToWorkspace(workspace, command.input);
    case 'update-terminal':
      return updateTerminalNode(workspace, command.terminalId, command.patch);
    case 'remove-node':
      return removeNodeFromWorkspace(workspace, command.nodeId);
    case 'remove-terminal':
      return removeNodeFromWorkspace(workspace, command.terminalId);
    case 'remove-markdown':
      return removeNodeFromWorkspace(workspace, command.markdownId);
    case 'set-node-bounds':
      return setWorkspaceNodeBounds(workspace, command.nodeId, command.bounds);
    case 'set-viewport':
      return setWorkspaceViewport(workspace, command.viewport);
    case 'save-viewport-to-preset':
      return saveWorkspaceViewportToPreset(workspace, command.presetId);
    case 'save-camera-preset':
      return saveWorkspaceViewportToPreset(workspace, command.presetId);
    case 'set-layout-mode':
      return setWorkspaceLayoutMode(workspace, command.layoutMode);
  }
}

export function addTerminalToWorkspace(
  workspace: Workspace,
  input?: WorkspaceAddTerminalCommandInput,
): Workspace {
  const terminalInput = normalizeTerminalInput(workspace, input);

  return {
    ...workspace,
    terminals: [
      ...workspace.terminals,
      createTerminalNode(
        terminalInput,
        workspace.terminals.length,
        workspace.currentViewport,
      ),
    ],
  };
}

export function addMarkdownToWorkspace(
  workspace: Workspace,
  input?: WorkspaceAddMarkdownCommandInput,
): Workspace {
  const markdownInput = normalizeMarkdownInput(workspace, input);

  return {
    ...workspace,
    markdown: [
      ...workspace.markdown,
      createWorkspaceMarkdownNode(workspace, markdownInput),
    ],
  };
}

function removeNodeFromWorkspace(workspace: Workspace, nodeId: string): Workspace {
  const terminalIndex = workspace.terminals.findIndex(
    (terminal) => terminal.id === nodeId,
  );

  if (terminalIndex >= 0) {
    return {
      ...workspace,
      terminals: workspace.terminals.filter((terminal) => terminal.id !== nodeId),
    };
  }

  const markdownIndex = workspace.markdown.findIndex(
    (markdown) => markdown.id === nodeId,
  );

  if (markdownIndex < 0) {
    return workspace;
  }

  return {
    ...workspace,
    markdown: workspace.markdown.filter((markdown) => markdown.id !== nodeId),
    filters: {
      ...workspace.filters,
      activeMarkdownId:
        workspace.filters.activeMarkdownId === nodeId
          ? null
          : workspace.filters.activeMarkdownId,
    },
  };
}

function setWorkspaceNodeBounds(
  workspace: Workspace,
  nodeId: string,
  bounds: Partial<Workspace['terminals'][number]['bounds']>,
): Workspace {
  const terminalResult = updateById(workspace.terminals, nodeId, (terminal) => {
    const nextBounds = {
      ...terminal.bounds,
      ...bounds,
    };

    if (sameNodeBounds(terminal.bounds, nextBounds)) {
      return terminal;
    }

    return {
      ...terminal,
      bounds: nextBounds,
    };
  });

  if (terminalResult.found && terminalResult.changed) {
    return {
      ...workspace,
      terminals: terminalResult.items,
    };
  }

  const markdownResult = updateById(workspace.markdown, nodeId, (markdown) => {
    const nextBounds = {
      ...markdown.bounds,
      ...bounds,
    };

    if (sameNodeBounds(markdown.bounds, nextBounds)) {
      return markdown;
    }

    return {
      ...markdown,
      bounds: nextBounds,
    };
  });

  if (markdownResult.found && markdownResult.changed) {
    return {
      ...workspace,
      markdown: markdownResult.items,
    };
  }

  return workspace;
}

function setWorkspaceViewport(
  workspace: Workspace,
  viewport: Workspace['currentViewport'],
): Workspace {
  if (sameViewport(workspace.currentViewport, viewport)) {
    return workspace;
  }

  return {
    ...workspace,
    currentViewport: viewport,
  };
}

function saveWorkspaceViewportToPreset(
  workspace: Workspace,
  presetId: string,
): Workspace {
  let changed = false;

  const cameraPresets = workspace.cameraPresets.map((preset) => {
    if (preset.id !== presetId) {
      return preset;
    }

    changed = true;
    return {
      ...preset,
      viewport: workspace.currentViewport,
    };
  });

  if (!changed) {
    return workspace;
  }

  return {
    ...workspace,
    cameraPresets,
  };
}

function setWorkspaceLayoutMode(
  workspace: Workspace,
  layoutMode: WorkspaceLayoutMode,
): Workspace {
  if (workspace.layoutMode === layoutMode) {
    return workspace;
  }

  return {
    ...workspace,
    layoutMode,
  };
}

function normalizeTerminalInput(
  workspace: Workspace,
  input?: WorkspaceAddTerminalCommandInput,
): CreateTerminalNodeInput {
  return {
    label: normalizeEditableText(
      input?.label,
      `Shell ${workspace.terminals.length + 1}`,
    ),
    shell: normalizeEditableText(input?.shell, getDefaultShell()),
    cwd: normalizeEditableText(input?.cwd, '.'),
    agentType: input?.agentType ?? 'shell',
    backendId: normalizeOptionalText(input?.backendId, undefined),
    repoLabel: normalizeOptionalText(input?.repoLabel, 'local workspace'),
    taskLabel: normalizeOptionalText(input?.taskLabel, 'live terminal session'),
    tags: input?.tags ?? [],
  };
}

function normalizeMarkdownInput(
  workspace: Workspace,
  input?: WorkspaceAddMarkdownCommandInput,
): CreateMarkdownNodeInput {
  const nextIndex = workspace.markdown.length + 1;

  return {
    label: normalizeEditableText(input?.label, `Notes ${nextIndex}`),
    filePath: normalizeEditableText(input?.filePath, `./notes-${nextIndex}.md`),
    readOnly: input?.readOnly ?? false,
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

function normalizeBaseUpdatedAt(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function sameViewport(left: Workspace['currentViewport'], right: Workspace['currentViewport']): boolean {
  return (
    almostEqual(left.x, right.x) &&
    almostEqual(left.y, right.y) &&
    almostEqual(left.zoom, right.zoom)
  );
}

function sameNodeBounds(
  left: Workspace['terminals'][number]['bounds'],
  right: Workspace['terminals'][number]['bounds'],
): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function almostEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.001;
}
