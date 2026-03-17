/** @vitest-environment jsdom */

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockTerminalState = vi.hoisted(() => ({
  instances: [] as unknown[],
  MockTerminal: class HoistedMockTerminal {
    readonly options: Record<string, unknown>;

    readonly loadAddonCalls: string[] = [];

    readonly writeCalls: string[] = [];

    readonly resizeCalls: Array<{ cols: number; rows: number }> = [];

    readonly refreshCalls: Array<{ start: number; end: number }> = [];

    readonly buffer = {
      active: {
        baseY: 0,
        viewportY: 0,
      },
    };

    readonly element = document.createElement('div');

    readonly textarea = document.createElement('textarea');

    rows = 0;

    scrollToBottomCalls = 0;

    onDataHandlerCount = 0;

    disposed = false;

    private readonly scrollHandlers = new Set<() => void>();

    constructor(options: Record<string, unknown> = {}) {
      this.options = options;
    }

    open(container: HTMLElement): void {
      this.element.appendChild(this.textarea);
      container.appendChild(this.element);
    }

    onData(handler: (data: string) => void): { dispose: () => void } {
      void handler;
      this.onDataHandlerCount += 1;

      return {
        dispose: () => {
          this.onDataHandlerCount = Math.max(0, this.onDataHandlerCount - 1);
        },
      };
    }

    onScroll(handler: () => void): { dispose: () => void } {
      this.scrollHandlers.add(handler);

      return {
        dispose: () => {
          this.scrollHandlers.delete(handler);
        },
      };
    }

    write(data: string, callback?: () => void): void {
      this.writeCalls.push(data);
      this.buffer.active.baseY += Math.max(1, data.split('\n').length - 1);
      callback?.();
    }

    resize(cols: number, rows: number): void {
      this.resizeCalls.push({ cols, rows });
      this.rows = rows;
    }

    reset(): void {
      this.buffer.active.baseY = 0;
      this.buffer.active.viewportY = 0;
    }

    scrollToBottom(): void {
      this.scrollToBottomCalls += 1;
      this.buffer.active.viewportY = this.buffer.active.baseY;
    }

    refresh(start: number, end: number): void {
      this.refreshCalls.push({ start, end });
    }

    dispose(): void {}

    focus(): void {}

    loadAddon(addon: {
      activate: (terminal: unknown) => void;
      dispose: () => void;
      constructor: { name?: string };
    }): void {
      this.loadAddonCalls.push(addon.constructor.name ?? 'unknown');
      addon.activate(this);
    }

    emitScroll(): void {
      for (const handler of this.scrollHandlers) {
        handler();
      }
    }
  },
}));

const mockAddonState = vi.hoisted(() => ({
  webglActivateShouldThrow: false,
  canvasActivateShouldThrow: false,
  webglInstances: [] as Array<{
    disposed: boolean;
    preserveDrawingBuffer: boolean | undefined;
    emitContextLoss: () => void;
  }>,
  canvasInstances: [] as Array<{
    disposed: boolean;
  }>,
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class MockXtermTerminal extends mockTerminalState.MockTerminal {
    constructor(options?: Record<string, unknown>) {
      super(options);
      mockTerminalState.instances.push(this);
    }
  },
}));

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class MockWebglAddon {
    readonly preserveDrawingBuffer: boolean | undefined;

    disposed = false;

    private readonly instanceRecord: {
      disposed: boolean;
      preserveDrawingBuffer: boolean | undefined;
      emitContextLoss: () => void;
    };

    private readonly contextLossHandlers = new Set<() => void>();

    constructor(preserveDrawingBuffer?: boolean) {
      this.preserveDrawingBuffer = preserveDrawingBuffer;
      this.instanceRecord = {
        disposed: false,
        preserveDrawingBuffer,
        emitContextLoss: () => {
          this.emitContextLoss();
        },
      };
      mockAddonState.webglInstances.push(this.instanceRecord);
    }

    readonly onContextLoss = (handler: () => void) => {
      this.contextLossHandlers.add(handler);

      return {
        dispose: () => {
          this.contextLossHandlers.delete(handler);
        },
      };
    };

    activate(): void {
      if (mockAddonState.webglActivateShouldThrow) {
        throw new Error('webgl init failed');
      }
    }

    dispose(): void {
      this.disposed = true;
      this.instanceRecord.disposed = true;
    }

    emitContextLoss(): void {
      for (const handler of this.contextLossHandlers) {
        handler();
      }
    }
  },
}));

