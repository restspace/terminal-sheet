import { useCallback, useEffect, useState } from 'react';

import type {
  FrontendSessionLease,
  FrontendSessionLockedResponse,
  FrontendSessionStatusResponse,
} from '../../shared/frontendSessionTransport';
import {
  acquireFrontendLease,
  fetchFrontendSessionStatus,
  FrontendLeaseLockedError,
  releaseFrontendLease,
  subscribeToFrontendLeaseConflicts,
} from './frontendLeaseClient';

export interface FrontendLeaseController {
  phase: 'acquiring' | 'active' | 'locked' | 'error';
  lease: FrontendSessionLease | null;
  lock: FrontendSessionLockedResponse | null;
  error: string | null;
  retryAcquire: () => Promise<void>;
  takeOverLease: () => Promise<void>;
}

const LOCKED_STATUS_POLL_INITIAL_DELAY_MS = 1_000;
const LOCKED_STATUS_POLL_MAX_DELAY_MS = 8_000;

export function useFrontendLease(): FrontendLeaseController {
  const [phase, setPhase] =
    useState<FrontendLeaseController['phase']>('acquiring');
  const [lease, setLease] = useState<FrontendSessionLease | null>(null);
  const [lock, setLock] = useState<FrontendSessionLockedResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const attemptAcquire = useCallback(
    async (options?: { takeover?: boolean }): Promise<void> => {
      setPhase('acquiring');
      setError(null);

      try {
        const nextLease = await acquireFrontendLease(options);
        setLease(nextLease);
        setLock(null);
        setPhase('active');
      } catch (acquireError) {
        if (acquireError instanceof FrontendLeaseLockedError) {
          setLease(null);
          setLock(acquireError.lock);
          setPhase('locked');
          return;
        }

        setLease(null);
        setLock(null);
        setError(
          acquireError instanceof Error
            ? acquireError.message
            : 'Failed to acquire the frontend lease.',
        );
        setPhase('error');
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;

    queueMicrotask(() => {
      if (!cancelled) {
        void attemptAcquire();
      }
    });

    return () => {
      cancelled = true;
    };
  }, [attemptAcquire]);

  useEffect(() => {
    return subscribeToFrontendLeaseConflicts((nextLock) => {
      setLease(null);
      setLock(nextLock);
      setError(null);
      setPhase('locked');
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handlePageExit = () => {
      void releaseFrontendLease();
    };

    window.addEventListener('pagehide', handlePageExit);
    window.addEventListener('beforeunload', handlePageExit);

    return () => {
      window.removeEventListener('pagehide', handlePageExit);
      window.removeEventListener('beforeunload', handlePageExit);
    };
  }, []);

  useEffect(() => {
    if (phase !== 'locked') {
      return;
    }

    let cancelled = false;
    let timeoutId: number | null = null;
    let nextDelayMs = LOCKED_STATUS_POLL_INITIAL_DELAY_MS;

    const pollStatus = async () => {
      try {
        const status = await fetchFrontendSessionStatus();

        if (cancelled) {
          return;
        }

        if (status.state === 'available' || status.state === 'owned') {
          void attemptAcquire();
          return;
        }

        setLock(buildLockedResponse(status));
      } catch (statusError) {
        if (!cancelled) {
          setError(
            statusError instanceof Error
              ? statusError.message
              : 'Failed to refresh the frontend lease status.',
          );
        }
      }

      if (cancelled) {
        return;
      }

      timeoutId = window.setTimeout(() => {
        void pollStatus();
      }, nextDelayMs);
      nextDelayMs = Math.min(
        LOCKED_STATUS_POLL_MAX_DELAY_MS,
        nextDelayMs * 2,
      );
    };

    void pollStatus();

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [attemptAcquire, phase]);

  return {
    phase,
    lease,
    lock,
    error,
    retryAcquire: useCallback(async () => {
      await attemptAcquire();
    }, [attemptAcquire]),
    takeOverLease: useCallback(async () => {
      await attemptAcquire({ takeover: true });
    }, [attemptAcquire]),
  };
}

function buildLockedResponse(
  status: FrontendSessionStatusResponse,
): FrontendSessionLockedResponse {
  return {
    message: 'Frontend lease is currently held by another browser.',
    owner: status.owner,
    canTakeOver: status.owner !== null,
  };
}
