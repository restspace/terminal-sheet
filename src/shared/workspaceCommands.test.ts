import { describe, expect, it } from 'vitest';

import {
  createDefaultWorkspace,
  createPlaceholderMarkdown,
  createPlaceholderTerminal,
  workspaceSchema,
} from './workspace';
import { applyWorkspaceCommands } from './workspaceCommands';

describe('workspace commands', () => {
  it('applies terminal, viewport, layout, and node mutations in sequence', () => {
    const terminal = createPlaceholderTerminal(0);
    const markdown = createPlaceholderMarkdown(0);
    const workspace = {
      ...createDefaultWorkspace(),
      terminals: [terminal],
      markdown: [markdown],
      filters: {
        attentionOnly: false,
        activeMarkdownId: markdown.id,
      },
    };

    const nextWorkspace = applyWorkspaceCommands(workspace, [
      {
        type: 'update-terminal',
        terminalId: terminal.id,
        patch: {
          label: 'Build worker',
          cwd: 'C:/dev/terminal-sheet',
        },
      },
      {
        type: 'set-node-bounds',
        nodeId: terminal.id,
        bounds: {
          x: 220,
          y: 180,
          width: 420,
          height: 300,
        },
      },
      {
        type: 'remove-node',
        nodeId: markdown.id,
      },
      {
        type: 'set-viewport',
        viewport: {
          x: 140,
          y: -60,
          zoom: 1.05,
        },
      },
      {
        type: 'save-viewport-to-preset',
        presetId: 'writing-surface',
      },
      {
        type: 'set-layout-mode',
        layoutMode: 'focus-tiles',
      },
      {
        type: 'add-terminal',
        input: {
          label: 'Review worker',
          shell: 'powershell.exe',
          cwd: 'C:/dev/terminal-sheet',
          agentType: 'codex',
        },
      },
    ]);

    expect(() => workspaceSchema.parse(nextWorkspace)).not.toThrow();
    expect(nextWorkspace.layoutMode).toBe('focus-tiles');
    expect(nextWorkspace.currentViewport).toEqual({
      x: 140,
      y: -60,
      zoom: 1.05,
    });
    expect(nextWorkspace.terminals).toHaveLength(2);
    expect(nextWorkspace.terminals[0]).toMatchObject({
      label: 'Build worker',
      cwd: 'C:/dev/terminal-sheet',
      bounds: {
        x: 220,
        y: 180,
        width: 420,
        height: 300,
      },
    });
    expect(nextWorkspace.terminals[1]).toMatchObject({
      label: 'Review worker',
      shell: 'powershell.exe',
      cwd: 'C:/dev/terminal-sheet',
      agentType: 'codex',
    });
    expect(nextWorkspace.markdown).toHaveLength(0);
    expect(nextWorkspace.filters.activeMarkdownId).toBeNull();
    expect(
      nextWorkspace.cameraPresets.find((preset) => preset.id === 'writing-surface')
        ?.viewport,
    ).toEqual({
      x: 140,
      y: -60,
      zoom: 1.05,
    });
  });
});
