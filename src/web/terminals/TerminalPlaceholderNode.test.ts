/** @vitest-environment jsdom */

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@xyflow/react', () => ({
  useViewport: () => ({ zoom: 1 }),
}));

vi.mock('../canvas/CanvasResizeHandles', () => ({
  CanvasResizeHandles: () => null,
}));

vi.mock('./TerminalTitleBar', () => ({
  TerminalTitleBar: () => createElement('div', { 'data-testid': 'terminal-title-bar' }),
}));

vi.mock('./TerminalFocusSurface', () => ({
  ReadOnlyTerminalSurface: (props: {
    className?: string;
    sessionId: string;
    scrollback: string;
    scrollResetKey?: string | number | boolean;
  }) =>
    createElement('div', {
      'data-testid': 'readonly-live-preview',
      'data-session-id': props.sessionId,
      'data-scrollback': props.scrollback,
      'data-reset-key': String(props.scrollResetKey ?? ''),
      className: props.className,
    }),
}));

vi.mock('./TerminalScrollPreview', () => ({
  TerminalScrollPreview: () =>
    createElement('pre', {
      'data-testid': 'text-scroll-preview',
    }),
}));

import type { TerminalSessionSnapshot } from '../../shared/terminalSessions';
import { createPlaceholderTerminal } from '../../shared/workspace';
import { TerminalPlaceholderNode } from './TerminalPlaceholderNode';
import type { TerminalFlowNode } from './types';

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe('TerminalPlaceholderNode', () => {
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

  it('uses the read-only live xterm surface for inspect-mode live previews', () => {
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
            mountLivePreview: true,
          }),
        ),
      );
    });

    const preview = container.querySelector('[data-testid="readonly-live-preview"]');

    expect(preview).not.toBeNull();
    expect(preview?.getAttribute('data-session-id')).toBe(terminal.id);
    expect(preview?.getAttribute('data-scrollback')).toBe('line 1\r\nline 2');
    expect(container.querySelector('[data-testid="text-scroll-preview"]')).toBeNull();
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
            mountLivePreview: false,
          }),
        ),
      );
    });

    expect(container.querySelector('[data-testid="readonly-live-preview"]')).toBeNull();
    expect(container.textContent).toContain('build finished');
    expect(container.querySelector('code')?.textContent).toBe('build started');
  });
});

function createNodeProps(options: {
  terminal: ReturnType<typeof createPlaceholderTerminal>;
  session: TerminalSessionSnapshot | null;
  presentationMode: 'overview' | 'inspect' | 'focus';
  mountLivePreview: boolean;
}): Parameters<typeof TerminalPlaceholderNode>[0] {
  return {
    id: options.terminal.id,
    data: {
      terminal: options.terminal,
      session: options.session,
      presentationMode: options.presentationMode,
      mountLivePreview: options.mountLivePreview,
      socketState: 'open' as const,
      onSelect: vi.fn(),
      onBoundsChange: vi.fn(),
      onTerminalChange: vi.fn(),
      onRemove: vi.fn(),
      onInput: vi.fn(),
      onResize: vi.fn(),
      onRestart: vi.fn(),
      onMarkRead: vi.fn(),
      onMarkdownDrop: vi.fn(),
      activeMarkdownLink: null,
    } satisfies TerminalFlowNode['data'],
    width: options.terminal.bounds.width,
    height: options.terminal.bounds.height,
    selected: false,
    dragging: false,
    zIndex: 1,
    isConnectable: false,
    type: 'terminal',
  } as unknown as Parameters<typeof TerminalPlaceholderNode>[0];
}

function createSessionSnapshot(
  sessionId: string,
  overrides: Partial<TerminalSessionSnapshot> = {},
): TerminalSessionSnapshot {
  return {
    sessionId,
    backendId: 'local',
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
    liveCwd: '.',
    projectRoot: '.',
    integration: {
      owner: null,
      status: 'not-required',
      message: 'Integration is not required for shell sessions.',
      updatedAt: null,
    },
    ...overrides,
  };
}
