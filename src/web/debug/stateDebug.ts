import type { CameraViewport, Workspace } from '../../shared/workspace';
import { serializeJsonMessage } from '../../shared/jsonTransport';
import type {
  StateDebugEvent,
  StateDebugEventBatch,
} from '../../shared/debugState';
import {
  summarizeWorkspaceDiffForDebug,
  summarizeWorkspaceForDebug,
} from '../../shared/workspaceDebug';
export {
  summarizeWorkspaceDiffForDebug,
  summarizeWorkspaceForDebug,
} from '../../shared/workspaceDebug';

const DEBUG_QUERY_PARAM = 'debug-state';
const DEBUG_SESSION_QUERY_PARAM = 'debugSession';
const DEBUG_ENABLED_STORAGE_KEY = 'tc-debug-state-enabled';
const DEBUG_SESSION_STORAGE_KEY = 'tc-debug-state-session-id';
const MAX_DEBUG_EVENTS = 500;
const DEBUG_REQUEST_HEADER = 'x-tsheet-debug-session';

interface StateDebugStore {
  enabled: boolean;
  sessionId: string | null;
  events: StateDebugEvent[];
  deliveredCount: number;
  pendingCount: number;
  lastFlushAt: string | null;
  lastFlushError: string | null;
}

declare global {
  interface Window {
    __TSHEET_DEBUG__?: StateDebugStore;
  }
}

const DEBUG_FLUSH_INTERVAL_MS = 250;
let pendingDebugEvents: StateDebugEvent[] = [];
let flushTimerId: number | null = null;
let flushInFlight = false;

export function isStateDebugEnabled(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const queryValue = readDebugQueryValue();

  if (queryValue === '1' || queryValue === 'true') {
    writeSessionStorage(DEBUG_ENABLED_STORAGE_KEY, 'true');
    return true;
  }

  if (queryValue === '0' || queryValue === 'false') {
    removeSessionStorage(DEBUG_ENABLED_STORAGE_KEY);
    removeSessionStorage(DEBUG_SESSION_STORAGE_KEY);
    return false;
  }

  return readSessionStorage(DEBUG_ENABLED_STORAGE_KEY) === 'true';
}

export function getStateDebugSessionId(): string | null {
  if (!isStateDebugEnabled() || typeof window === 'undefined') {
    return null;
  }

  const querySessionId = readDebugSessionQueryValue();

  if (querySessionId) {
    writeSessionStorage(DEBUG_SESSION_STORAGE_KEY, querySessionId);
    ensureStateDebugStore(querySessionId);
    return querySessionId;
  }

  const existingSessionId = readSessionStorage(DEBUG_SESSION_STORAGE_KEY);

  if (existingSessionId) {
    ensureStateDebugStore(existingSessionId);
    return existingSessionId;
  }

  const nextSessionId = createDebugSessionId();
  writeSessionStorage(DEBUG_SESSION_STORAGE_KEY, nextSessionId);
  ensureStateDebugStore(nextSessionId);
  return nextSessionId;
}

export function getStateDebugRequestHeaders(): Record<string, string> {
  const sessionId = getStateDebugSessionId();

  return sessionId ? { [DEBUG_REQUEST_HEADER]: sessionId } : {};
}

export function appendStateDebugSessionToUrl(url: string): string {
  const sessionId = getStateDebugSessionId();

  if (!sessionId || typeof window === 'undefined') {
    return url;
  }

  const nextUrl = new URL(url, window.location.href);
  nextUrl.searchParams.set(DEBUG_SESSION_QUERY_PARAM, sessionId);
  return nextUrl.toString();
}

export function logStateDebug(
  scope: string,
  event: string,
  details: unknown,
): void {
  if (!isStateDebugEnabled() || typeof window === 'undefined') {
    return;
  }

  const sessionId = getStateDebugSessionId();
  const store = ensureStateDebugStore(sessionId);
  const entry: StateDebugEvent = {
    timestamp: new Date().toISOString(),
    scope,
    event,
    details,
  };

  store.events.push(entry);
  if (store.events.length > MAX_DEBUG_EVENTS) {
    store.events.splice(0, store.events.length - MAX_DEBUG_EVENTS);
  }

  window.__TSHEET_DEBUG__ = store;
  pendingDebugEvents.push(entry);
  updatePendingCount(pendingDebugEvents.length);
  scheduleDebugEventFlush();
  console.info(`[tsheet-debug:${sessionId ?? 'no-session'}] ${scope}.${event}`, details);
}

