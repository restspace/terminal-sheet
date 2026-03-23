/** @vitest-environment jsdom */

import {
  createElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockReactFlowProps {
  nodes: Array<{
    id: string;
    type: 'terminal' | 'markdown';
    data: unknown;
    position?: {
      x: number;
      y: number;
    };
    selected?: boolean;
    width?: number;
    height?: number;
    className?: string;
  }>;
  nodeTypes: Record<string, (props: unknown) => ReactElement | null>;
  children?: ReactNode;
  onMoveStart?: (event: MouseEvent | TouchEvent | null, viewport: unknown) => void;
  onMoveEnd?: (event: MouseEvent | TouchEvent | null, viewport: unknown) => void;
}

let latestReactFlowProps: MockReactFlowProps | null = null;

vi.mock('@xyflow/react', () => ({
  Background: () => createElement('div', { 'data-testid': 'background' }),
  BackgroundVariant: {
    Dots: 'dots',
  },
  Controls: () => createElement('div', { 'data-testid': 'controls' }),
  MiniMap: () => createElement('div', { 'data-testid': 'minimap' }),
  ReactFlowProvider: (props: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'react-flow-provider' }, props.children),
  ReactFlow: (props: MockReactFlowProps) => {
    latestReactFlowProps = props;
    const renderedChildren: ReactNode[] = props.nodes.map((node) => {
      const NodeComponent = props.nodeTypes[node.type] ?? (() => null);

      return createElement(
        'div',
        {
          key: `node-${node.id}`,
          className: `react-flow__node ${node.className ?? ''}`.trim(),
        },
        createElement(NodeComponent as (props: object) => ReactElement | null, node),
      );
    });

    if (props.children !== undefined) {
      renderedChildren.push(props.children);
    }

    return createElement(
      'div',
      { 'data-testid': 'react-flow-root' },
      renderedChildren,
    );
  },
}));

vi.mock('../terminals/TerminalPlaceholderNode', () => ({
  TerminalPlaceholderNode: (props: {
    id: string;
    selected?: boolean;
    data: {
      surfaceModel: {
        presentationMode: string;
        surfaceKind: string;
      };
      autoFocusAtMs: number | null;
    };
  }) =>
    createElement('div', {
      'data-testid': 'terminal-node',
      'data-node-id': props.id,
      'data-selected': String(Boolean(props.selected)),
      'data-mode': props.data.surfaceModel.presentationMode,
      'data-live-preview': String(
        props.data.surfaceModel.surfaceKind === 'live-preview',
      ),
      'data-auto-focus': String(props.data.autoFocusAtMs ?? ''),
    }),
}));

vi.mock('../markdown/MarkdownPlaceholderNode', () => ({
  MarkdownPlaceholderNode: (props: { id: string }) =>
    createElement('div', {
      'data-testid': 'markdown-node',
      'data-node-id': props.id,
    }),
}));

vi.mock('./layout/strategyRegistry', async () => {
  const actual = await vi.importActual<typeof import('./layout/strategyRegistry')>(
    './layout/strategyRegistry',
  );
  return {
    ...actual,
    getLayoutStrategy: vi.fn(actual.getLayoutStrategy),
  };
});

