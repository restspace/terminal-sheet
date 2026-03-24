/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FRONTEND_ID_STORAGE_KEY,
  FRONTEND_LEASE_EPOCH_STORAGE_KEY,
  FRONTEND_LEASE_TOKEN_STORAGE_KEY,
  releaseFrontendLease,
} from './frontendLeaseClient';

describe('frontendLeaseClient releaseFrontendLease', () => {
  beforeEach(() => {
    window.sessionStorage.setItem(FRONTEND_ID_STORAGE_KEY, 'frontend-1');
    window.sessionStorage.setItem(FRONTEND_LEASE_TOKEN_STORAGE_KEY, 'lease-1');
    window.sessionStorage.setItem(FRONTEND_LEASE_EPOCH_STORAGE_KEY, '1');
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
  });

  it('falls back to keepalive fetch when sendBeacon returns false', async () => {
    let resolveFetch: ((response: Response) => void) | null = null;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    Object.defineProperty(window.navigator, 'sendBeacon', {
      configurable: true,
      value: vi.fn(() => false),
    });
    vi.stubGlobal('fetch', fetchMock);

    const releasePromise = releaseFrontendLease();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/frontend-session/release',
      expect.objectContaining({
        method: 'POST',
        keepalive: true,
      }),
    );
    expect(window.sessionStorage.getItem(FRONTEND_LEASE_TOKEN_STORAGE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(FRONTEND_LEASE_EPOCH_STORAGE_KEY)).toBeNull();

    expect(resolveFetch).not.toBeNull();
    resolveFetch!(new Response('', { status: 200 }));
    await expect(releasePromise).resolves.toBe(true);
  });

  it('keeps the stored lease when the fetch fallback cannot be dispatched', async () => {
    Object.defineProperty(window.navigator, 'sendBeacon', {
      configurable: true,
      value: vi.fn(() => false),
    });
    vi.stubGlobal('fetch', vi.fn(() => {
      throw new Error('dispatch failed');
    }));

    await expect(releaseFrontendLease()).resolves.toBe(false);
    expect(window.sessionStorage.getItem(FRONTEND_LEASE_TOKEN_STORAGE_KEY)).toBe(
      'lease-1',
    );
    expect(window.sessionStorage.getItem(FRONTEND_LEASE_EPOCH_STORAGE_KEY)).toBe(
      '1',
    );
  });
});
