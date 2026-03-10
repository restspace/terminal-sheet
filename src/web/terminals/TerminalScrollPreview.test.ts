/** @vitest-environment jsdom */

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TerminalScrollPreview } from './TerminalScrollPreview';

const scrollHeights = new Map<HTMLElement, number>();
const clientHeights = new Map<HTMLElement, number>();
const scrollTops = new Map<HTMLElement, number>();
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe('TerminalScrollPreview', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(
      function mockScrollHeight(this: HTMLElement): number {
        return scrollHeights.get(this) ?? (this.tagName === 'PRE' ? 300 : 0);
      },
    );
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(
      function mockClientHeight(this: HTMLElement): number {
        return clientHeights.get(this) ?? (this.tagName === 'PRE' ? 100 : 0);
      },
    );
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(
      function mockScrollTop(this: HTMLElement): number {
        return scrollTops.get(this) ?? 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(
      function mockSetScrollTop(this: HTMLElement, value: number): void {
        scrollTops.set(this, value);
      },
    );
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    document.body.innerHTML = '';
    scrollHeights.clear();
    clientHeights.clear();
    scrollTops.clear();
    vi.restoreAllMocks();
  });

  it('pins the preview to the bottom on mount', () => {
    act(() => {
      root.render(
        createElement(TerminalScrollPreview, { scrollback: 'line 1\nline 2' }),
      );
    });

    const preview = getPreview(container);

    expect(preview.scrollTop).toBe(300);
    expect(preview.className).toContain('nodrag');
    expect(preview.className).toContain('nopan');
    expect(preview.className).toContain('nowheel');
  });

  it('preserves scroll position after the user scrolls up', () => {
    act(() => {
      root.render(
        createElement(TerminalScrollPreview, { scrollback: 'line 1\nline 2' }),
      );
    });

    const preview = getPreview(container);
    setScrollMetrics(preview, {
      scrollHeight: 300,
      clientHeight: 100,
      scrollTop: 40,
    });

    act(() => {
      preview.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    setScrollMetrics(preview, {
      scrollHeight: 420,
      clientHeight: 100,
      scrollTop: 40,
    });

    act(() => {
      root.render(
        createElement(TerminalScrollPreview, {
          scrollback: 'line 1\nline 2\nline 3\nline 4',
        }),
      );
    });

    expect(preview.scrollTop).toBe(40);
  });

  it('scrolls back to the bottom when the reset key changes', () => {
    act(() => {
      root.render(
        createElement(TerminalScrollPreview, {
          scrollback: 'line 1\nline 2',
          scrollResetKey: 'unfocused',
        }),
      );
    });

    const preview = getPreview(container);
    setScrollMetrics(preview, {
      scrollHeight: 300,
      clientHeight: 100,
      scrollTop: 40,
    });

    act(() => {
      preview.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    setScrollMetrics(preview, {
      scrollHeight: 420,
      clientHeight: 100,
      scrollTop: 40,
    });

    act(() => {
      root.render(
        createElement(TerminalScrollPreview, {
          scrollback: 'line 1\nline 2\nline 3\nline 4',
          scrollResetKey: 'focused',
        }),
      );
    });

    expect(preview.scrollTop).toBe(420);
  });
});

function getPreview(container: HTMLElement): HTMLPreElement {
  const preview = container.querySelector('pre');

  if (!(preview instanceof HTMLPreElement)) {
    throw new Error('Expected preview element to be rendered');
  }

  return preview;
}

function setScrollMetrics(
  element: HTMLElement,
  metrics: {
    scrollHeight: number;
    clientHeight: number;
    scrollTop: number;
  },
): void {
  scrollHeights.set(element, metrics.scrollHeight);
  clientHeights.set(element, metrics.clientHeight);
  scrollTops.set(element, metrics.scrollTop);
}
