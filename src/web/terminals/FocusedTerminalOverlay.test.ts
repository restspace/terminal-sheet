/** @vitest-environment jsdom */

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./TerminalFocusSurface', () => ({
  TerminalFocusSurface: () => createElement('div'),
}));

import { createPlaceholderTerminal, type CameraViewport } from '../../shared/workspace';
import { FocusedTerminalOverlay } from './FocusedTerminalOverlay';

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const viewport: CameraViewport = {
  x: 0,
  y: 0,
  zoom: 1,
};

describe('FocusedTerminalOverlay', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('shows the machine badge when a backend accent is available', () => {
    const terminal = createPlaceholderTerminal(0);

    act(() => {
      root.render(
        createElement(FocusedTerminalOverlay, {
          terminal,
          backendAccent: {
            label: 'Remote Linux',
            color: 'rgb(12, 82, 124)',
          },
          session: null,
          viewport,
          autoFocusAtMs: null,
          onInput: vi.fn(),
          onResize: vi.fn(),
          onBoundsChange: vi.fn(),
          onTerminalChange: vi.fn(),
          onPathSelectRequest: vi.fn(),
          onRemove: vi.fn(),
          onRestart: vi.fn(),
        }),
      );
    });

    const badge = container.querySelector('.terminal-machine-badge') as
      | HTMLElement
      | null;

    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('Remote Linux');
    expect(badge?.getAttribute('title')).toBe('Remote Linux');
    expect(badge?.getAttribute('style')).toContain('rgb(12, 82, 124)');
  });
});
