import { describe, expect, it } from 'vitest';

import { createDefaultWorkspace } from '../../shared/workspace';
import {
  addMarkdownToWorkspace,
  addTerminalToWorkspace,
  applyWorkspaceCameraPreset,
  removeTerminalFromWorkspace,
  saveWorkspaceViewportToPreset,
  setWorkspaceViewport,
} from './workspaceActions';

describe('workspace actions', () => {
  it('adds terminal nodes with defaults', () => {
    const workspace = createDefaultWorkspace();
    const nextState = addTerminalToWorkspace(workspace, {
      label: 'Build worker',
    });

    expect(nextState.terminal.label).toBe('Build worker');
    expect(nextState.workspace.terminals).toHaveLength(1);
  });

  it('adds markdown nodes', () => {
    const workspace = addMarkdownToWorkspace(createDefaultWorkspace());

    expect(workspace.markdown).toHaveLength(1);
    expect(workspace.markdown[0]?.label).toBe('Notes 1');
  });

  it('removes terminal nodes and unlinks markdown references', () => {
    const workspace = createDefaultWorkspace();
    const firstTerminal = addTerminalToWorkspace(workspace, {
      label: 'Build worker',
    });
    const secondTerminal = addTerminalToWorkspace(firstTerminal.workspace, {
      label: 'Review worker',
    });
    const nextWorkspace = removeTerminalFromWorkspace(
      {
        ...secondTerminal.workspace,
        markdown: [
          {
            id: 'markdown-1',
            label: 'Notes 1',
            filePath: './notes-1.md',
            readOnly: false,
            bounds: {
              x: 0,
              y: 0,
              width: 320,
              height: 240,
            },
            linkedTerminalIds: [
              firstTerminal.terminal.id,
              secondTerminal.terminal.id,
            ],
          },
        ],
      },
      firstTerminal.terminal.id,
    );

    expect(nextWorkspace.terminals).toHaveLength(1);
    expect(nextWorkspace.terminals[0]?.id).toBe(secondTerminal.terminal.id);
    expect(nextWorkspace.markdown[0]?.linkedTerminalIds).toEqual([
      secondTerminal.terminal.id,
    ]);
  });

  it('applies and saves camera presets', () => {
    const workspace = createDefaultWorkspace();
    const presetApplied = applyWorkspaceCameraPreset(workspace, 'active-pair');

    expect(presetApplied.currentViewport.zoom).toBe(1.04);

    const updatedViewport = setWorkspaceViewport(presetApplied, {
      x: 200,
      y: -20,
      zoom: 1.2,
    });
    const savedPreset = saveWorkspaceViewportToPreset(
      updatedViewport,
      'active-pair',
    );

    expect(
      savedPreset.cameraPresets.find((preset) => preset.id === 'active-pair')
        ?.viewport,
    ).toEqual({
      x: 200,
      y: -20,
      zoom: 1.2,
    });
  });
});
