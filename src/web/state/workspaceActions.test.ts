import { describe, expect, it } from 'vitest';

import { createDefaultWorkspace } from '../../shared/workspace';
import {
  addMarkdownToWorkspace,
  addTerminalToWorkspace,
  applyWorkspaceCameraPreset,
  removeMarkdownFromWorkspace,
  removeTerminalFromWorkspace,
  saveWorkspaceViewportToPreset,
  setWorkspaceLayoutMode,
  setWorkspaceSelectedNode,
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

  it('removes terminal nodes without mutating markdown nodes', () => {
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
          },
        ],
      },
      firstTerminal.terminal.id,
    );

    expect(nextWorkspace.terminals).toHaveLength(1);
    expect(nextWorkspace.terminals[0]?.id).toBe(secondTerminal.terminal.id);
    expect(nextWorkspace.markdown).toHaveLength(1);
  });

  it('clears selectedNodeId when the selected terminal is removed', () => {
    const firstTerminal = addTerminalToWorkspace(createDefaultWorkspace(), {
      label: 'Build worker',
    });
    const secondTerminal = addTerminalToWorkspace(firstTerminal.workspace, {
      label: 'Review worker',
    });
    const selectedWorkspace = setWorkspaceSelectedNode(
      secondTerminal.workspace,
      firstTerminal.terminal.id,
    );

    const nextWorkspace = removeTerminalFromWorkspace(
      selectedWorkspace,
      firstTerminal.terminal.id,
    );

    expect(nextWorkspace.selectedNodeId).toBeNull();
  });

  it('removes markdown nodes', () => {
    const workspace = addMarkdownToWorkspace(createDefaultWorkspace());
    const markdownId = workspace.markdown[0]?.id;

    expect(markdownId).toBeTruthy();

    const nextWorkspace = removeMarkdownFromWorkspace(
      workspace,
      markdownId as string,
    );

    expect(nextWorkspace.markdown).toHaveLength(0);
  });

  it('stores selectedNodeId when the target node exists', () => {
    const nextState = addTerminalToWorkspace(createDefaultWorkspace(), {
      label: 'Build worker',
    });
    const nextWorkspace = setWorkspaceSelectedNode(
      nextState.workspace,
      nextState.terminal.id,
    );

    expect(nextWorkspace.selectedNodeId).toBe(nextState.terminal.id);
  });

  it('drops selectedNodeId when the target node does not exist', () => {
    const workspace = createDefaultWorkspace();
    const nextWorkspace = setWorkspaceSelectedNode(workspace, 'missing-node');

    expect(nextWorkspace.selectedNodeId).toBeNull();
  });

  it('applies and saves camera presets', () => {
    const workspace = createDefaultWorkspace();
    const presetApplied = applyWorkspaceCameraPreset(
      workspace,
      'writing-surface',
    );

    expect(presetApplied.currentViewport.zoom).toBe(1.15);

    const updatedViewport = setWorkspaceViewport(presetApplied, {
      x: 200,
      y: -20,
      zoom: 1.2,
    });
    const savedPreset = saveWorkspaceViewportToPreset(
      updatedViewport,
      'writing-surface',
    );

    expect(
      savedPreset.cameraPresets.find(
        (preset) => preset.id === 'writing-surface',
      )?.viewport,
    ).toEqual({
      x: 200,
      y: -20,
      zoom: 1.2,
    });
  });

  it('updates layout mode', () => {
    const workspace = createDefaultWorkspace();
    const nextWorkspace = setWorkspaceLayoutMode(workspace, 'focus-tiles');

    expect(nextWorkspace.layoutMode).toBe('focus-tiles');
  });
});
