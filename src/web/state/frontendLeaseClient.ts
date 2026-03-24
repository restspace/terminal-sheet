import {
  FRONTEND_ID_HEADER,
  FRONTEND_ID_QUERY_PARAM,
  FRONTEND_LEASE_TOKEN_HEADER,
  FRONTEND_LEASE_TOKEN_QUERY_PARAM,
  frontendSessionLeaseSchema,
  frontendSessionLockedResponseSchema,
  frontendSessionStatusResponseSchema,
  type FrontendSessionLease,
  type FrontendSessionLockedResponse,
  type FrontendSessionStatusResponse,
} from '../../shared/frontendSessionTransport';
import { serializeJsonMessage } from '../../shared/jsonTransport';
import {
  appendStateDebugSessionToUrl,
  getStateDebugRequestHeaders,
} from '../debug/stateDebug';

export const FRONTEND_ID_STORAGE_KEY = 'tc-frontend-id';
export const FRONTEND_OWNER_LABEL_STORAGE_KEY = 'tc-frontend-owner-label';
export const FRONTEND_LEASE_TOKEN_STORAGE_KEY = 'tc-frontend-lease-token';

interface StoredFrontendLease {
  frontendId: string;
  ownerLabel: string;
  leaseToken: string | null;
}

type FrontendLeaseConflictListener = (
  lock: FrontendSessionLockedResponse,
) => void;

const conflictListeners = new Set<FrontendLeaseConflictListener>();

export class FrontendLeaseLockedError extends Error {
  constructor(readonly lock: FrontendSessionLockedResponse) {
    super(lock.message);
    this.name = 'FrontendLeaseLockedError';
  }
}

export function getStoredFrontendLease(): StoredFrontendLease {
  const frontendId = readOrCreateSessionValue(
    FRONTEND_ID_STORAGE_KEY,
    createFrontendId,
  );
  const ownerLabel = readOrCreateSessionValue(
    FRONTEND_OWNER_LABEL_STORAGE_KEY,
    () => `Browser ${frontendId.slice(0, 8)}`,
  );

  return {
    frontendId,
    ownerLabel,
    leaseToken: readSessionValue(FRONTEND_LEASE_TOKEN_STORAGE_KEY),
  };
}

export function writeStoredFrontendLease(lease: FrontendSessionLease): void {
  writeSessionValue(FRONTEND_ID_STORAGE_KEY, lease.frontendId);
  writeSessionValue(FRONTEND_OWNER_LABEL_STORAGE_KEY, lease.ownerLabel);
  writeSessionValue(FRONTEND_LEASE_TOKEN_STORAGE_KEY, lease.leaseToken);
}

export function clearStoredFrontendLeaseToken(): void {
  removeSessionValue(FRONTEND_LEASE_TOKEN_STORAGE_KEY);
}

export async function acquireFrontendLease(options?: {
  takeover?: boolean;
}): Promise<FrontendSessionLease> {
  const frontendLease = getStoredFrontendLease();
  const response = await fetch('/api/frontend-session/acquire', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getStateDebugRequestHeaders(),
    },
    body: serializeJsonMessage({
      frontendId: frontendLease.frontendId,
      ownerLabel: frontendLease.ownerLabel,
      leaseToken: frontendLease.leaseToken ?? undefined,
      takeover: options?.takeover ?? false,
    }),
  });

  if (response.status === 423) {
    throw await toLockedError(response);
  }

  if (!response.ok) {
    throw new Error(`Frontend lease request failed with ${response.status}`);
  }

  const lease = frontendSessionLeaseSchema.parse(await response.json());
  writeStoredFrontendLease(lease);
  return lease;
}

export async function fetchFrontendSessionStatus(): Promise<FrontendSessionStatusResponse> {
  const frontendLease = getStoredFrontendLease();
  const response = await fetch('/api/frontend-session', {
    headers: buildFrontendLeaseHeaders(frontendLease),
  });

  if (!response.ok) {
    throw new Error(`Frontend session status failed with ${response.status}`);
  }

  return frontendSessionStatusResponseSchema.parse(await response.json());
}

