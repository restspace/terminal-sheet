/** @vitest-environment jsdom */

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FrontendSessionLockedResponse } from '../../shared/frontendSessionTransport';
import {
  FRONTEND_ID_STORAGE_KEY,
  FRONTEND_LEASE_TOKEN_STORAGE_KEY,
  subscribeToFrontendLeaseConflicts,
} from './frontendLeaseClient';
import { useWorkspaceSocket } from './useWorkspaceSocket';

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let latestState: ReturnType<typeof useWorkspaceSocket> | null = null;

describe('useWorkspaceSocket', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalWebSocket: typeof WebSocket | undefined;

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    latestState = null;
    FakeWebSocket.instances = [];
    originalWebSocket = globalThis.WebSocket;
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    window.sessionStorage.setItem(FRONTEND_ID_STORAGE_KEY, 'frontend-1');
    window.sessionStorage.setItem(FRONTEND_LEASE_TOKEN_STORAGE_KEY, 'lease-1');
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });

    latestState = null;
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    if (originalWebSocket) {
      vi.stubGlobal('WebSocket', originalWebSocket);
    }
    document.body.innerHTML = '';
    window.sessionStorage.clear();
  });

  it('connects with the stored lease in the websocket URL and sends heartbeats', async () => {
    act(() => {
      root.render(createElement(Harness));
    });

    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();
    expect(socket?.url).toContain('frontendId=frontend-1');
    expect(socket?.url).toContain('leaseToken=lease-1');

    act(() => {
      socket?.open();
    });

    expect(latestState?.socketState).toBe('open');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
      await settle();
    });

    expect(socket?.sent).toHaveLength(1);
    expect(JSON.parse(socket?.sent[0] ?? '{}')).toMatchObject({
      type: 'frontend.heartbeat',
    });
  });

  it('reports lease conflicts and suppresses reconnect after a locked message', async () => {
    const conflicts: FrontendSessionLockedResponse[] = [];
    const unsubscribe = subscribeToFrontendLeaseConflicts((lock) => {
      conflicts.push(lock);
    });

    act(() => {
      root.render(createElement(Harness));
    });

    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();

    act(() => {
      socket?.open();
      socket?.emitMessage({
        type: 'frontend.locked',
        lock: createLockedResponse(),
      });
    });
    await act(async () => {
      await settle();
    });

    expect(conflicts).toEqual([createLockedResponse()]);
    expect(window.sessionStorage.getItem(FRONTEND_LEASE_TOKEN_STORAGE_KEY)).toBeNull();
    expect(latestState?.socketState).toBe('closed');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await settle();
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    unsubscribe();
  });
});

function Harness() {
  latestState = useWorkspaceSocket({
    onMessage: vi.fn(),
  });

  return createElement('div');
}

function createLockedResponse(): FrontendSessionLockedResponse {
  return {
    message: 'Frontend lease is currently held by another browser.',
    canTakeOver: true,
    owner: {
      frontendId: 'frontend-2',
      ownerLabel: 'Desk B',
      leaseEpoch: 2,
      acquiredAt: '2026-03-24T17:00:00.000Z',
      lastSeenAt: '2026-03-24T17:00:01.000Z',
      expiresAt: '2026-03-24T17:00:12.000Z',
    },
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  emitMessage(payload: unknown): void {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify(payload),
      }),
    );
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) {
      return;
    }

    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(
      new CloseEvent('close', {
        code,
        reason,
      }),
    );
  }
}