function ensureStateDebugStore(sessionId: string | null): StateDebugStore {
  if (typeof window === 'undefined') {
    return {
      enabled: false,
      sessionId,
      events: [],
      deliveredCount: 0,
      pendingCount: pendingDebugEvents.length,
      lastFlushAt: null,
      lastFlushError: null,
    };
  }

  const existingStore = window.__TSHEET_DEBUG__;

  if (existingStore) {
    existingStore.enabled = isStateDebugEnabled();
    existingStore.sessionId = sessionId;
    return existingStore;
  }

  const nextStore: StateDebugStore = {
    enabled: isStateDebugEnabled(),
    sessionId,
    events: [],
    deliveredCount: 0,
    pendingCount: pendingDebugEvents.length,
    lastFlushAt: null,
    lastFlushError: null,
  };
  window.__TSHEET_DEBUG__ = nextStore;
  return nextStore;
}

function scheduleDebugEventFlush(): void {
  if (typeof window === 'undefined' || flushInFlight) {
    return;
  }

  if (flushTimerId !== null) {
    return;
  }

  flushTimerId = window.setTimeout(() => {
    flushTimerId = null;
    void flushStateDebugEvents();
  }, DEBUG_FLUSH_INTERVAL_MS);
}

async function flushStateDebugEvents(): Promise<void> {
  if (
    typeof window === 'undefined' ||
    flushInFlight ||
    pendingDebugEvents.length === 0
  ) {
    return;
  }

  const sessionId = getStateDebugSessionId();

  if (!sessionId) {
    pendingDebugEvents = [];
    updatePendingCount(0);
    return;
  }

  const batch: StateDebugEventBatch = {
    sessionId,
    events: pendingDebugEvents.splice(0, pendingDebugEvents.length),
  };

  updatePendingCount(pendingDebugEvents.length);
  flushInFlight = true;

  try {
    const response = await fetch('/api/debug/state', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getStateDebugRequestHeaders(),
      },
      body: serializeJsonMessage(batch),
      keepalive: batch.events.length <= 16,
    });

    if (!response.ok) {
      throw new Error(`Debug state upload failed with ${response.status}`);
    }

    const store = ensureStateDebugStore(sessionId);
    store.deliveredCount += batch.events.length;
    store.lastFlushAt = new Date().toISOString();
    store.lastFlushError = null;
    window.__TSHEET_DEBUG__ = store;
  } catch (error) {
    pendingDebugEvents = [...batch.events, ...pendingDebugEvents].slice(
      -MAX_DEBUG_EVENTS,
    );
    updatePendingCount(pendingDebugEvents.length);

    const store = ensureStateDebugStore(sessionId);
    store.lastFlushError =
      error instanceof Error ? error.message : 'Unknown debug flush error';
    window.__TSHEET_DEBUG__ = store;
  } finally {
    flushInFlight = false;

    if (pendingDebugEvents.length > 0) {
      scheduleDebugEventFlush();
    }
  }
}

function updatePendingCount(count: number): void {
  if (typeof window === 'undefined') {
    return;
  }

  const sessionId = readSessionStorage(DEBUG_SESSION_STORAGE_KEY);
  const store = ensureStateDebugStore(sessionId);
  store.pendingCount = count;
  window.__TSHEET_DEBUG__ = store;
}

function createDebugSessionId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }

  return `debug-${Date.now()}`;
}

function readDebugQueryValue(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return new URLSearchParams(window.location.search).get(DEBUG_QUERY_PARAM);
}

function readDebugSessionQueryValue(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return (
    new URLSearchParams(window.location.search).get(DEBUG_SESSION_QUERY_PARAM) ??
    null
  );
}

function readSessionStorage(key: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSessionStorage(key: string, value: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // Ignore session storage write failures.
  }
}

function removeSessionStorage(key: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Ignore session storage removal failures.
  }
}

function roundForDebug(value: number): number {
  return Number(value.toFixed(3));
}

function almostEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.001;
}
