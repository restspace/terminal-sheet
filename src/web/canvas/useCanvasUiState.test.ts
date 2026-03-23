/** @vitest-environment jsdom */

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createDefaultWorkspace,
  createPlaceholderTerminal,
  type Workspace,
} from '../../shared/workspace';
import { useCanvasUiState } from './useCanvasUiState';

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let latestState: ReturnType<typeof useCanvasUiState> | null = null;

describe('useCanvasUiState', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    latestState = null;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    latestState = null;
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    document.body.innerHTML = '';
  });

  it('starts without a persisted selection and keeps local selection across workspace refreshes', () => {
    const firstTerminal = createPlaceholderTerminal(0);
    const secondTerminal = createPlaceholderTerminal(1);
    const workspace = createWorkspace({
      terminals: [firstTerminal, secondTerminal],
    });

    act(() => {
      root.render(createElement(Harness, { workspace }));
    });

    expect(latestState?.isSelectionHydrated).toBe(true);
    expect(latestState?.selectedNodeId).toBeNull();

    act(() => {
      latestState?.setSelectedNodeId(secondTerminal.id);
    });

    expect(latestState?.selectedNodeId).toBe(secondTerminal.id);

    act(() => {
      root.render(
        createElement(Harness, {
          workspace: {
            ...workspace,
            updatedAt: '2026-03-22T18:05:00.000Z',
          },
        }),
      );
    });

    expect(latestState?.selectedNodeId).toBe(secondTerminal.id);

    act(() => {
      root.render(
        createElement(Harness, {
          workspace: {
            ...workspace,
            id: 'workspace-next',
            updatedAt: '2026-03-22T18:05:30.000Z',
          },
        }),
      );
    });

    expect(latestState?.selectedNodeId).toBeNull();
  });

  it('clears local selection when the selected node disappears', () => {
    const firstTerminal = createPlaceholderTerminal(0);
    const secondTerminal = createPlaceholderTerminal(1);
    const workspace = createWorkspace({
      terminals: [firstTerminal, secondTerminal],
    });

    act(() => {
      root.render(createElement(Harness, { workspace }));
    });

    act(() => {
      latestState?.setSelectedNodeId(secondTerminal.id);
    });

    expect(latestState?.selectedNodeId).toBe(secondTerminal.id);

    act(() => {
      root.render(
        createElement(Harness, {
          workspace: {
            ...workspace,
            terminals: [firstTerminal],
            updatedAt: '2026-03-22T18:06:00.000Z',
          },
        }),
      );
    });

    expect(latestState?.selectedNodeId).toBeNull();
  });

  it('prunes node interaction state when nodes disappear', () => {
    const firstTerminal = createPlaceholderTerminal(0);
    const secondTerminal = createPlaceholderTerminal(1);
    const workspace = createWorkspace({
      terminals: [firstTerminal, secondTerminal],
    });

    act(() => {
      root.render(createElement(Harness, { workspace }));
    });

    act(() => {
      latestState?.bumpNodeInteraction(firstTerminal.id);
      latestState?.bumpNodeInteraction(secondTerminal.id);
    });

    expect(Object.keys(latestState?.nodeInteractionAtMs ?? {})).toHaveLength(2);

    act(() => {
      root.render(
        createElement(Harness, {
          workspace: {
            ...workspace,
            terminals: [firstTerminal],
            updatedAt: '2026-03-22T18:07:00.000Z',
          },
        }),
      );
    });

    expect(latestState?.nodeInteractionAtMs[firstTerminal.id]).toBeTypeOf(
      'number',
    );
    expect(latestState?.nodeInteractionAtMs[secondTerminal.id]).toBeUndefined();
  });
});

function Harness({ workspace }: { workspace: Workspace | null }) {
  latestState = useCanvasUiState(workspace);
  return createElement('div');
}

function createWorkspace(
  overrides: Partial<Workspace>,
): Workspace {
  return {
    ...createDefaultWorkspace(),
    ...overrides,
  };
}
