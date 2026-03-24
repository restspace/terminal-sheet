/** @vitest-environment jsdom */

import { createElement, useEffect } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FrontendSessionLease,
  FrontendSessionLockedResponse,
} from '../../shared/frontendSessionTransport';
import { FrontendLeaseLockedError } from './frontendLeaseClient';
import { useFrontendLease } from './useFrontendLease';

const frontendLeaseClientMocks = vi.hoisted(() => ({
  acquireFrontendLease: vi.fn(),
  fetchFrontendSessionStatus: vi.fn(),
  releaseFrontendLease: vi.fn(),
  subscribeToFrontendLeaseConflicts: vi.fn(),
}));

vi.mock('./frontendLeaseClient', () => {
  class FrontendLeaseLockedError extends Error {
    constructor(readonly lock: unknown) {
      super('Frontend lease is currently held by another browser.');
      this.name = 'FrontendLeaseLockedError';
    }
  }

  return {
    ...frontendLeaseClientMocks,
    FrontendLeaseLockedError,
  };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let latestState: ReturnType<typeof useFrontendLease> | null = null;

describe('useFrontendLease', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    latestState = null;
    frontendLeaseClientMocks.acquireFrontendLease.mockResolvedValue(
      createLease(),
    );
    frontendLeaseClientMocks.fetchFrontendSessionStatus.mockResolvedValue({
      state: 'locked',
      owner: createLeaseOwner(),
    });
    frontendLeaseClientMocks.releaseFrontendLease.mockResolvedValue(true);
    frontendLeaseClientMocks.subscribeToFrontendLeaseConflicts.mockImplementation(
      () => () => {},
    );
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });

    latestState = null;
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    vi.useRealTimers();
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('releases the active frontend lease during page exit events', async () => {
    act(() => {
      root.render(createElement(Harness));
    });
    await act(async () => {
      await settle();
    });

    expect(latestState?.phase).toBe('active');

    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      await settle();
    });
    await act(async () => {
      window.dispatchEvent(new Event('beforeunload'));
      await settle();
    });

    expect(frontendLeaseClientMocks.releaseFrontendLease).toHaveBeenCalledTimes(
      2,
    );
  });

  it('polls immediately after becoming locked and then backs off between retries', async () => {
    frontendLeaseClientMocks.acquireFrontendLease.mockRejectedValue(
      new FrontendLeaseLockedError(createLockedResponse()),
    );

    act(() => {
      root.render(createElement(Harness));
    });
    await act(async () => {
      await settle();
    });

    expect(latestState?.phase).toBe('locked');
    expect(frontendLeaseClientMocks.fetchFrontendSessionStatus).toHaveBeenCalledTimes(
      1,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
      await settle();
    });
    expect(frontendLeaseClientMocks.fetchFrontendSessionStatus).toHaveBeenCalledTimes(
      1,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await settle();
    });
    expect(frontendLeaseClientMocks.fetchFrontendSessionStatus).toHaveBeenCalledTimes(
      2,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
      await settle();
    });
    expect(frontendLeaseClientMocks.fetchFrontendSessionStatus).toHaveBeenCalledTimes(
      3,
    );
  });
});

function Harness() {
  const state = useFrontendLease();
  useEffect(() => {
    latestState = state;
  }, [state]);
  return createElement('div');
}

function createLease(): FrontendSessionLease {
  return {
    ...createLeaseOwner(),
    leaseToken: 'lease-1',
  };
}

function createLeaseOwner() {
  return {
    frontendId: 'frontend-1',
    ownerLabel: 'Desk A',
    leaseEpoch: 1,
    acquiredAt: '2026-03-24T17:00:00.000Z',
    lastSeenAt: '2026-03-24T17:00:01.000Z',
    expiresAt: '2026-03-24T17:00:12.000Z',
  };
}

function createLockedResponse(): FrontendSessionLockedResponse {
  return {
    message: 'Frontend lease is currently held by another browser.',
    owner: createLeaseOwner(),
    canTakeOver: true,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
