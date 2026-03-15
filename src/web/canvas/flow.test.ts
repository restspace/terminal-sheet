import { describe, expect, it } from 'vitest';

import { createDefaultWorkspace, createPlaceholderMarkdown, createPlaceholderTerminal } from '../../shared/workspace';
import { getSelectedNodeIdFromChanges, buildCanvasEdges } from './flow';

describe('getSelectedNodeIdFromChanges', () => {
  it('returns the newly selected node when selection changes include a node selection', () => {
    expect(
      getSelectedNodeIdFromChanges([
        { id: 'terminal-1', type: 'select', selected: false },
        { id: 'terminal-2', type: 'select', selected: true },
      ]),
    ).toBe('terminal-2');
  });

  it('returns null when selection changes clear the current selection', () => {
    expect(
      getSelectedNodeIdFromChanges([
        { id: 'terminal-2', type: 'select', selected: false },
      ]),
    ).toBeNull();
  });

  it('ignores non-selection node changes', () => {
    expect(
      getSelectedNodeIdFromChanges([
        {
          id: 'terminal-2',
          type: 'position',
          position: { x: 120, y: 90 },
          dragging: true,
        },
      ]),
    ).toBeUndefined();
  });

  it('builds transient markdown edges from active runtime links', () => {
    const terminal = createPlaceholderTerminal(0);
    const markdown = createPlaceholderMarkdown(0);
    const workspace = {
      ...createDefaultWorkspace(),
      terminals: [terminal],
      markdown: [markdown],
    };

    const edges = buildCanvasEdges(workspace, [
      {
        markdownNodeId: markdown.id,
        terminalId: terminal.id,
        phase: 'active',
      },
    ]);

    expect(edges).toHaveLength(1);
    expect(edges[0]?.animated).toBe(true);
    expect(edges[0]?.source).toBe(markdown.id);
    expect(edges[0]?.target).toBe(terminal.id);
  });
});