export async function releaseFrontendLease(options?: {
  preferBeacon?: boolean;
}): Promise<boolean> {
  const frontendLease = getStoredFrontendLease();

  if (!frontendLease.leaseToken) {
    return false;
  }

  const payload = serializeJsonMessage({
    frontendId: frontendLease.frontendId,
    leaseToken: frontendLease.leaseToken,
  });
  const preferBeacon = options?.preferBeacon !== false;

  if (
    preferBeacon &&
    typeof navigator !== 'undefined' &&
    typeof navigator.sendBeacon === 'function'
  ) {
    const sent = navigator.sendBeacon(
      '/api/frontend-session/release',
      new Blob([payload], {
        type: 'application/json',
      }),
    );
    clearStoredFrontendLeaseToken();
    return sent;
  }

  try {
    const response = await fetch('/api/frontend-session/release', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getStateDebugRequestHeaders(),
      },
      body: payload,
      keepalive: true,
    });

    clearStoredFrontendLeaseToken();
    return response.ok;
  } catch {
    return false;
  }
}

export function appendFrontendLeaseToUrl(url: string): string {
  if (typeof window === 'undefined') {
    return url;
  }

  const frontendLease = getStoredFrontendLease();
  const nextUrl = new URL(url, window.location.href);
  nextUrl.searchParams.set(FRONTEND_ID_QUERY_PARAM, frontendLease.frontendId);

  if (frontendLease.leaseToken) {
    nextUrl.searchParams.set(
      FRONTEND_LEASE_TOKEN_QUERY_PARAM,
      frontendLease.leaseToken,
    );
  }

  return appendStateDebugSessionToUrl(nextUrl.toString());
}

export async function fetchWithFrontendLease(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(input, {
    ...init,
    headers: buildFrontendLeaseHeaders(getStoredFrontendLease(), init.headers),
  });

  if (response.status === 423) {
    throw await toLockedError(response);
  }

  return response;
}

export function subscribeToFrontendLeaseConflicts(
  listener: FrontendLeaseConflictListener,
): () => void {
  conflictListeners.add(listener);

  return () => {
    conflictListeners.delete(listener);
  };
}

export function reportFrontendLeaseLocked(
  lock: FrontendSessionLockedResponse,
): void {
  clearStoredFrontendLeaseToken();

  for (const listener of conflictListeners) {
    listener(lock);
  }
}

function buildFrontendLeaseHeaders(
  frontendLease: StoredFrontendLease,
  headersInit?: HeadersInit,
): Headers {
  const headers = new Headers(headersInit);
  headers.set(FRONTEND_ID_HEADER, frontendLease.frontendId);

  if (frontendLease.leaseToken) {
    headers.set(FRONTEND_LEASE_TOKEN_HEADER, frontendLease.leaseToken);
  } else {
    headers.delete(FRONTEND_LEASE_TOKEN_HEADER);
  }

  for (const [name, value] of Object.entries(getStateDebugRequestHeaders())) {
    headers.set(name, value);
  }

  return headers;
}

async function toLockedError(response: Response): Promise<FrontendLeaseLockedError> {
  const lock = frontendSessionLockedResponseSchema.parse(await response.json());
  reportFrontendLeaseLocked(lock);
  return new FrontendLeaseLockedError(lock);
}

function readOrCreateSessionValue(
  key: string,
  createValue: () => string,
): string {
  const existing = readSessionValue(key);

  if (existing) {
    return existing;
  }

  const nextValue = createValue();
  writeSessionValue(key, nextValue);
  return nextValue;
}

function readSessionValue(key: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const value = window.sessionStorage.getItem(key);
  return value?.trim() ? value : null;
}

function writeSessionValue(key: string, value: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.sessionStorage.setItem(key, value);
}

function removeSessionValue(key: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.sessionStorage.removeItem(key);
}

function createFrontendId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }

  return `frontend-${Math.random().toString(36).slice(2, 12)}`;
}
