/** @vitest-environment jsdom */

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRONTEND_ID_HEADER } from '../../shared/frontendSessionTransport';

import {
  createDefaultWorkspace,
  type Workspace,
} from '../../shared/workspace';
import { WORKSPACE_BASE_UPDATED_AT_HEADER } from '../../shared/workspaceTransport';
import { useWorkspace } from './useWorkspace';

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let latestState: ReturnType<typeof useWorkspace> | null = null;

describe('useWorkspace', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    latestState = null;
    window.sessionStorage.clear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });

    latestState = null;
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = '';
    window.sessionStorage.clear();
  });

  it('optimistically applies viewport mutations before autosave and then adopts the saved workspace', async () => {
    const initialWorkspace = createWorkspace({
      updatedAt: '2026-03-22T18:00:00.000Z',
    });
    const savedWorkspace = {
      ...initialWorkspace,
      updatedAt: '2026-03-22T18:00:05.000Z',
      currentViewport: {
        x: 120,
        y: 24,
        zoom: 0.9,
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === '/api/workspace' && !init?.method) {
        return jsonResponse(initialWorkspace);
      }

      if (url === '/api/workspace/mutations' && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body)) as {
          commands: unknown[];
        };
        const headers = new Headers(init.headers);

        expect(headers.get('Content-Type')).toBe('application/json');
        expect(headers.get(WORKSPACE_BASE_UPDATED_AT_HEADER)).toBe(
          initialWorkspace.updatedAt,
        );
        expect(headers.get(FRONTEND_ID_HEADER)).toBeTruthy();
        expect(payload).toEqual({
          commands: [
            {
              type: 'set-viewport',
              viewport: {
                x: 120,
                y: 24,
                zoom: 0.9,
              },
            },
          ],
        });

        return jsonResponse(savedWorkspace);
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    act(() => {
      root.render(createElement(Harness));
    });
    await act(async () => {
      await settle();
    });

    expect(latestState?.workspace).toEqual(initialWorkspace);

    act(() => {
      latestState?.setViewport(
        {
          x: 120,
          y: 24,
          zoom: 0.9,
        },
        { debugSource: 'test.optimisticUpdate' },
      );
    });

    expect(latestState?.workspace?.currentViewport).toEqual({
      x: 120,
      y: 24,
      zoom: 0.9,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(449);
      await settle();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await settle();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latestState?.workspace).toEqual(savedWorkspace);
    expect(latestState?.persistence).toMatchObject({
      phase: 'saved',
      lastSavedAt: savedWorkspace.updatedAt,
    });
  });

  it('replaces a stale local workspace with the server workspace when a mutation batch conflicts', async () => {
    const initialWorkspace = createWorkspace({
      updatedAt: '2026-03-22T18:10:00.000Z',
    });
    const serverWorkspace = {
      ...initialWorkspace,
      updatedAt: '2026-03-22T18:10:05.000Z',
      layoutMode: 'focus-tiles' as const,
      currentViewport: {
        x: -320,
        y: 180,
        zoom: 1.1,
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === '/api/workspace' && !init?.method) {
        return jsonResponse(initialWorkspace);
      }

      if (url === '/api/workspace/mutations' && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body)) as {
          commands: unknown[];
        };
        const headers = new Headers(init.headers);

        expect(headers.get('Content-Type')).toBe('application/json');
        expect(headers.get(WORKSPACE_BASE_UPDATED_AT_HEADER)).toBe(
          initialWorkspace.updatedAt,
        );
        expect(headers.get(FRONTEND_ID_HEADER)).toBeTruthy();
        expect(payload).toEqual({
          commands: [
            {
              type: 'set-viewport',
              viewport: {
                x: 320,
                y: -24,
                zoom: 0.82,
              },
            },
          ],
        });

        return jsonResponse(
          {
            message: 'Workspace state is out of date.',
            workspace: serverWorkspace,
          },
          409,
        );
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    act(() => {
      root.render(createElement(Harness));
    });
    await act(async () => {
      await settle();
    });

    act(() => {
      latestState?.setViewport(
        {
          x: 320,
          y: -24,
          zoom: 0.82,
        },
        { debugSource: 'test.conflict' },
      );
    });

    expect(latestState?.workspace?.currentViewport).toEqual({
      x: 320,
      y: -24,
      zoom: 0.82,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(449);
      await settle();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await settle();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latestState?.workspace).toEqual(serverWorkspace);
    expect(latestState?.persistence).toMatchObject({
      phase: 'saved',
      lastSavedAt: serverWorkspace.updatedAt,
    });
  });

  it('applies newer workspace snapshots and ignores stale ones from the server', async () => {
    const initialWorkspace = createWorkspace({
      updatedAt: '2026-03-22T18:20:00.000Z',
    });
    const newerWorkspace = {
      ...initialWorkspace,
      updatedAt: '2026-03-22T18:20:05.000Z',
      currentViewport: {
        x: 140,
        y: -60,
        zoom: 1.05,
      },
    };
    const staleWorkspace = {
      ...initialWorkspace,
      updatedAt: '2026-03-22T18:19:59.000Z',
      currentViewport: {
        x: -500,
        y: 10,
        zoom: 0.7,
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/workspace') {
        return jsonResponse(initialWorkspace);
      }

      throw new Error(`Unexpected fetch call: ${String(input)}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    act(() => {
      root.render(createElement(Harness));
    });
    await act(async () => {
      await settle();
    });

    await act(async () => {
      const accepted = await latestState!.refreshWorkspaceFromServer(newerWorkspace);
      expect(accepted).toBe(true);
      await settle();
    });

    expect(latestState?.workspace).toEqual(newerWorkspace);

    await act(async () => {
      const ignored = await latestState!.refreshWorkspaceFromServer(staleWorkspace);
      expect(ignored).toBe(true);
      await settle();
    });

    expect(latestState?.workspace).toEqual(newerWorkspace);
  });
});

function Harness() {
  latestState = useWorkspace();
  return createElement('div');
}

function createWorkspace(overrides: Partial<Workspace>): Workspace {
  return {
    ...createDefaultWorkspace(),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
