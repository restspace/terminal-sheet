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

    textareaFocusCalls = 0;

    selectionText = '';

    clearSelectionCalls = 0;

    blurOnNextWrite = false;

    blurOnNextResize = false;

    autoFlushWriteCallbacks = true;

    rows = 0;

    scrollToBottomCalls = 0;

    onDataHandlerCount = 0;

    disposed = false;

    private readonly pendingWriteCallbacks: Array<() => void> = [];

    private readonly scrollHandlers = new Set<() => void>();

    private readonly dataHandlers = new Set<(data: string) => void>();

    constructor(options: Record<string, unknown> = {}) {
      this.options = options;
      const originalFocus = this.textarea.focus.bind(this.textarea);
      this.textarea.focus = ((options?: FocusOptions) => {
        this.textareaFocusCalls += 1;
        originalFocus(options);
      }) as typeof this.textarea.focus;
    }

    open(container: HTMLElement): void {
      this.element.appendChild(this.textarea);
      container.appendChild(this.element);
    }

    onData(handler: (data: string) => void): { dispose: () => void } {
      this.onDataHandlerCount += 1;
      this.dataHandlers.add(handler);

      return {
        dispose: () => {
          this.dataHandlers.delete(handler);
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

      if (this.blurOnNextWrite) {
        this.blurOnNextWrite = false;
        this.textarea.blur();
      }

      if (!callback) {
        return;
      }

      if (this.autoFlushWriteCallbacks) {
        callback();
        return;
      }

      this.pendingWriteCallbacks.push(callback);
    }

    resize(cols: number, rows: number): void {
      this.resizeCalls.push({ cols, rows });
      this.rows = rows;

      if (this.blurOnNextResize) {
        this.blurOnNextResize = false;
        this.textarea.blur();
      }
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

    hasSelection(): boolean {
      return this.selectionText.length > 0;
    }

    getSelection(): string {
      return this.selectionText;
    }

    clearSelection(): void {
      this.clearSelectionCalls += 1;
      this.selectionText = '';
    }

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

    emitData(data: string): void {
      for (const handler of this.dataHandlers) {
        handler(data);
      }
    }

    flushWriteCallbacks(): void {
      while (this.pendingWriteCallbacks.length > 0) {
        const callback = this.pendingWriteCallbacks.shift();
        callback?.();
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
  TerminalSurface,
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

    expect(cellSize.height).toBeCloseTo(12);
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
    expect(terminal.writeCalls).toEqual(['', 'hello']);
    expect(terminal.onDataHandlerCount).toBe(1);
    expect(terminal.scrollToBottomCalls).toBeGreaterThan(0);
    expect(terminal.options.fontSize).toBe(10.5);
    expect(terminal.options.scrollback).toBe(2_500);
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

    expect(terminal.writeCalls).toEqual(['', 'hello', ' world']);
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
    expect(firstTerminal.writeCalls).toEqual(['', 'line 1\nline 2']);

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
    expect(secondTerminal?.writeCalls).toEqual(['', 'line 1\nline 2']);
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

  it('uses the same webgl-first renderer path for read-only surfaces', () => {
    act(() => {
      root.render(
        createElement(ReadOnlyTerminalSurface, {
          sessionId: 'terminal-4',
          scrollback: 'hello',
        }),
      );
    });

    const terminal = getSingleMockTerminal();

    expect(terminal.loadAddonCalls).toEqual(['MockWebglAddon']);
    expect(mockAddonState.webglInstances).toHaveLength(1);
    expect(mockAddonState.canvasInstances).toHaveLength(0);
  });

  it('updates interactivity in place when the surface mode changes', () => {
    const onInput = vi.fn();
    const onResize = vi.fn();

    act(() => {
      root.render(
        createElement(TerminalSurface, {
          sessionId: 'terminal-shared',
          scrollback: '',
          interactionMode: 'read-only',
          sizeSource: 'snapshot',
          resizeAuthority: 'none',
          onInput,
          onResize,
        }),
      );
    });

    const terminal = getSingleMockTerminal();
    expect(terminal.options.disableStdin).toBe(true);
    expect(terminal.options.theme).toMatchObject({
      cursor: 'transparent',
    });
    expect(terminal.textarea.getAttribute('aria-hidden')).toBe('true');
    expect(terminal.textarea.tabIndex).toBe(-1);

    act(() => {
      root.render(
        createElement(TerminalSurface, {
          sessionId: 'terminal-shared',
          scrollback: '',
          interactionMode: 'interactive',
          sizeSource: 'measured',
          resizeAuthority: 'owner',
          onInput,
          onResize,
        }),
      );
    });

    expect(mockTerminalState.instances).toHaveLength(1);
    expect(terminal.options.disableStdin).toBe(false);
    expect(terminal.options.theme).toMatchObject({
      cursor: '#8ab4d8',
    });
    expect(terminal.textarea.getAttribute('aria-hidden')).toBeNull();
    expect(terminal.textarea.tabIndex).toBe(0);

    act(() => {
      root.render(
        createElement(TerminalSurface, {
          sessionId: 'terminal-shared',
          scrollback: '',
          interactionMode: 'read-only',
          sizeSource: 'snapshot',
          resizeAuthority: 'none',
          onInput,
          onResize,
        }),
      );
    });

    expect(mockTerminalState.instances).toHaveLength(1);
    expect(terminal.options.disableStdin).toBe(true);
    expect(terminal.textarea.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('TerminalFocusSurface', () => {
  let container: HTMLDivElement;
  let root: Root;
  let animationFrameId = 0;
  let resizeObserverCallbacks: Array<() => void>;

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    mockTerminalState.instances.length = 0;
    mockAddonState.webglActivateShouldThrow = false;
    mockAddonState.canvasActivateShouldThrow = false;
    mockAddonState.webglInstances.length = 0;
    mockAddonState.canvasInstances.length = 0;
    resizeObserverCallbacks = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    vi.stubGlobal(
      'ResizeObserver',
      class MockResizeObserver {
        private readonly callback: () => void;

        constructor(callback: () => void) {
          this.callback = callback;
          resizeObserverCallbacks.push(this.callback);
        }

        observe(): void {}

        disconnect(): void {
          const callbackIndex = resizeObserverCallbacks.indexOf(this.callback);

          if (callbackIndex >= 0) {
            resizeObserverCallbacks.splice(callbackIndex, 1);
          }
        }
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
    expect(mockAddonState.webglInstances[0]?.preserveDrawingBuffer).toBe(false);
  });

  it('updates the focused font size without remounting the terminal', () => {
    act(() => {
      root.render(
        createElement(TerminalFocusSurface, {
          sessionId: 'terminal-focus',
          scrollback: '',
          visualScale: 1,
          onInput: vi.fn(),
          onResize: vi.fn(),
        }),
      );
    });

    const terminal = getSingleMockTerminal();

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

    expect(mockTerminalState.instances).toHaveLength(1);
    expect(terminal.options.fontSize).toBe(14.18);
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

  it('restores focus after an interactive write blurs the xterm textarea', () => {
    act(() => {
      root.render(
        createElement(TerminalFocusSurface, {
          sessionId: 'terminal-focus',
          scrollback: 'line 1',
          onInput: vi.fn(),
          onResize: vi.fn(),
        }),
      );
    });

    const terminal = getSingleMockTerminal();
    const initialFocusCalls = terminal.textareaFocusCalls;

    act(() => {
      terminal.textarea.focus();
    });

    terminal.blurOnNextWrite = true;

    act(() => {
      root.render(
        createElement(TerminalFocusSurface, {
          sessionId: 'terminal-focus',
          scrollback: 'line 1\nline 2',
          onInput: vi.fn(),
          onResize: vi.fn(),
        }),
      );
    });

    expect(document.activeElement).toBe(terminal.textarea);
    expect(terminal.textareaFocusCalls).toBeGreaterThan(initialFocusCalls + 1);
  });

  it('keeps forwarding typing while output writes are still queued', () => {
    const onInput = vi.fn();
    const onResize = vi.fn();

    act(() => {
      root.render(
        createElement(TerminalFocusSurface, {
          sessionId: 'terminal-focus',
          scrollback: 'prompt',
          onInput,
          onResize,
        }),
      );
    });

    const terminal = getSingleMockTerminal();
    terminal.autoFlushWriteCallbacks = false;

    act(() => {
      root.render(
        createElement(TerminalFocusSurface, {
          sessionId: 'terminal-focus',
          scrollback: 'prompt\nstreaming output',
          onInput,
          onResize,
        }),
      );
    });

    expect(mockTerminalState.instances).toHaveLength(1);

    act(() => {
      terminal.emitData('x');
    });

    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onInput).toHaveBeenLastCalledWith('terminal-focus', 'x');
    expect(terminal.options.disableStdin).toBe(false);

    act(() => {
      terminal.flushWriteCallbacks();
    });

    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it('shows copy/cut actions for right-clicked text selections', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    act(() => {
      root.render(
        createElement(TerminalFocusSurface, {
          sessionId: 'terminal-focus',
          scrollback: 'selected output',
          onInput: vi.fn(),
          onResize: vi.fn(),
        }),
      );
    });

    const terminal = getSingleMockTerminal();
    terminal.selectionText = 'echo hello';
    const surface = getTerminalSurfaceElement(container);
    const contextMenuEvent = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 24,
      clientY: 18,
    });

    act(() => {
      surface.dispatchEvent(contextMenuEvent);
    });

    expect(contextMenuEvent.defaultPrevented).toBe(true);
    expect(
      container.querySelector('.terminal-selection-context-menu'),
    ).toBeInstanceOf(HTMLElement);

    const copyButton = container.querySelector(
      '.terminal-selection-context-menu-item',
    );
    expect(copyButton).toBeInstanceOf(HTMLButtonElement);

    if (!(copyButton instanceof HTMLButtonElement)) {
      throw new Error('expected copy button');
    }

    await act(async () => {
      copyButton.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith('echo hello');
    expect(
      container.querySelector('.terminal-selection-context-menu'),
    ).toBeNull();

    terminal.selectionText = 'echo cut';

    act(() => {
      surface.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 28,
          clientY: 21,
        }),
      );
    });

    const cutButton = container.querySelectorAll(
      '.terminal-selection-context-menu-item',
    )[1];
    expect(cutButton).toBeInstanceOf(HTMLButtonElement);

    if (!(cutButton instanceof HTMLButtonElement)) {
      throw new Error('expected cut button');
    }

    await act(async () => {
      cutButton.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith('echo cut');
    expect(terminal.clearSelectionCalls).toBe(1);
  });

  it('uses xterm screen dimensions for cols/rows when available', () => {
    const onResize = vi.fn().mockReturnValue(true);

    act(() => {
      root.render(
        createElement(TerminalFocusSurface, {
          sessionId: 'terminal-canvas-measure',
          scrollback: '',
          onInput: vi.fn(),
          onResize,
        }),
      );
    });

    const terminal = getSingleMockTerminal() as InstanceType<
      typeof mockTerminalState.MockTerminal
    > & {
      _core?: {
        _renderService?: {
          dimensions?: {
            css?: {
              cell?: {
                width?: number;
                height?: number;
              };
            };
          };
        };
      };
    };
    const surface = getTerminalSurfaceElement(container);

    Object.defineProperty(surface, 'clientWidth', {
      configurable: true,
      get: () => 800,
    });
    Object.defineProperty(surface, 'clientHeight', {
      configurable: true,
      get: () => 400,
    });
    const screenElement = document.createElement('div');
    screenElement.className = 'xterm-screen';
    Object.defineProperty(screenElement, 'clientWidth', {
      configurable: true,
      get: () => 750,
    });
    Object.defineProperty(screenElement, 'clientHeight', {
      configurable: true,
      get: () => 400,
    });
    terminal.element.appendChild(screenElement);
    terminal._core = {
      _renderService: {
        dimensions: {
          css: {
            cell: {
              width: 10,
              height: 20,
            },
          },
        },
      },
    };

    terminal.resizeCalls.length = 0;
    onResize.mockClear();
    emitResizeObservers(resizeObserverCallbacks);

    expect(terminal.resizeCalls.at(-1)).toEqual({ cols: 75, rows: 20 });
    expect(onResize).toHaveBeenLastCalledWith('terminal-canvas-measure', 75, 20);
  });

  it('skips measured resize and backend sync when the surface cannot fit one cell', () => {
    const onResize = vi.fn().mockReturnValue(true);

    act(() => {
      root.render(
        createElement(TerminalFocusSurface, {
          sessionId: 'terminal-degenerate',
          scrollback: '',
          onInput: vi.fn(),
          onResize,
        }),
      );
    });

    const terminal = getSingleMockTerminal() as InstanceType<
      typeof mockTerminalState.MockTerminal
    > & {
      _core?: {
        _renderService?: {
          dimensions?: {
            css?: {
              cell?: {
                width?: number;
                height?: number;
              };
              canvas?: {
                width?: number;
                height?: number;
              };
            };
          };
        };
      };
    };
    const surface = getTerminalSurfaceElement(container);

    Object.defineProperty(surface, 'clientWidth', {
      configurable: true,
      get: () => 800,
    });
    Object.defineProperty(surface, 'clientHeight', {
      configurable: true,
      get: () => 400,
    });
    terminal._core = {
      _renderService: {
        dimensions: {
          css: {
            cell: {
              width: 10,
              height: 20,
            },
          },
        },
      },
    };

    emitResizeObservers(resizeObserverCallbacks);
    const lastResizeBefore = terminal.resizeCalls.at(-1);
    expect(lastResizeBefore).toBeDefined();

    Object.defineProperty(surface, 'clientWidth', {
      configurable: true,
      get: () => 0,
    });
    terminal.resizeCalls.length = 0;
    onResize.mockClear();
    emitResizeObservers(resizeObserverCallbacks);

    expect(terminal.resizeCalls).toEqual([]);
    expect(onResize).not.toHaveBeenCalled();
  });

  it('retries rejected backend resizes with bounded backoff until sync succeeds', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const onResize = vi.fn().mockReturnValue(true);

    act(() => {
      root.render(
        createElement(TerminalFocusSurface, {
          sessionId: 'terminal-backoff',
          scrollback: '',
          onInput: vi.fn(),
          onResize,
        }),
      );
    });

    const terminal = getSingleMockTerminal() as InstanceType<
      typeof mockTerminalState.MockTerminal
    > & {
      _core?: {
        _renderService?: {
          dimensions?: {
            css?: {
              cell?: {
                width?: number;
                height?: number;
              };
            };
          };
        };
      };
    };
    const surface = getTerminalSurfaceElement(container);

    let surfaceWidth = 800;
    const surfaceHeight = 400;
    Object.defineProperty(surface, 'clientWidth', {
      configurable: true,
      get: () => surfaceWidth,
    });
    Object.defineProperty(surface, 'clientHeight', {
      configurable: true,
      get: () => surfaceHeight,
    });
    terminal._core = {
      _renderService: {
        dimensions: {
          css: {
            cell: {
              width: 10,
              height: 20,
            },
          },
        },
      },
    };

    onResize.mockClear();
    emitResizeObservers(resizeObserverCallbacks);
    onResize.mockClear();

    onResize
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);

    surfaceWidth = 790;
    emitResizeObservers(resizeObserverCallbacks);

    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenLastCalledWith('terminal-backoff', 79, 20);

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(onResize).toHaveBeenCalledTimes(2);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onResize).toHaveBeenCalledTimes(3);

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(onResize).toHaveBeenCalledTimes(4);
    expect(onResize).toHaveBeenLastCalledWith('terminal-backoff', 79, 20);

    vi.useRealTimers();
  });

  it('keeps retrying rejected backend resizes at the capped delay until sync succeeds', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const onResize = vi.fn().mockReturnValue(true);

    act(() => {
      root.render(
        createElement(TerminalFocusSurface, {
          sessionId: 'terminal-retry-cap',
          scrollback: '',
          onInput: vi.fn(),
          onResize,
        }),
      );
    });

    const terminal = getSingleMockTerminal() as InstanceType<
      typeof mockTerminalState.MockTerminal
    > & {
      _core?: {
        _renderService?: {
          dimensions?: {
            css?: {
              cell?: {
                width?: number;
                height?: number;
              };
            };
          };
        };
      };
    };
    const surface = getTerminalSurfaceElement(container);

    let surfaceWidth = 800;
    Object.defineProperty(surface, 'clientWidth', {
      configurable: true,
      get: () => surfaceWidth,
    });
    Object.defineProperty(surface, 'clientHeight', {
      configurable: true,
      get: () => 400,
    });
    terminal._core = {
      _renderService: {
        dimensions: {
          css: {
            cell: {
              width: 10,
              height: 20,
            },
          },
        },
      },
    };

    onResize.mockClear();
    emitResizeObservers(resizeObserverCallbacks);
    onResize.mockClear();

    onResize
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);

    surfaceWidth = 790;
    emitResizeObservers(resizeObserverCallbacks);
    expect(onResize).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(onResize).toHaveBeenCalledTimes(2);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onResize).toHaveBeenCalledTimes(3);

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(onResize).toHaveBeenCalledTimes(4);

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(onResize).toHaveBeenCalledTimes(5);

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(onResize).toHaveBeenCalledTimes(6);
    expect(onResize).toHaveBeenLastCalledWith('terminal-retry-cap', 79, 20);

    vi.useRealTimers();
  });

  it('stops retrying after 10 seconds and reports a resize sync error', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const onResize = vi.fn().mockReturnValue(false);
    const onResizeSyncError = vi.fn();

    act(() => {
      root.render(
        createElement(TerminalSurface, {
          sessionId: 'terminal-timeout',
          scrollback: '',
          interactionMode: 'interactive',
          sizeSource: 'measured',
          resizeAuthority: 'owner',
          onInput: vi.fn(),
          onResize,
          onResizeSyncError,
        }),
      );
    });

    const terminal = getSingleMockTerminal() as InstanceType<
      typeof mockTerminalState.MockTerminal
    > & {
      _core?: {
        _renderService?: {
          dimensions?: {
            css?: {
              cell?: {
                width?: number;
                height?: number;
              };
            };
          };
        };
      };
    };
    const surface = getTerminalSurfaceElement(container);

    Object.defineProperty(surface, 'clientWidth', {
      configurable: true,
      get: () => 790,
    });
    Object.defineProperty(surface, 'clientHeight', {
      configurable: true,
      get: () => 400,
    });
    terminal._core = {
      _renderService: {
        dimensions: {
          css: {
            cell: {
              width: 10,
              height: 20,
            },
          },
        },
      },
    };

    onResize.mockClear();
    emitResizeObservers(resizeObserverCallbacks);
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenLastCalledWith('terminal-timeout', 79, 20);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(onResizeSyncError).toHaveBeenCalledTimes(1);
    expect(onResizeSyncError).toHaveBeenLastCalledWith({
      sessionId: 'terminal-timeout',
      cols: 79,
      rows: 20,
      timeoutMs: 10_000,
    });

    const attemptsAfterTimeout = onResize.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(onResize.mock.calls.length).toBe(attemptsAfterTimeout);

    emitResizeObservers(resizeObserverCallbacks);
    expect(onResize.mock.calls.length).toBe(attemptsAfterTimeout);

    vi.useRealTimers();
  });

  it('does not report a timeout while startup sync is blocked before first send attempt', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const onResize = vi.fn().mockReturnValue(true);
    const onResizeSyncError = vi.fn();

    act(() => {
      root.render(
        createElement(TerminalSurface, {
          sessionId: 'terminal-startup-blocked',
          scrollback: '',
          interactionMode: 'interactive',
          sizeSource: 'measured',
          resizeAuthority: 'owner',
          canSyncResize: false,
          onInput: vi.fn(),
          onResize,
          onResizeSyncError,
        }),
      );
    });

    const terminal = getSingleMockTerminal() as InstanceType<
      typeof mockTerminalState.MockTerminal
    > & {
      _core?: {
        _renderService?: {
          dimensions?: {
            css?: {
              cell?: {
                width?: number;
                height?: number;
              };
            };
          };
        };
      };
    };
    const surface = getTerminalSurfaceElement(container);

    Object.defineProperty(surface, 'clientWidth', {
      configurable: true,
      get: () => 790,
    });
    Object.defineProperty(surface, 'clientHeight', {
      configurable: true,
      get: () => 400,
    });
    terminal._core = {
      _renderService: {
        dimensions: {
          css: {
            cell: {
              width: 10,
              height: 20,
            },
          },
        },
      },
    };

    emitResizeObservers(resizeObserverCallbacks);
    expect(onResize).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onResizeSyncError).not.toHaveBeenCalled();

    act(() => {
      root.render(
        createElement(TerminalSurface, {
          sessionId: 'terminal-startup-blocked',
          scrollback: '',
          interactionMode: 'interactive',
          sizeSource: 'measured',
          resizeAuthority: 'owner',
          canSyncResize: true,
          onInput: vi.fn(),
          onResize,
          onResizeSyncError,
        }),
      );
    });

    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenLastCalledWith(
      'terminal-startup-blocked',
      79,
      20,
    );
    expect(onResizeSyncError).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('serializes focused resizes behind pending writes', () => {
    const onResize = vi.fn();

    act(() => {
      root.render(
        createElement(TerminalFocusSurface, {
          sessionId: 'terminal-focus',
          scrollback: '',
          onInput: vi.fn(),
          onResize,
        }),
      );
    });

    const terminal = getSingleMockTerminal() as InstanceType<
      typeof mockTerminalState.MockTerminal
    > & {
      _core?: {
        _renderService?: {
          dimensions?: {
            css?: {
              cell?: {
                width?: number;
                height?: number;
              };
            };
          };
        };
      };
    };
    const surface = getTerminalSurfaceElement(container);

    let surfaceWidth = 800;
    const surfaceHeight = 400;
    Object.defineProperty(surface, 'clientWidth', {
      configurable: true,
      get: () => surfaceWidth,
    });
    Object.defineProperty(surface, 'clientHeight', {
      configurable: true,
      get: () => surfaceHeight,
    });
    terminal._core = {
      _renderService: {
        dimensions: {
          css: {
            cell: {
              width: 10,
              height: 20,
            },
          },
        },
      },
    };

    terminal.resizeCalls.length = 0;
    onResize.mockClear();
    emitResizeObservers(resizeObserverCallbacks);

    expect(terminal.resizeCalls.at(-1)).toEqual({ cols: 80, rows: 20 });
    expect(onResize).toHaveBeenLastCalledWith('terminal-focus', 80, 20);

    terminal.resizeCalls.length = 0;
    onResize.mockClear();
    terminal.autoFlushWriteCallbacks = false;

    act(() => {
      root.render(
        createElement(TerminalFocusSurface, {
          sessionId: 'terminal-focus',
          scrollback: 'prompt',
          onInput: vi.fn(),
          onResize,
        }),
      );
    });

    surfaceWidth = 790;
    emitResizeObservers(resizeObserverCallbacks);

    expect(terminal.writeCalls.slice(-2)).toEqual(['prompt', '']);
    expect(terminal.resizeCalls).toEqual([]);
    expect(onResize).not.toHaveBeenCalled();

    act(() => {
      terminal.flushWriteCallbacks();
    });

    expect(terminal.resizeCalls).toEqual([{ cols: 79, rows: 20 }]);
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenLastCalledWith('terminal-focus', 79, 20);
  });

  it('drops PTY resize authority after switching into a read-only live preview', () => {
    const onResize = vi.fn();

    act(() => {
      root.render(
        createElement(TerminalSurface, {
          sessionId: 'terminal-shared',
          scrollback: '',
          interactionMode: 'interactive',
          sizeSource: 'measured',
          resizeAuthority: 'owner',
          onInput: vi.fn(),
          onResize,
        }),
      );
    });

    const terminal = getSingleMockTerminal() as InstanceType<
      typeof mockTerminalState.MockTerminal
    > & {
      _core?: {
        _renderService?: {
          dimensions?: {
            css?: {
              cell?: {
                width?: number;
                height?: number;
              };
            };
          };
        };
      };
    };
    const surface = getTerminalSurfaceElement(container);

    let surfaceWidth = 800;
    let surfaceHeight = 400;
    Object.defineProperty(surface, 'clientWidth', {
      configurable: true,
      get: () => surfaceWidth,
    });
    Object.defineProperty(surface, 'clientHeight', {
      configurable: true,
      get: () => surfaceHeight,
    });
    terminal._core = {
      _renderService: {
        dimensions: {
          css: {
            cell: {
              width: 10,
              height: 20,
            },
          },
        },
      },
    };

    terminal.resizeCalls.length = 0;
    onResize.mockClear();
    emitResizeObservers(resizeObserverCallbacks);

    expect(terminal.resizeCalls.at(-1)).toEqual({ cols: 80, rows: 20 });
    expect(onResize).toHaveBeenLastCalledWith('terminal-shared', 80, 20);

    surfaceWidth = 300;
    surfaceHeight = 200;

    act(() => {
      root.render(
        createElement(TerminalSurface, {
          sessionId: 'terminal-shared',
          scrollback: '',
          interactionMode: 'read-only',
          sizeSource: 'snapshot',
          resizeAuthority: 'none',
          snapshotCols: 80,
          onInput: vi.fn(),
          onResize,
        }),
      );
    });

    expect(mockTerminalState.instances).toHaveLength(1);
    expect(terminal.resizeCalls.at(-1)).toEqual({ cols: 80, rows: 10 });
    expect(onResize).toHaveBeenCalledTimes(1);

    terminal.resizeCalls.length = 0;
    onResize.mockClear();
    surfaceWidth = 260;
    emitResizeObservers(resizeObserverCallbacks);

    expect(terminal.resizeCalls).toEqual([]);
    expect(onResize).not.toHaveBeenCalled();
  });

  it('keeps snapshot-sized read-only surfaces from becoming resize owners', () => {
    const onResize = vi.fn();

    act(() => {
      root.render(
        createElement(TerminalSurface, {
          sessionId: 'terminal-read-only',
          scrollback: '',
          interactionMode: 'read-only',
          sizeSource: 'snapshot',
          resizeAuthority: 'none',
          snapshotCols: 120,
          onResize,
        }),
      );
    });

    const terminal = getSingleMockTerminal() as InstanceType<
      typeof mockTerminalState.MockTerminal
    > & {
      _core?: {
        _renderService?: {
          dimensions?: {
            css?: {
              cell?: {
                width?: number;
                height?: number;
              };
            };
          };
        };
      };
    };
    const surface = getTerminalSurfaceElement(container);

    let surfaceWidth = 600;
    const surfaceHeight = 200;
    Object.defineProperty(surface, 'clientWidth', {
      configurable: true,
      get: () => surfaceWidth,
    });
    Object.defineProperty(surface, 'clientHeight', {
      configurable: true,
      get: () => surfaceHeight,
    });
    terminal._core = {
      _renderService: {
        dimensions: {
          css: {
            cell: {
              width: 10,
              height: 20,
            },
          },
        },
      },
    };

    terminal.resizeCalls.length = 0;
    onResize.mockClear();

    emitResizeObservers(resizeObserverCallbacks);
    expect(terminal.resizeCalls.at(-1)).toEqual({ cols: 120, rows: 10 });
    expect(onResize).not.toHaveBeenCalled();

    terminal.resizeCalls.length = 0;
    onResize.mockClear();
    surfaceWidth = 500;
    emitResizeObservers(resizeObserverCallbacks);
    surfaceWidth = 450;
    emitResizeObservers(resizeObserverCallbacks);

    expect(terminal.resizeCalls).toEqual([]);
    expect(onResize).not.toHaveBeenCalled();
  });

  it('retries a pending resize once backend sync is available again', () => {
    const onResize = vi.fn().mockReturnValue(true);

    act(() => {
      root.render(
        createElement(TerminalSurface, {
          sessionId: 'terminal-retry',
          scrollback: '',
          interactionMode: 'interactive',
          sizeSource: 'measured',
          resizeAuthority: 'owner',
          canSyncResize: false,
          onInput: vi.fn(),
          onResize,
        }),
      );
    });

    const terminal = getSingleMockTerminal() as InstanceType<
      typeof mockTerminalState.MockTerminal
    > & {
      _core?: {
        _renderService?: {
          dimensions?: {
            css?: {
              cell?: {
                width?: number;
                height?: number;
              };
            };
          };
        };
      };
    };
    const surface = getTerminalSurfaceElement(container);

    let surfaceWidth = 800;
    const surfaceHeight = 400;
    Object.defineProperty(surface, 'clientWidth', {
      configurable: true,
      get: () => surfaceWidth,
    });
    Object.defineProperty(surface, 'clientHeight', {
      configurable: true,
      get: () => surfaceHeight,
    });
    terminal._core = {
      _renderService: {
        dimensions: {
          css: {
            cell: {
              width: 10,
              height: 20,
            },
          },
        },
      },
    };

    terminal.resizeCalls.length = 0;
    onResize.mockClear();
    emitResizeObservers(resizeObserverCallbacks);

    expect(terminal.resizeCalls.at(-1)).toEqual({ cols: 80, rows: 20 });
    expect(onResize).not.toHaveBeenCalled();

    act(() => {
      root.render(
        createElement(TerminalSurface, {
          sessionId: 'terminal-retry',
          scrollback: '',
          interactionMode: 'interactive',
          sizeSource: 'measured',
          resizeAuthority: 'owner',
          canSyncResize: true,
          onInput: vi.fn(),
          onResize,
        }),
      );
    });

    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenLastCalledWith('terminal-retry', 80, 20);

    onResize.mockClear();
    emitResizeObservers(resizeObserverCallbacks);
    expect(onResize).not.toHaveBeenCalled();

    surfaceWidth = 790;
    emitResizeObservers(resizeObserverCallbacks);
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenLastCalledWith('terminal-retry', 79, 20);
  });

  it('flushes the latest deferred resize when sync deferral is lifted', () => {
    const onResize = vi.fn().mockReturnValue(true);

    act(() => {
      root.render(
        createElement(TerminalSurface, {
          sessionId: 'terminal-defer',
          scrollback: '',
          interactionMode: 'interactive',
          sizeSource: 'measured',
          resizeAuthority: 'owner',
          deferResizeSync: true,
          onInput: vi.fn(),
          onResize,
        }),
      );
    });

    const terminal = getSingleMockTerminal() as InstanceType<
      typeof mockTerminalState.MockTerminal
    > & {
      _core?: {
        _renderService?: {
          dimensions?: {
            css?: {
              cell?: {
                width?: number;
                height?: number;
              };
            };
          };
        };
      };
    };
    const surface = getTerminalSurfaceElement(container);

    let surfaceWidth = 800;
    const surfaceHeight = 400;
    Object.defineProperty(surface, 'clientWidth', {
      configurable: true,
      get: () => surfaceWidth,
    });
    Object.defineProperty(surface, 'clientHeight', {
      configurable: true,
      get: () => surfaceHeight,
    });
    terminal._core = {
      _renderService: {
        dimensions: {
          css: {
            cell: {
              width: 10,
              height: 20,
            },
          },
        },
      },
    };

    terminal.resizeCalls.length = 0;
    onResize.mockClear();
    emitResizeObservers(resizeObserverCallbacks);

    surfaceWidth = 790;
    emitResizeObservers(resizeObserverCallbacks);

    expect(terminal.resizeCalls.at(-1)).toEqual({ cols: 79, rows: 20 });
    expect(onResize).not.toHaveBeenCalled();

    act(() => {
      root.render(
        createElement(TerminalSurface, {
          sessionId: 'terminal-defer',
          scrollback: '',
          interactionMode: 'interactive',
          sizeSource: 'measured',
          resizeAuthority: 'owner',
          deferResizeSync: false,
          onInput: vi.fn(),
          onResize,
        }),
      );
    });

    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenLastCalledWith('terminal-defer', 79, 20);
  });

  it('re-syncs backend size when snapshot dimensions drift from rendered interactive size', () => {
    const onResize = vi.fn().mockReturnValue(true);

    act(() => {
      root.render(
        createElement(TerminalSurface, {
          sessionId: 'terminal-resync',
          scrollback: '',
          interactionMode: 'interactive',
          sizeSource: 'measured',
          resizeAuthority: 'owner',
          snapshotCols: 80,
          snapshotRows: 20,
          canSyncResize: true,
          onInput: vi.fn(),
          onResize,
        }),
      );
    });

    const terminal = getSingleMockTerminal() as InstanceType<
      typeof mockTerminalState.MockTerminal
    > & {
      _core?: {
        _renderService?: {
          dimensions?: {
            css?: {
              cell?: {
                width?: number;
                height?: number;
              };
            };
          };
        };
      };
    };
    const surface = getTerminalSurfaceElement(container);

    Object.defineProperty(surface, 'clientWidth', {
      configurable: true,
      get: () => 800,
    });
    Object.defineProperty(surface, 'clientHeight', {
      configurable: true,
      get: () => 400,
    });
    terminal._core = {
      _renderService: {
        dimensions: {
          css: {
            cell: {
              width: 10,
              height: 20,
            },
          },
        },
      },
    };

    terminal.resizeCalls.length = 0;
    onResize.mockClear();
    emitResizeObservers(resizeObserverCallbacks);

    expect(terminal.resizeCalls.at(-1)).toEqual({ cols: 80, rows: 20 });
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenLastCalledWith('terminal-resync', 80, 20);

    onResize.mockClear();
    act(() => {
      root.render(
        createElement(TerminalSurface, {
          sessionId: 'terminal-resync',
          scrollback: '',
          interactionMode: 'interactive',
          sizeSource: 'measured',
          resizeAuthority: 'owner',
          snapshotCols: 70,
          snapshotRows: 20,
          canSyncResize: true,
          onInput: vi.fn(),
          onResize,
        }),
      );
    });

    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenLastCalledWith('terminal-resync', 80, 20);
  });

  it('applies snapshot rows for read-only snapshot sizing', () => {
    const onResize = vi.fn();

    act(() => {
      root.render(
        createElement(TerminalSurface, {
          sessionId: 'terminal-read-only-rows',
          scrollback: '',
          interactionMode: 'read-only',
          sizeSource: 'snapshot',
          resizeAuthority: 'none',
          snapshotCols: 80,
          snapshotRows: 24,
          onResize,
        }),
      );
    });

    const terminal = getSingleMockTerminal() as InstanceType<
      typeof mockTerminalState.MockTerminal
    > & {
      _core?: {
        _renderService?: {
          dimensions?: {
            css?: {
              cell?: {
                width?: number;
                height?: number;
              };
            };
          };
        };
      };
    };
    const surface = getTerminalSurfaceElement(container);

    Object.defineProperty(surface, 'clientWidth', {
      configurable: true,
      get: () => 400,
    });
    Object.defineProperty(surface, 'clientHeight', {
      configurable: true,
      get: () => 120,
    });
    terminal._core = {
      _renderService: {
        dimensions: {
          css: {
            cell: {
              width: 10,
              height: 20,
            },
          },
        },
      },
    };

    onResize.mockClear();

    expect(terminal.resizeCalls).toContainEqual({ cols: 80, rows: 24 });
    expect(onResize).not.toHaveBeenCalled();
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

function emitResizeObservers(callbacks: ReadonlyArray<() => void>): void {
  for (const callback of callbacks) {
    callback();
  }
}

function getTerminalSurfaceElement(container: HTMLDivElement): HTMLDivElement {
  const surface = container.querySelector('.terminal-surface');

  expect(surface).toBeInstanceOf(HTMLDivElement);

  return surface as HTMLDivElement;
}
