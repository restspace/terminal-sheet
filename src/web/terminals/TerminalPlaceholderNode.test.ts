/** @vitest-environment jsdom */

import {
  createElement,
  type ComponentProps,
  type ReactNode,
  useEffect,
} from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSurfaceState = vi.hoisted(() => ({
  mountCount: 0,
  unmountCount: 0,
}));

vi.mock('@xyflow/react', () => ({
  useViewport: () => ({ zoom: 1 }),
}));

vi.mock('../canvas/CanvasResizeHandles', () => ({
  CanvasResizeHandles: () => null,
}));

vi.mock('./TerminalTitleBar', () => ({
  TerminalTitleBar: (props: { sidecar?: ReactNode }) =>
    createElement('div', { 'data-testid': 'terminal-title-bar' }, props.sidecar),
}));

vi.mock('./TerminalFocusSurface', () => {
  const MockTerminalSurface = (props: {
    className?: string;
    sessionId: string;
    scrollback: string;
    acceptsInput?: boolean;
    autoFocusAtMs?: number | null;
    freezeGeometry?: boolean;
  }) => {
    useEffect(() => {
      mockSurfaceState.mountCount += 1;

      return () => {
        mockSurfaceState.unmountCount += 1;
      };
    }, []);

    return createElement('div', {
      'data-testid': 'terminal-surface',
      'data-session-id': props.sessionId,
      'data-scrollback': props.scrollback,
      'data-read-only': String(!props.acceptsInput),
      'data-auto-focus': String(props.autoFocusAtMs ?? ''),
      'data-freeze-geometry': String(Boolean(props.freezeGeometry)),
      className: props.className,
    });
  };

  return {
    TerminalSurface: MockTerminalSurface,
    TerminalFocusSurface: (props: {
      className?: string;
      sessionId: string;
      scrollback: string;
      autoFocusAtMs?: number | null;
    }) =>
      MockTerminalSurface({
        ...props,
        acceptsInput: true,
      }),
  };
});

import type { TerminalSessionSnapshot } from '../../shared/terminalSessions';
import { createPlaceholderTerminal } from '../../shared/workspace';
import { TerminalPlaceholderNode } from './TerminalPlaceholderNode';
import type { TerminalSurfaceModel } from './terminalSurfaceModel';
import type { TerminalFlowNode } from './types';

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe('TerminalPlaceholderNode', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    mockSurfaceState.mountCount = 0;
    mockSurfaceState.unmountCount = 0;
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

  it('uses the shared terminal surface for inspect-mode live previews in read-only mode', () => {
    const terminal = createPlaceholderTerminal(0);
    const session = createSessionSnapshot(terminal.id, {
      scrollback: 'line 1\r\nline 2',
    });

    act(() => {
      root.render(
        createElement(
          TerminalPlaceholderNode,
          createNodeProps({
            terminal,
            session,
            presentationMode: 'inspect',
            surfaceKind: 'live',
          }),
        ),
      );
    });

    const preview = container.querySelector('[data-testid="terminal-surface"]');

    expect(preview).not.toBeNull();
    expect(preview?.getAttribute('data-session-id')).toBe(terminal.id);
    expect(preview?.getAttribute('data-scrollback')).toBe('line 1\r\nline 2');
    expect(preview?.getAttribute('data-read-only')).toBe('true');
    expect(container.textContent).not.toContain('No terminal output yet');
  });

  it('falls back to the static inspect summary when no live preview is mounted', () => {
    const terminal = createPlaceholderTerminal(0);
    const session = createSessionSnapshot(terminal.id, {
      previewLines: ['build started', 'build finished'],
      summary: 'build finished',
    });

    act(() => {
      root.render(
        createElement(
          TerminalPlaceholderNode,
          createNodeProps({
            terminal,
            session,
            presentationMode: 'inspect',
            surfaceKind: 'summary',
          }),
        ),
      );
    });

    expect(container.querySelector('[data-testid="terminal-surface"]')).toBeNull();
    expect(container.textContent).toContain('build finished');
    expect(container.querySelector('code')?.textContent).toBe('build started');
  });

  it('reuses the same mounted terminal surface when inspect mode becomes focus mode', () => {
    const terminal = createPlaceholderTerminal(0);
    const session = createSessionSnapshot(terminal.id, {
      scrollback: 'streaming output',
    });

    act(() => {
      root.render(
        createElement(
          TerminalPlaceholderNode,
          createNodeProps({
            terminal,
            session,
            presentationMode: 'inspect',
            surfaceKind: 'live',
          }),
        ),
      );
    });

    const inspectSurface = container.querySelector('[data-testid="terminal-surface"]');

    expect(inspectSurface?.getAttribute('data-read-only')).toBe('true');
    expect(mockSurfaceState.mountCount).toBe(1);
    expect(mockSurfaceState.unmountCount).toBe(0);

    act(() => {
      root.render(
        createElement(
          TerminalPlaceholderNode,
          createNodeProps({
            terminal,
            session,
            presentationMode: 'focus',
            surfaceKind: 'live',
            selected: true,
            acceptsInput: true,
            autoFocusAtMs: 123,
          }),
        ),
      );
    });

    const focusSurface = container.querySelector('[data-testid="terminal-surface"]');

    expect(focusSurface?.getAttribute('data-read-only')).toBe('false');
    expect(focusSurface?.getAttribute('data-auto-focus')).toBe('123');
    expect(mockSurfaceState.mountCount).toBe(1);
    expect(mockSurfaceState.unmountCount).toBe(0);
  });

  it('freezes terminal geometry while layout animation is active', () => {
    const terminal = createPlaceholderTerminal(0);
    const session = createSessionSnapshot(terminal.id, {
      scrollback: 'streaming output',
    });

    act(() => {
      root.render(
        createElement(
          TerminalPlaceholderNode,
          createNodeProps({
            terminal,
            session,
            presentationMode: 'focus',
            surfaceKind: 'live',
            selected: true,
            acceptsInput: true,
            freezeTerminalGeometry: true,
          }),
        ),
      );
    });

    const animatedSurface = container.querySelector('[data-testid="terminal-surface"]');
    expect(animatedSurface?.getAttribute('data-freeze-geometry')).toBe('true');

    act(() => {
      root.render(
        createElement(
          TerminalPlaceholderNode,
          createNodeProps({
            terminal,
            session,
            presentationMode: 'focus',
            surfaceKind: 'live',
            selected: true,
            acceptsInput: true,
            freezeTerminalGeometry: false,
          }),
        ),
      );
    });

    const steadySurface = container.querySelector('[data-testid="terminal-surface"]');
    expect(steadySurface?.getAttribute('data-freeze-geometry')).toBe('false');
  });

  it('renders remote sessions through the same live preview path as local sessions', () => {
    const localTerminal = createPlaceholderTerminal(0);
    const remoteTerminal = {
      ...localTerminal,
      backendId: 'remote-1',
    };
    const session = createSessionSnapshot(remoteTerminal.id, {
      backendId: 'remote-1',
      scrollback: 'line 1\r\nline 2',
    });

    act(() => {
      root.render(
        createElement(
          TerminalPlaceholderNode,
          createNodeProps({
            terminal: localTerminal,
            session,
            presentationMode: 'inspect',
            surfaceKind: 'live',
          }),
        ),
      );
    });

    const localPreview = container.querySelector('[data-testid="terminal-surface"]');

    expect(localPreview?.getAttribute('data-session-id')).toBe(localTerminal.id);
    expect(localPreview?.getAttribute('data-scrollback')).toBe('line 1\r\nline 2');
    expect(localPreview?.getAttribute('data-read-only')).toBe('true');
    expect(mockSurfaceState.mountCount).toBe(1);
    expect(mockSurfaceState.unmountCount).toBe(0);

    act(() => {
      root.render(
        createElement(
          TerminalPlaceholderNode,
          createNodeProps({
            terminal: remoteTerminal,
            session,
            presentationMode: 'inspect',
            surfaceKind: 'live',
          }),
        ),
      );
    });

    const remotePreview = container.querySelector('[data-testid="terminal-surface"]');

    expect(remotePreview?.getAttribute('data-session-id')).toBe(remoteTerminal.id);
    expect(remotePreview?.getAttribute('data-scrollback')).toBe('line 1\r\nline 2');
    expect(remotePreview?.getAttribute('data-read-only')).toBe('true');
    expect(mockSurfaceState.mountCount).toBe(1);
    expect(mockSurfaceState.unmountCount).toBe(0);
  });
});

