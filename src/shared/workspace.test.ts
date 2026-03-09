import { describe, expect, it } from 'vitest';

import {
  createDefaultWorkspace,
  createPlaceholderMarkdown,
  createPlaceholderTerminal,
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
});
