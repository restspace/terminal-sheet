import { describe, expect, it } from 'vitest';

import {
  MAX_LIVE_READ_ONLY_TERMINAL_PREVIEWS,
  createDefaultWorkspace,
  createPlaceholderMarkdown,
  createPlaceholderTerminal,
  getReadOnlyPreviewTerminalIds,
  getSemanticZoomMode,
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
    expect(workspaceSchema.parse({
      ...createDefaultWorkspace(),
      terminals: [terminal],
      markdown: [markdown],
    })).toBeTruthy();
  });

  it('maps zoom levels to semantic modes', () => {
    expect(getSemanticZoomMode(0.5)).toBe('overview');
    expect(getSemanticZoomMode(0.8)).toBe('inspect');
    expect(getSemanticZoomMode(1.3)).toBe('focus');
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

  it('excludes the focused terminal from the focus-mode read-only preview budget', () => {
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

    expect(previewIds).toHaveLength(MAX_LIVE_READ_ONLY_TERMINAL_PREVIEWS);
    expect(previewIds).not.toContain(focusedTerminal?.id);
  });
});
