import { describe, expect, it } from 'vitest';

import { getSelectedNodeIdFromChanges } from './flow';

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
});
