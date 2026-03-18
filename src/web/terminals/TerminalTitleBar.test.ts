/** @vitest-environment jsdom */

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlaceholderTerminal } from '../../shared/workspace';
import { TerminalTitleBar } from './TerminalTitleBar';

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe('TerminalTitleBar path bubble', () => {
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

  it('renders long cwd values without JS truncation and keeps full path in title', () => {
    const terminal = createPlaceholderTerminal(0);
    const longPath = '/workspace/services/terminal-sheet/src/web/components/finder/modal';

    act(() => {
      root.render(
        createElement(TerminalTitleBar, {
          terminal,
          status: 'idle',
          currentPath: longPath,
          onTerminalChange: vi.fn(),
        }),
      );
    });

    const pathBubble = container.querySelector(
      '.terminal-header-token-path',
    ) as HTMLElement | null;

    expect(pathBubble).not.toBeNull();
    expect(pathBubble?.getAttribute('title')).toBe(longPath);
    expect(pathBubble?.textContent).toBe(longPath);
  });

  it('assigns consistent colors for the same directory and different colors for different directories', () => {
    const terminalA = createPlaceholderTerminal(0);
    const terminalB = createPlaceholderTerminal(1);
    const terminalC = createPlaceholderTerminal(2);

    act(() => {
      root.render(
        createElement('div', null, [
          createElement(TerminalTitleBar, {
            key: 'a',
            terminal: terminalA,
            status: 'idle',
            currentPath: '/workspace/project-a',
            onTerminalChange: vi.fn(),
          }),
          createElement(TerminalTitleBar, {
            key: 'b',
            terminal: terminalB,
            status: 'idle',
            currentPath: '/workspace/project-a',
            onTerminalChange: vi.fn(),
          }),
          createElement(TerminalTitleBar, {
            key: 'c',
            terminal: terminalC,
            status: 'idle',
            currentPath: '/workspace/project-b',
            onTerminalChange: vi.fn(),
          }),
        ]),
      );
    });

    const bubbles = container.querySelectorAll('.terminal-header-token-path');

    expect(bubbles.length).toBe(3);
    expect(bubbles[0]?.getAttribute('style')).toBe(
      bubbles[1]?.getAttribute('style'),
    );
    expect(bubbles[0]?.getAttribute('style')).not.toBe(
      bubbles[2]?.getAttribute('style'),
    );
  });

  it('renders a circular close icon button with Close title text', () => {
    const terminal = createPlaceholderTerminal(0);

    act(() => {
      root.render(
        createElement(TerminalTitleBar, {
          terminal,
          status: 'idle',
          onClose: vi.fn(),
        }),
      );
    });

    const closeButton = container.querySelector(
      '.terminal-header-close-button',
    ) as HTMLButtonElement | null;

    expect(closeButton).not.toBeNull();
    expect(closeButton?.getAttribute('title')).toBe('Close');
    expect(closeButton?.textContent?.trim()).toBe('X');
  });
});
