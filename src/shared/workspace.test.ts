import { describe, expect, it } from 'vitest';

import {
  MAX_LIVE_TERMINAL_SURFACES,
  MAX_LIVE_READ_ONLY_TERMINAL_PREVIEWS,
  createDefaultWorkspace,
  createPlaceholderMarkdown,
  createPlaceholderTerminal,
  getReadOnlyPreviewTerminalIds,
  getSemanticZoomMode,
  updateTerminalNode,
  workspaceSchema,
} from './workspace';

describe('workspace schema', () => {
  it('creates a valid default workspace', () => {
    const workspace = createDefaultWorkspace();

    expect(() => workspaceSchema.parse(workspace)).not.toThrow();
    expect(workspace.name).toBe('Terminal Canvas');
    expect(workspace.version).toBe(1);
    expect(workspace.cameraPresets).toHaveLength(4);
    expect(workspace.currentViewport.zoom).toBeGreaterThan(0);
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

  it('limits inspect mode live previews to the selected terminal plus nearest neighbors', () => {
    const terminals = Array.from({ length: 10 }, (_, index) =>
      createPlaceholderTerminal(index),
    );
    const selectedTerminal = terminals[5];

    expect(selectedTerminal).toBeTruthy();

    const previewIds = getReadOnlyPreviewTerminalIds(
      terminals,
      selectedTerminal?.id ?? null,
      'inspect',
    );

    expect(previewIds).toHaveLength(MAX_LIVE_READ_ONLY_TERMINAL_PREVIEWS);
    expect(previewIds[0]).toBe(selectedTerminal?.id);
  });

  it('caps focus mode to eight total live terminal surfaces', () => {
    const terminals = Array.from({ length: 9 }, (_, index) =>
      createPlaceholderTerminal(index),
    );
    const focusedTerminal = terminals[0];

    expect(focusedTerminal).toBeTruthy();

    const previewIds = getReadOnlyPreviewTerminalIds(
      terminals,
      focusedTerminal?.id ?? null,
      'focus',
    );

    expect(previewIds).toHaveLength(MAX_LIVE_TERMINAL_SURFACES - 1);
    expect(previewIds).not.toContain(focusedTerminal?.id);
  });
});