vi.mock('@xterm/addon-canvas', () => ({
  CanvasAddon: class MockCanvasAddon {
    disposed = false;

    private readonly instanceRecord: {
      disposed: boolean;
    };

    constructor() {
      this.instanceRecord = {
        disposed: false,
      };
      mockAddonState.canvasInstances.push(this.instanceRecord);
    }

    activate(): void {
      if (mockAddonState.canvasActivateShouldThrow) {
        throw new Error('canvas init failed');
      }
    }

    dispose(): void {
      this.disposed = true;
      this.instanceRecord.disposed = true;
    }
  },
}));

import {
  TerminalFocusSurface,
  ReadOnlyTerminalSurface,
} from './TerminalFocusSurface';
import { getIncrementalWrite } from './incrementalWrite';
import { measureCellSize } from './terminalSizing';

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

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

describe('getIncrementalWrite', () => {
  it('returns the appended tail for normal incremental output', () => {
    expect(getIncrementalWrite('hello', 'hello world')).toBe(' world');
  });

  it('returns the appended tail when scrollback slides forward at the cap', () => {
    const previous = `${'a'.repeat(2_000)}${'b'.repeat(2_000)}${'c'.repeat(2_000)}`;
    const next = `${previous.slice(1_750)}tail`;

    expect(getIncrementalWrite(previous, next)).toBe('tail');
  });

  it('returns the appended tail when the overlap starts in the middle of the old buffer', () => {
    const previous =
      'header:' +
      'x'.repeat(1_800) +
      'body:' +
      'y'.repeat(1_800) +
      'footer:' +
      'z'.repeat(1_800);
    const next = `${previous.slice(1_237)}delta`;

    expect(getIncrementalWrite(previous, next)).toBe('delta');
  });

  it('forces a reset when the replacement buffer is unrelated', () => {
    expect(getIncrementalWrite('hello world', 'goodbye world')).toBeNull();
  });
});

describe('ReadOnlyTerminalSurface', () => {
  let container: HTMLDivElement;
  let root: Root;
  let animationFrameId = 0;

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    mockTerminalState.instances.length = 0;
    mockAddonState.webglActivateShouldThrow = false;
    mockAddonState.canvasActivateShouldThrow = false;
    mockAddonState.webglInstances.length = 0;
    mockAddonState.canvasInstances.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    vi.stubGlobal(
      'ResizeObserver',
      class MockResizeObserver {
        constructor(callback: () => void) {
          void callback;
        }

        observe(): void {}

        disconnect(): void {}
      },
    );
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback): number => {
        animationFrameId += 1;
        callback(animationFrameId);
        return animationFrameId;
      },
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        ready: Promise.resolve(),
      },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('replays read-only scrollback on mount and appends incremental updates', () => {
    act(() => {
      root.render(
        createElement(ReadOnlyTerminalSurface, {
          sessionId: 'terminal-1',
          scrollback: 'hello',
          className: 'terminal-preview-surface',
        }),
      );
    });

    const terminal = getSingleMockTerminal();
    expect(terminal.writeCalls).toEqual(['hello']);
    expect(terminal.onDataHandlerCount).toBe(0);
    expect(terminal.scrollToBottomCalls).toBeGreaterThan(0);
    expect(terminal.options.fontSize).toBe(10.5);
    expect(terminal.options.scrollback).toBe(20_000);
    expect(terminal.options.disableStdin).toBe(true);
    expect(terminal.options.theme).toMatchObject({
      foreground: '#d7e4ee',
      red: '#ff7b72',
      brightBlue: '#9dc7f5',
      cursor: 'transparent',
    });
    expect(terminal.loadAddonCalls).toEqual(['MockWebglAddon']);

    act(() => {
      root.render(
        createElement(ReadOnlyTerminalSurface, {
          sessionId: 'terminal-1',
          scrollback: 'hello world',
          className: 'terminal-preview-surface',
        }),
      );
    });

    expect(terminal.writeCalls).toEqual(['hello', ' world']);
  });

  it('replays the full scrollback after a read-only remount', () => {
    act(() => {
      root.render(
        createElement(ReadOnlyTerminalSurface, {
          sessionId: 'terminal-2',
          scrollback: 'line 1\nline 2',
        }),
      );
    });

    const firstTerminal = getSingleMockTerminal();
    expect(firstTerminal.writeCalls).toEqual(['line 1\nline 2']);

    act(() => {
      root.unmount();
    });

    root = createRoot(container);

    act(() => {
      root.render(
        createElement(ReadOnlyTerminalSurface, {
          sessionId: 'terminal-2',
          scrollback: 'line 1\nline 2',
        }),
      );
    });

    const secondTerminal = mockTerminalState.instances[1] as InstanceType<
      typeof mockTerminalState.MockTerminal
    > | undefined;

    expect(secondTerminal).toBeDefined();
    expect(secondTerminal?.writeCalls).toEqual(['line 1\nline 2']);
  });

  it('keeps the user scroll position until the reset key changes', () => {
    act(() => {
      root.render(
        createElement(ReadOnlyTerminalSurface, {
          sessionId: 'terminal-3',
          scrollback: 'first',
          scrollResetKey: 'inspect',
        }),
      );
    });

    const terminal = getSingleMockTerminal();
    const initialScrollCalls = terminal.scrollToBottomCalls;

    terminal.buffer.active.baseY = 12;
    terminal.buffer.active.viewportY = 5;
    terminal.emitScroll();

    act(() => {
      root.render(
        createElement(ReadOnlyTerminalSurface, {
          sessionId: 'terminal-3',
          scrollback: 'first second',
          scrollResetKey: 'inspect',
        }),
      );
    });

    expect(terminal.scrollToBottomCalls).toBe(initialScrollCalls);

    act(() => {
      root.render(
        createElement(ReadOnlyTerminalSurface, {
          sessionId: 'terminal-3',
          scrollback: 'first second third',
          scrollResetKey: 'focus',
        }),
      );
    });

    expect(terminal.scrollToBottomCalls).toBeGreaterThan(initialScrollCalls);
  });

  it('falls back to the canvas renderer when webgl initialization fails', () => {
    mockAddonState.webglActivateShouldThrow = true;

    act(() => {
      root.render(
        createElement(ReadOnlyTerminalSurface, {
          sessionId: 'terminal-4',
          scrollback: 'hello',
        }),
      );
    });

    const terminal = getSingleMockTerminal();

    expect(terminal.loadAddonCalls).toEqual(['MockWebglAddon', 'MockCanvasAddon']);
    expect(mockAddonState.webglInstances).toHaveLength(1);
    expect(mockAddonState.canvasInstances).toHaveLength(1);
  });
});