function createNodeProps(options: {
  terminal: ReturnType<typeof createPlaceholderTerminal>;
  session: TerminalSessionSnapshot | null;
  presentationMode: 'overview' | 'inspect' | 'focus';
  surfaceKind: TerminalSurfaceModel['surfaceKind'];
  selected?: boolean;
  acceptsInput?: boolean;
  autoFocusAtMs?: number | null;
  freezeTerminalGeometry?: boolean;
}): ComponentProps<typeof TerminalPlaceholderNode> {
  return {
    id: options.terminal.id,
    data: {
      terminal: options.terminal,
      session: options.session,
      surfaceModel: {
        presentationMode: options.presentationMode,
        surfaceKind: options.surfaceKind,
        acceptsInput: options.acceptsInput ?? false,
      },
      autoFocusAtMs: options.autoFocusAtMs ?? null,
      socketState: 'open' as const,
      onBoundsChange: vi.fn(),
      onTerminalChange: vi.fn(),
      onPathSelectRequest: vi.fn(),
      onRemove: vi.fn(),
      onInput: vi.fn(),
      onResize: vi.fn(),
      onRestart: vi.fn(),
      onMarkRead: vi.fn(),
      onMarkdownDrop: vi.fn(),
      backendAccent: null,
      activeMarkdownLink: null,
      freezeTerminalGeometry: options.freezeTerminalGeometry ?? false,
      allowResize: true,
      resizeZoom: 1,
    } satisfies TerminalFlowNode['data'],
    width: options.terminal.bounds.width,
    height: options.terminal.bounds.height,
    selected: options.selected ?? false,
    dragging: false,
    zIndex: 1,
    isConnectable: false,
    type: 'terminal',
  } as unknown as ComponentProps<typeof TerminalPlaceholderNode>;
}

function createSessionSnapshot(
  sessionId: string,
  overrides: Partial<TerminalSessionSnapshot> = {},
): TerminalSessionSnapshot {
  const { appliedResizeGeneration = null, ...remainingOverrides } = overrides;
  return {
    sessionId,
    backendId: overrides.backendId ?? 'local',
    pid: 123,
    status: 'active-output',
    commandState: 'running-command',
    connected: true,
    recoveryState: 'live',
    startedAt: '2026-03-14T09:00:00.000Z',
    lastActivityAt: '2026-03-14T09:00:10.000Z',
    lastOutputAt: '2026-03-14T09:00:10.000Z',
    lastOutputLine: 'build finished',
    previewLines: ['build finished'],
    scrollback: '',
    unreadCount: 0,
    summary: 'build finished',
    exitCode: null,
    disconnectReason: null,
    cols: 80,
    rows: 24,
    appliedResizeGeneration,
    liveCwd: '.',
    projectRoot: '.',
    integration: {
      owner: null,
      status: 'not-required',
      message: 'Integration is not required for shell sessions.',
      updatedAt: null,
    },
    ...remainingOverrides,
  };
}
