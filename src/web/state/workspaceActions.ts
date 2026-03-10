import { getDefaultShell } from '../../shared/platform';
import {
  createPlaceholderMarkdown,
  createTerminalNode,
  type CreateTerminalNodeInput,
  type CameraViewport,
  type TerminalNode,
  type TerminalNodePatch,
  type Workspace,
  updateTerminalNode,
} from '../../shared/workspace';

export function addTerminalToWorkspace(
  workspace: Workspace,
  input?: Partial<CreateTerminalNodeInput>,
): {
  workspace: Workspace;
  terminal: TerminalNode;
} {
  const terminal = createTerminalNode(
    {
      label: input?.label?.trim() || `Shell ${workspace.terminals.length + 1}`,
      shell: input?.shell?.trim() || getDefaultShell(),
      cwd: input?.cwd?.trim() || '.',
      agentType: input?.agentType ?? 'shell',
      repoLabel: input?.repoLabel?.trim() || 'local workspace',
      taskLabel: input?.taskLabel?.trim() || 'live terminal session',
      tags: input?.tags ?? [],
    },
    workspace.terminals.length,
    workspace.currentViewport,
  );

  return {
    terminal,
    workspace: {
      ...workspace,
      terminals: [...workspace.terminals, terminal],
    },
  };
}

export function addMarkdownToWorkspace(workspace: Workspace): Workspace {
  return {
    ...workspace,
    markdown: [
      ...workspace.markdown,
      createPlaceholderMarkdown(
        workspace.markdown.length,
        workspace.currentViewport,
      ),
    ],
  };
}

export function removeTerminalFromWorkspace(
  workspace: Workspace,
  terminalId: string,
): Workspace {
  const nextTerminals = workspace.terminals.filter(
    (terminal) => terminal.id !== terminalId,
  );

  if (nextTerminals.length === workspace.terminals.length) {
    return workspace;
  }

  return {
    ...workspace,
    terminals: nextTerminals,
    markdown: workspace.markdown.map((node) => ({
      ...node,
      linkedTerminalIds: node.linkedTerminalIds.filter(
        (linkedTerminalId) => linkedTerminalId !== terminalId,
      ),
    })),
  };
}

export function updateWorkspaceTerminal(
  workspace: Workspace,
  terminalId: string,
  patch: TerminalNodePatch,
): Workspace {
  return updateTerminalNode(workspace, terminalId, patch);
}

export function setWorkspaceViewport(
  workspace: Workspace,
  viewport: CameraViewport,
): Workspace {
  if (sameViewport(workspace.currentViewport, viewport)) {
    return workspace;
  }

  return {
    ...workspace,
    currentViewport: viewport,
  };
}

export function applyWorkspaceCameraPreset(
  workspace: Workspace,
  presetId: string,
): Workspace {
  const preset = workspace.cameraPresets.find(
    (candidate) => candidate.id === presetId,
  );

  if (!preset) {
    return workspace;
  }

  return {
    ...workspace,
    currentViewport: preset.viewport,
  };
}

export function saveWorkspaceViewportToPreset(
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

function sameViewport(left: CameraViewport, right: CameraViewport): boolean {
  return (
    almostEqual(left.x, right.x) &&
    almostEqual(left.y, right.y) &&
    almostEqual(left.zoom, right.zoom)
  );
}

function almostEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.001;
}