describe('TerminalFocusSurface', () => {
  let container: HTMLDivElement;
  let root: Root;
  let animationFrameId = 0;

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    mockTerminalState.instances.length = 0;
    mockAddonState.webglActivateShouldThrow = false;
    mockAddonState.canvasActivateShouldThrow = false;
    mockAddonState.webglInstances.length = 0;
    mockAddonState.canvasInstances.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    vi.stubGlobal(
      'ResizeObserver',
      class MockResizeObserver {
        constructor(callback: () => void) {
          void callback;
        }

        observe(): void {}

        disconnect(): void {}
      },
    );
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback): number => {
        animationFrameId += 1;
        callback(animationFrameId);
        return animationFrameId;
      },
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        ready: Promise.resolve(),
      },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('scales the focused xterm font with the viewport zoom', () => {
    act(() => {
      root.render(
        createElement(TerminalFocusSurface, {
          sessionId: 'terminal-focus',
          scrollback: '',
          visualScale: 1.35,
          onInput: vi.fn(),
          onResize: vi.fn(),
        }),
      );
    });

    const terminal = getSingleMockTerminal();

    expect(terminal.options.fontSize).toBeCloseTo(14.175);
    expect(terminal.options.disableStdin).toBe(false);
    expect(terminal.options.theme).toMatchObject({
      cursor: '#8ab4d8',
    });
    expect(terminal.loadAddonCalls).toEqual(['MockWebglAddon']);
    expect(mockAddonState.webglInstances[0]?.preserveDrawingBuffer).toBe(true);
  });

  it('falls back to the canvas renderer after a webgl context loss', () => {
    act(() => {
      root.render(
        createElement(TerminalFocusSurface, {
          sessionId: 'terminal-focus',
          scrollback: '',
          onInput: vi.fn(),
          onResize: vi.fn(),
        }),
      );
    });

    const terminal = getSingleMockTerminal();

    expect(terminal.loadAddonCalls).toEqual(['MockWebglAddon']);

    act(() => {
      mockAddonState.webglInstances[0]?.emitContextLoss();
    });

    expect(terminal.loadAddonCalls).toEqual(['MockWebglAddon', 'MockCanvasAddon']);
    expect(mockAddonState.webglInstances[0]?.disposed).toBe(false);
    expect(mockAddonState.canvasInstances).toHaveLength(1);
  });
});

function getSingleMockTerminal(): InstanceType<typeof mockTerminalState.MockTerminal> {
  expect(mockTerminalState.instances).toHaveLength(1);
  return mockTerminalState.instances[0] as InstanceType<
    typeof mockTerminalState.MockTerminal
  >;
}

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