import type { TerminalSessionSnapshot } from '../../shared/terminalSessions';
import {
  createDefaultWorkspace,
  createPlaceholderTerminal,
} from '../../shared/workspace';
import { getLayoutStrategy } from './layout/strategyRegistry';
import { WorkspaceCanvas } from './WorkspaceCanvas';

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe('WorkspaceCanvas', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal(
      'ResizeObserver',
      class MockResizeObserver {
        constructor(callback: (entries: Array<{ contentRect: DOMRectReadOnly }>) => void) {
          callback([
            {
              contentRect: {
                width: 1280,
                height: 720,
              } as DOMRectReadOnly,
            },
          ]);
        }

        observe(): void {}

        disconnect(): void {}
      },
    );
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    latestReactFlowProps = null;
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('renders the focused terminal in the selected node without a separate overlay layer', () => {
    const focusedTerminal = createPlaceholderTerminal(0);
    const inspectTerminal = createPlaceholderTerminal(1);
    const workspace = {
      ...createDefaultWorkspace(),
      terminals: [focusedTerminal, inspectTerminal],
      selectedNodeId: focusedTerminal.id,
    };

    act(() => {
      root.render(
        createElement(WorkspaceCanvas, createCanvasProps({
          workspace,
          selectedNodeId: focusedTerminal.id,
          focusAutoFocusAtMs: 321,
          sessions: {
            [focusedTerminal.id]: createSessionSnapshot(focusedTerminal.id),
            [inspectTerminal.id]: createSessionSnapshot(inspectTerminal.id),
          },
        })),
      );
    });

    const renderedTerminals = Array.from(
      container.querySelectorAll('[data-testid="terminal-node"]'),
    );
    const focusedNode = renderedTerminals.find(
      (node) => node.getAttribute('data-node-id') === focusedTerminal.id,
    );
    const inspectNode = renderedTerminals.find(
      (node) => node.getAttribute('data-node-id') === inspectTerminal.id,
    );

    expect(renderedTerminals).toHaveLength(2);
    expect(focusedNode?.getAttribute('data-mode')).toBe('focus');
    expect(focusedNode?.getAttribute('data-selected')).toBe('true');
    expect(focusedNode?.getAttribute('data-auto-focus')).toBe('321');
    expect(inspectNode?.getAttribute('data-mode')).toBe('inspect');
    expect(container.querySelector('.focus-terminal-overlay')).toBeNull();
  });

  it('keeps terminal callback props stable across session updates', () => {
    const focusedTerminal = createPlaceholderTerminal(0);
    const inspectTerminal = createPlaceholderTerminal(1);
    const focusedSession = createSessionSnapshot(focusedTerminal.id);
    const inspectSession = createSessionSnapshot(inspectTerminal.id);
    const workspace = {
      ...createDefaultWorkspace(),
      terminals: [focusedTerminal, inspectTerminal],
      selectedNodeId: focusedTerminal.id,
    };

    act(() => {
      root.render(
        createElement(WorkspaceCanvas, createCanvasProps({
          workspace,
          selectedNodeId: focusedTerminal.id,
          sessions: {
            [focusedTerminal.id]: focusedSession,
            [inspectTerminal.id]: inspectSession,
          },
        })),
      );
    });

    const previousData = expectTerminalNodeData(inspectTerminal.id);

    act(() => {
      root.render(
        createElement(WorkspaceCanvas, createCanvasProps({
          workspace: {
            ...workspace,
            updatedAt: '2026-03-23T12:40:00.000Z',
          },
          selectedNodeId: focusedTerminal.id,
          sessions: {
            [focusedTerminal.id]: {
              ...focusedSession,
              lastOutputAt: '2026-03-23T12:40:00.000Z',
              lastOutputLine: 'new output',
              previewLines: ['new output'],
            },
            [inspectTerminal.id]: inspectSession,
          },
        })),
      );
    });

    const nextData = expectTerminalNodeData(inspectTerminal.id);

    expect(nextData.onTerminalChange).toBe(previousData.onTerminalChange);
    expect(nextData.onPathSelectRequest).toBe(previousData.onPathSelectRequest);
    expect(nextData.onRemove).toBe(previousData.onRemove);
    expect(nextData.onInput).toBe(previousData.onInput);
    expect(nextData.onResize).toBe(previousData.onResize);
    expect(nextData.onRestart).toBe(previousData.onRestart);
    expect(nextData.onMarkRead).toBe(previousData.onMarkRead);
    expect(nextData.onMarkdownDrop).toBe(previousData.onMarkdownDrop);
  });

  it('reports measured canvas viewport size to the parent', () => {
    const terminal = createPlaceholderTerminal(0);
    const onViewportSizeChange = vi.fn();

    act(() => {
      root.render(
        createElement(WorkspaceCanvas, createCanvasProps({
          workspace: {
            ...createDefaultWorkspace(),
            terminals: [terminal],
          },
          onViewportSizeChange,
        })),
      );
    });

    expect(onViewportSizeChange).toHaveBeenCalledWith({
      width: 1280,
      height: 720,
    });
  });

  it('returns to persisted free-layout bounds after leaving focus-tiles', () => {
    const focusedTerminal = createPlaceholderTerminal(0);
    const sideTerminal = createPlaceholderTerminal(1);
    const onNodeBoundsChange = vi.fn();
    const workspace = {
      ...createDefaultWorkspace(),
      layoutMode: 'focus-tiles' as const,
      currentViewport: {
        x: 0,
        y: 0,
        zoom: 1,
      },
      terminals: [focusedTerminal, sideTerminal],
    };
    const nodeInteractionAtMs = {
      [sideTerminal.id]: 100,
      [focusedTerminal.id]: 50,
    };

    act(() => {
      root.render(
        createElement(WorkspaceCanvas, createCanvasProps({
          workspace,
          selectedNodeId: focusedTerminal.id,
          nodeInteractionAtMs,
          onNodeBoundsChange,
        })),
      );
    });

    const focusTilesPosition = expectNodePosition(focusedTerminal.id);
    expect(focusTilesPosition.x).not.toBeCloseTo(focusedTerminal.bounds.x);
    expect(focusTilesPosition.y).not.toBeCloseTo(focusedTerminal.bounds.y);

    act(() => {
      root.render(
        createElement(WorkspaceCanvas, createCanvasProps({
          workspace: {
            ...workspace,
            layoutMode: 'free',
            updatedAt: '2026-03-22T18:35:00.000Z',
          },
          selectedNodeId: focusedTerminal.id,
          nodeInteractionAtMs,
          onNodeBoundsChange,
        })),
      );
    });

    const restoredFocusPosition = expectNodePosition(focusedTerminal.id);
    const restoredSidePosition = expectNodePosition(sideTerminal.id);

    expect(restoredFocusPosition.x).toBeCloseTo(focusedTerminal.bounds.x);
    expect(restoredFocusPosition.y).toBeCloseTo(focusedTerminal.bounds.y);
    expect(restoredSidePosition.x).toBeCloseTo(sideTerminal.bounds.x);
    expect(restoredSidePosition.y).toBeCloseTo(sideTerminal.bounds.y);
    expect(onNodeBoundsChange).not.toHaveBeenCalled();
  });

  it('ignores programmatic move callbacks when syncing the controlled viewport', () => {
    const terminal = createPlaceholderTerminal(0);
    const onViewportChange = vi.fn();
    const workspace = {
      ...createDefaultWorkspace(),
      terminals: [terminal],
      currentViewport: {
        x: -120,
        y: 48,
        zoom: 0.9,
      },
    };

    act(() => {
      root.render(
        createElement(WorkspaceCanvas, createCanvasProps({
          workspace,
          onViewportChange,
        })),
      );
    });

    act(() => {
      latestReactFlowProps?.onMoveStart?.(null, {
        x: -40,
        y: 48,
        zoom: 0.9,
      });
      latestReactFlowProps?.onMoveEnd?.(null, {
        x: -40,
        y: 48,
        zoom: 0.9,
      });
    });

    expect(onViewportChange).not.toHaveBeenCalled();
  });

  it('does not recommit a stale local viewport after an external viewport refresh', () => {
    const terminal = createPlaceholderTerminal(0);
    const onViewportChange = vi.fn();
    const initialViewport = {
      x: -120,
      y: 48,
      zoom: 0.9,
    };
    const locallyCommittedViewport = {
      x: -40,
      y: 48,
      zoom: 0.9,
    };
    const externallyRefreshedViewport = {
      x: -260,
      y: 48,
      zoom: 0.9,
    };
    const workspace = {
      ...createDefaultWorkspace(),
      terminals: [terminal],
      currentViewport: initialViewport,
    };

    act(() => {
      root.render(
        createElement(WorkspaceCanvas, createCanvasProps({
          workspace,
          onViewportChange,
        })),
      );
    });

    act(() => {
      latestReactFlowProps?.onMoveStart?.(
        new MouseEvent('mousedown'),
        initialViewport,
      );
      latestReactFlowProps?.onMoveEnd?.(
        new MouseEvent('mouseup'),
        locallyCommittedViewport,
      );
    });

    expect(onViewportChange).toHaveBeenCalledTimes(1);
    expect(onViewportChange).toHaveBeenLastCalledWith(locallyCommittedViewport);

    act(() => {
      root.render(
        createElement(WorkspaceCanvas, createCanvasProps({
          workspace: {
            ...workspace,
            updatedAt: '2026-03-22T15:00:00.000Z',
            currentViewport: externallyRefreshedViewport,
          },
          onViewportChange,
        })),
      );
    });

    act(() => {
      latestReactFlowProps?.onMoveStart?.(
        new Event('synthetic') as unknown as MouseEvent,
        locallyCommittedViewport,
      );
      latestReactFlowProps?.onMoveEnd?.(
        new Event('synthetic') as unknown as MouseEvent,
        locallyCommittedViewport,
      );
    });

    expect(onViewportChange).toHaveBeenCalledTimes(1);
  });

  it('commits user-initiated move callbacks when the viewport changes', () => {
    const terminal = createPlaceholderTerminal(0);
    const onViewportChange = vi.fn();
    const initialViewport = {
      x: -120,
      y: 48,
      zoom: 0.9,
    };
    const nextViewport = {
      x: -40,
      y: 48,
      zoom: 0.9,
    };
    const workspace = {
      ...createDefaultWorkspace(),
      terminals: [terminal],
      currentViewport: initialViewport,
    };

    act(() => {
      root.render(
        createElement(WorkspaceCanvas, createCanvasProps({
          workspace,
          onViewportChange,
        })),
      );
    });

    act(() => {
      latestReactFlowProps?.onMoveStart?.(new MouseEvent('mousedown'), initialViewport);
    });

    act(() => {
      latestReactFlowProps?.onMoveEnd?.(new MouseEvent('mouseup'), nextViewport);
    });

    expect(onViewportChange).toHaveBeenCalledWith(nextViewport);
  });

  it('debounces layout recomputation on node interaction updates', () => {
    vi.useFakeTimers();
    try {
      const terminal = createPlaceholderTerminal(0);
      const workspace = {
        ...createDefaultWorkspace(),
        terminals: [terminal],
      };
      const mockedGetLayoutStrategy = vi.mocked(getLayoutStrategy);

      act(() => {
        root.render(
          createElement(WorkspaceCanvas, createCanvasProps({
            workspace,
            nodeInteractionAtMs: {
              [terminal.id]: 100,
            },
          })),
        );
      });

      const callsAfterInitialRender = mockedGetLayoutStrategy.mock.calls.length;

      act(() => {
        root.render(
          createElement(WorkspaceCanvas, createCanvasProps({
            workspace: {
              ...workspace,
              updatedAt: '2026-03-23T13:00:00.000Z',
            },
            nodeInteractionAtMs: {
              [terminal.id]: 150,
            },
          })),
        );
      });

      expect(mockedGetLayoutStrategy.mock.calls.length).toBe(callsAfterInitialRender);

      act(() => {
        vi.advanceTimersByTime(120);
      });

      expect(mockedGetLayoutStrategy.mock.calls.length).toBe(callsAfterInitialRender + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

function createCanvasProps(
  overrides: Partial<ComponentProps<typeof WorkspaceCanvas>>,
): ComponentProps<typeof WorkspaceCanvas> {
  const workspace = overrides.workspace ?? createDefaultWorkspace();

  return {
    workspace,
    selectedNodeId: overrides.selectedNodeId ?? null,
    nodeInteractionAtMs: overrides.nodeInteractionAtMs ?? {},
    sessions: overrides.sessions ?? {},
    markdownDocuments: overrides.markdownDocuments ?? {},
    markdownLinks: overrides.markdownLinks ?? [],
    socketState: overrides.socketState ?? 'open',
    onTerminalInput: overrides.onTerminalInput ?? vi.fn(),
    onTerminalResize: overrides.onTerminalResize ?? vi.fn(),
    onTerminalRestart: overrides.onTerminalRestart ?? vi.fn(),
    onTerminalChange: overrides.onTerminalChange ?? vi.fn(),
    onPathSelectRequest: overrides.onPathSelectRequest ?? vi.fn(),
    onTerminalRemove: overrides.onTerminalRemove ?? vi.fn(),
    onMarkTerminalRead: overrides.onMarkTerminalRead ?? vi.fn(),
    onMarkdownDrop: overrides.onMarkdownDrop ?? vi.fn(),
    onMarkdownFocusRequest: overrides.onMarkdownFocusRequest ?? vi.fn(),
    onMarkdownRemove: overrides.onMarkdownRemove ?? vi.fn(),
    onSelectedNodeChange: overrides.onSelectedNodeChange ?? vi.fn(),
    onTerminalFocusRequest: overrides.onTerminalFocusRequest ?? vi.fn(),
    onNodeBoundsChange: overrides.onNodeBoundsChange ?? vi.fn(),
    onViewportChange: overrides.onViewportChange ?? vi.fn(),
    onViewportSizeChange: overrides.onViewportSizeChange ?? vi.fn(),
    focusAutoFocusAtMs: overrides.focusAutoFocusAtMs ?? null,
    onDocumentLoad: overrides.onDocumentLoad ?? vi.fn(),
    onDocumentChange: overrides.onDocumentChange ?? vi.fn(),
    onDocumentSave: overrides.onDocumentSave ?? vi.fn(),
    onResolveConflict: overrides.onResolveConflict ?? vi.fn(),
  };
}

function createSessionSnapshot(sessionId: string): TerminalSessionSnapshot {
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
    lastOutputLine: 'line',
    previewLines: ['line'],
    scrollback: 'line',
    unreadCount: 0,
    summary: 'running',
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
  };
}

function expectNodePosition(nodeId: string): { x: number; y: number } {
  const node = latestReactFlowProps?.nodes.find((candidate) => candidate.id === nodeId);

  expect(node?.position).toBeDefined();
  return node!.position!;
}

function expectTerminalNodeData(nodeId: string): Record<string, unknown> {
  const node = latestReactFlowProps?.nodes.find((candidate) => candidate.id === nodeId);

  expect(node).toBeDefined();
  expect(node?.type).toBe('terminal');
  expect(node?.data).toBeTruthy();

  return node!.data as Record<string, unknown>;
}
