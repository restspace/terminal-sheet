import { describe, expect, it } from 'vitest';

import {
  createDefaultWorkspace,
  createPlaceholderMarkdown,
  createPlaceholderTerminal,
  createWorkspaceMarkdownNode,
  getSemanticZoomMode,
  updateTerminalNode,
  workspaceSchema,
} from './workspace';

describe('workspace schema', () => {
  it('creates a valid default workspace', () => {
    const workspace = createDefaultWorkspace();

    expect(() => workspaceSchema.parse(workspace)).not.toThrow();
    expect(workspace.name).toBe('Terminal Canvas');
    expect(workspace.version).toBe(2);
    expect(workspace.layoutMode).toBe('free');
    expect(workspace.cameraPresets).toHaveLength(3);
    expect(workspace.currentViewport.zoom).toBeGreaterThan(0);
  });

  it('defaults layoutMode and ignores legacy selection fields', () => {
    const parsed = workspaceSchema.parse({
      ...createDefaultWorkspace(),
      // Simulate persisted workspaces from before layoutMode existed.
      layoutMode: undefined,
      selectedNodeId: 'terminal-legacy-selection',
    });

    expect(parsed.layoutMode).toBe('free');
    expect('selectedNodeId' in parsed).toBe(false);
  });

  it('creates valid placeholder nodes', () => {
    const terminal = createPlaceholderTerminal(0);
    const markdown = createPlaceholderMarkdown(0);

    expect(terminal.label).toBe('Shell 1');
    expect(markdown.label).toBe('Notes 1');
    expect(
      workspaceSchema.parse({
        ...createDefaultWorkspace(),
        terminals: [terminal],
        markdown: [markdown],
      }),
    ).toBeTruthy();
  });

  it('maps zoom levels to semantic modes', () => {
    expect(getSemanticZoomMode(0.5)).toBe('overview');
    expect(getSemanticZoomMode(0.8)).toBe('inspect');
    expect(getSemanticZoomMode(1.3)).toBe('focus');
  });

  it('updates terminal metadata without clearing required fields', () => {
    const terminal = createPlaceholderTerminal(0);
    const workspace = {
      ...createDefaultWorkspace(),
      terminals: [terminal],
    };

    const nextWorkspace = updateTerminalNode(workspace, terminal.id, {
      label: 'Build worker',
      cwd: 'C:/dev/terminal-sheet',
      repoLabel: 'terminal-sheet',
      taskLabel: 'implement milestone 4',
    });

    expect(nextWorkspace.terminals[0]?.label).toBe('Build worker');
    expect(nextWorkspace.terminals[0]?.cwd).toBe('C:/dev/terminal-sheet');
    expect(nextWorkspace.terminals[0]?.repoLabel).toBe('terminal-sheet');
    expect(nextWorkspace.terminals[0]?.taskLabel).toBe('implement milestone 4');
  });

  it('ignores blank label and cwd updates', () => {
    const terminal = createPlaceholderTerminal(0);
    const workspace = {
      ...createDefaultWorkspace(),
      terminals: [terminal],
    };

    const nextWorkspace = updateTerminalNode(workspace, terminal.id, {
      label: '   ',
      cwd: '',
    });

    expect(nextWorkspace.terminals[0]?.label).toBe(terminal.label);
    expect(nextWorkspace.terminals[0]?.cwd).toBe(terminal.cwd);
  });

  it('positions new markdown beside the node nearest the current viewport center', () => {
    const anchorTerminal = createPlaceholderTerminal(0, {
      x: -240,
      y: -120,
      zoom: 1.2,
    });
    const workspace = {
      ...createDefaultWorkspace(),
      currentViewport: {
        x: -140,
        y: -40,
        zoom: 1.2,
      },
      terminals: [
        {
          ...anchorTerminal,
          bounds: {
            x: 80,
            y: 120,
            width: 400,
            height: 280,
          },
        },
      ],
    };

    const markdown = createWorkspaceMarkdownNode(workspace, {
      label: 'Discovery',
      filePath: './DISCOVERY.md',
    });

    expect(markdown.bounds.x).toBeGreaterThanOrEqual(
      workspace.terminals[0]!.bounds.x + workspace.terminals[0]!.bounds.width,
    );
    expect(markdown.bounds.y).toBe(workspace.terminals[0]!.bounds.y);
  });
});
