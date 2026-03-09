import { describe, expect, it } from 'vitest';

import { createDefaultWorkspace } from '../../shared/workspace';
import {
  addMarkdownToWorkspace,
  addTerminalToWorkspace,
  applyWorkspaceCameraPreset,
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
