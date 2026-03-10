/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@xterm/xterm', () => ({
  Terminal: class MockTerminal {},
}));

import { measureCellSize } from './terminalSizing';

describe('measureCellSize', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('derives terminal row height from rendered glyph bounds', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function mockBoundingClientRect(this: HTMLElement): DOMRect {
        if (this.tagName === 'SPAN') {
          return createDomRect(96, 12);
        }

        return createDomRect(0, 0);
      },
    );
    const computedStyleSpy = vi.spyOn(window, 'getComputedStyle');

    const cellSize = measureCellSize(container);

    expect(cellSize.height).toBeCloseTo(13.2);
    expect(computedStyleSpy).not.toHaveBeenCalled();
  });
});

function createDomRect(width: number, height: number): DOMRect {
  return {
    width,
    height,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    x: 0,
    y: 0,
    toJSON() {
      return {};
    },
  } as DOMRect;
}
