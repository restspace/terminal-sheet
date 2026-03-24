import { useCallback, useEffect, useRef, useState } from 'react';

import type { BackendStatus } from '../../shared/backends';
import { fetchWithFrontendLease } from './frontendLeaseClient';

export interface BackendEntry {
  id: string;
  label: string;
  baseUrl: string;
  enabled: boolean;
  status: BackendStatus | null;
}

export interface TokenInfo {
  tokenPreview: string;
  serverId: string;
}

export interface UseBackendsResult {
  backends: BackendEntry[];
  tokenInfo: TokenInfo | null;
  isLoading: boolean;
  error: string | null;
  addBackend: (label: string, baseUrl: string, token: string) => Promise<void>;
  removeBackend: (backendId: string) => Promise<void>;
  rotateBackendToken: (backendId: string) => Promise<void>;
  rotateLocalToken: () => Promise<void>;
  setupSshBackend: (input: {
    label: string;
    sshTarget: string;
    sshPort?: number;
    sshIdentityFile?: string;
    remotePort: number;
    tokenMode: 'install-output' | 'manual' | 'file';
    token?: string;
    tokenPath?: string;
    runInstall: boolean;
  }) => Promise<string | null>;
  refresh: () => void;
}

export function useBackends(isActive: boolean): UseBackendsResult {
  const [backends, setBackends] = useState<BackendEntry[]>([]);
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const fetchBackends = useCallback(async () => {
    try {
      const [backendsResponse, tokenResponse] = await Promise.all([
        fetchWithFrontendLease('/api/backends'),
        fetchWithFrontendLease('/api/token/info'),
      ]);

      if (!isMountedRef.current) {
        return;
      }

      if (backendsResponse.ok) {
        const data = (await backendsResponse.json()) as {
          backends?: Array<{
            id: string;
            label: string;
            baseUrl: string;
            enabled: boolean;
            status: BackendStatus | null;
          }>;
        };
        setBackends(data.backends ?? []);
        setError(null);
      } else {
        setError(`Failed to load backends (${backendsResponse.status})`);
      }

      if (tokenResponse.ok) {
        const tokenData = (await tokenResponse.json()) as TokenInfo;
        setTokenInfo(tokenData);
      }
    } catch (err) {
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load backends');
      }
    }
  }, []);

  const refresh = useCallback(() => {
    void fetchBackends();
  }, [fetchBackends]);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    const loadInitial = async () => {
      setIsLoading(true);
      try {
        await fetchBackends();
      } finally {
        if (isMountedRef.current) {
          setIsLoading(false);
        }
      }
    };

    void loadInitial();

    const intervalId = setInterval(() => {
      void fetchBackends();
    }, 5_000);

    return () => {
      clearInterval(intervalId);
    };
  }, [isActive, fetchBackends]);

  const addBackend = useCallback(
    async (label: string, baseUrl: string, token: string): Promise<void> => {
      const response = await fetchWithFrontendLease('/api/backends', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, baseUrl, token }),
      });

      if (!response.ok) {
        const data = (await response.json()) as { message?: string };
        throw new Error(data.message ?? `Server error ${response.status}`);
      }

      void fetchBackends();
    },
    [fetchBackends],
  );

  const removeBackend = useCallback(
    async (backendId: string): Promise<void> => {
      const response = await fetchWithFrontendLease(
        `/api/backends/${encodeURIComponent(backendId)}`,
        { method: 'DELETE' },
      );

      if (!response.ok) {
        const data = (await response.json()) as { message?: string };
        throw new Error(data.message ?? `Server error ${response.status}`);
      }

      void fetchBackends();
    },
    [fetchBackends],
  );

  const rotateBackendToken = useCallback(
    async (backendId: string): Promise<void> => {
      const response = await fetchWithFrontendLease(
        `/api/backends/${encodeURIComponent(backendId)}/rotate-token`,
        { method: 'POST' },
      );

      if (!response.ok) {
        const data = (await response.json()) as { message?: string };
        throw new Error(data.message ?? `Server error ${response.status}`);
      }

      void fetchBackends();
    },
    [fetchBackends],
  );

  const rotateLocalToken = useCallback(async (): Promise<void> => {
    const response = await fetchWithFrontendLease('/api/token/rotate', {
      method: 'POST',
    });

    if (!response.ok) {
      const data = (await response.json()) as { message?: string };
      throw new Error(data.message ?? `Server error ${response.status}`);
    }

    const data = (await response.json()) as TokenInfo;

    if (isMountedRef.current) {
      setTokenInfo(data);
    }
  }, []);

  const setupSshBackend = useCallback(
    async (input: {
      label: string;
      sshTarget: string;
      sshPort?: number;
      sshIdentityFile?: string;
      remotePort: number;
      tokenMode: 'install-output' | 'manual' | 'file';
      token?: string;
      tokenPath?: string;
      runInstall: boolean;
    }): Promise<string | null> => {
      const response = await fetchWithFrontendLease('/api/backends/ssh/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });

      if (!response.ok) {
        const data = (await response.json()) as { message?: string };
        throw new Error(data.message ?? `Server error ${response.status}`);
      }

      const payload = (await response.json()) as {
        backend?: {
          id?: string;
        };
      };
      const backendId =
        payload.backend && typeof payload.backend.id === 'string'
          ? payload.backend.id
          : null;

      await fetchBackends();
      return backendId;
    },
    [fetchBackends],
  );

  return {
    backends,
    tokenInfo,
    isLoading,
    error,
    addBackend,
    removeBackend,
    rotateBackendToken,
    rotateLocalToken,
    setupSshBackend,
    refresh,
  };
}
