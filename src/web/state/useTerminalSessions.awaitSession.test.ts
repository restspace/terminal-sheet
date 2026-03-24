/** @vitest-environment jsdom */

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FRONTEND_ID_HEADER,
  FRONTEND_LEASE_TOKEN_HEADER,
} from '../../shared/frontendSessionTransport';

import { createDefaultWorkspace } from '../../shared/workspace';
import {
  FRONTEND_ID_STORAGE_KEY,
  FRONTEND_LEASE_TOKEN_STORAGE_KEY,
} from './frontendLeaseClient';
import { useTerminalSessions } from './useTerminalSessions';

vi.mock('./useSessionStore', () => ({
  useSessionStore: () => ({
    sessions: {},
    handleSessionMessage: vi.fn(),
    mergeFetchedSnapshots: vi.fn(),
  }),
  applyServerMessage: vi.fn(),
  mergeSessionSnapshots: vi.fn(),
}));

vi.mock('./useMarkdownRealtime', () => ({
  useMarkdownRealtime: () => ({
    markdownDocuments: {},
    markdownLinks: [],
    handleMarkdownMessage: vi.fn(),
  }),
}));

vi.mock('./useAttentionStore', () => ({
  useAttentionStore: () => ({
    attentionEvents: [],
    handleAttentionMessage: vi.fn(),
  }),
  applyAttentionMessage: vi.fn(),
}));

vi.mock('./useWorkspaceRealtime', () => ({
  useWorkspaceRealtime: () => ({
    handleWorkspaceMessage: vi.fn(),
  }),
  applyWorkspaceMessage: vi.fn(),
}));

vi.mock('./useWorkspaceSocket', () => ({
  useWorkspaceSocket: () => ({
    socketState: mockSocketState,
    send: vi.fn(),
  }),
  shouldPollSnapshots: vi.fn((state: string) => state !== 'open'),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let latestState: ReturnType<typeof useTerminalSessions> | null = null;
let mockSocketState: 'open' | 'closed' = 'open';

describe('useTerminalSessions awaitSession', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    mockSocketState = 'open';
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
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('replaces prior polling timers when awaiting the same session repeatedly', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        sessions: [],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    act(() => {
      root.render(createElement(Harness));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await settle();
    });

    fetchMock.mockClear();

    act(() => {
      latestState!.awaitSession('session-1');
      latestState!.awaitSession('session-1');
    });
    await act(async () => {
      await settle();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await settle();
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps the current frontend lease headers on polling fallback requests', async () => {
    mockSocketState = 'closed';
    window.sessionStorage.setItem(FRONTEND_ID_STORAGE_KEY, 'frontend-1');
    window.sessionStorage.setItem(FRONTEND_LEASE_TOKEN_STORAGE_KEY, 'lease-1');

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        sessions: [],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    act(() => {
      root.render(createElement(Harness));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await settle();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [firstUrl, firstInit] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit | undefined,
    ];
    void firstUrl;
    expect(new Headers(firstInit?.headers).get(FRONTEND_ID_HEADER)).toBe(
      'frontend-1',
    );
    expect(
      new Headers(firstInit?.headers).get(FRONTEND_LEASE_TOKEN_HEADER),
    ).toBe('lease-1');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
      await settle();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [secondUrl, secondInit] = fetchMock.mock.calls[1] as unknown as [
      RequestInfo | URL,
      RequestInit | undefined,
    ];
    void secondUrl;
    expect(new Headers(secondInit?.headers).get(FRONTEND_ID_HEADER)).toBe(
      'frontend-1',
    );
    expect(
      new Headers(secondInit?.headers).get(FRONTEND_LEASE_TOKEN_HEADER),
    ).toBe('lease-1');
  });
});

function Harness() {
  latestState = useTerminalSessions({
    workspace: createDefaultWorkspace(),
    refreshWorkspaceFromServer: vi.fn(async () => true),
  });
  return createElement('div');
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
