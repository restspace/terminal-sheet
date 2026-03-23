import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOCAL_BACKEND_ID } from '../../shared/backends';
import type { AttentionEvent } from '../../shared/events';
import type {
  TerminalServerSocketMessage,
  TerminalSessionSnapshot,
} from '../../shared/terminalSessions';
import {
  createDefaultWorkspace,
  createTerminalNode,
} from '../../shared/workspace';
import { BackendRuntimeManager, buildSessionBackendIndex } from './backendRuntimeManager';

describe('BackendRuntimeManager', () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
  });

  afterEach(() => {
    vi.clearAllMocks();

    if (originalWebSocket) {
      vi.stubGlobal('WebSocket', originalWebSocket);
    } else {
      vi.unstubAllGlobals();
    }

    if (originalFetch) {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('maps workspace terminal IDs to backend IDs with local fallback', () => {
    const workspace = createDefaultWorkspace();
    const localTerminal = createTerminalNode(
      {
        label: 'Local',
        shell: 'powershell.exe',
        cwd: '.',
        agentType: 'shell',
      },
      0,
    );
    const remoteTerminal = createTerminalNode(
      {
        label: 'Remote',
        shell: 'powershell.exe',
        cwd: '.',
        agentType: 'codex',
        backendId: 'backend-remote',
      },
      1,
    );
    workspace.terminals = [localTerminal, remoteTerminal];

    const index = buildSessionBackendIndex(workspace, LOCAL_BACKEND_ID);

    expect(index.get(localTerminal.id)).toBe(LOCAL_BACKEND_ID);
    expect(index.get(remoteTerminal.id)).toBe('backend-remote');
    expect(index.size).toBe(2);
  });

  it('routes local sessions through the local adapter', async () => {
    const localPtySessionManager = createPtySessionManagerStub();
    const manager = createRuntimeManager({
      localPtySessionManager,
    });
    const localTerminal = createTerminalNode(
      {
        label: 'Local',
        shell: 'powershell.exe',
        cwd: '.',
        agentType: 'shell',
      },
      0,
    );
    const workspace = createDefaultWorkspace();
    workspace.terminals = [localTerminal];

    await manager.syncWithWorkspace(workspace);

    expect(manager.sendInput(localTerminal.id, 'ls')).toBe(true);
    expect(localPtySessionManager.sendInput).toHaveBeenCalledWith(localTerminal.id, 'ls');
  });

  it('routes remote sessions through the remote adapter and leaves local PTY untouched', async () => {
    const localPtySessionManager = createPtySessionManagerStub();
    const manager = createRuntimeManager({
      localPtySessionManager,
    });
    const remoteTerminal = createTerminalNode(
      {
        label: 'Remote',
        shell: 'powershell.exe',
        cwd: '.',
        agentType: 'codex',
        backendId: 'backend-remote',
      },
      0,
    );
    const workspace = createDefaultWorkspace();
    workspace.terminals = [remoteTerminal];
    workspace.backends = [
      {
        id: 'backend-remote',
        label: 'Remote',
        baseUrl: 'http://127.0.0.1:9999',
        token: 'token',
        transport: 'direct',
        enabled: true,
      },
    ];

    await manager.syncWithWorkspace(workspace);

    expect(manager.sendInput(remoteTerminal.id, 'pwd')).toBe(true);
    expect(localPtySessionManager.sendInput).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9999/api/backend/sessions/' +
        `${encodeURIComponent(remoteTerminal.id)}/input`,
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('collects remote adapter status separately from the local adapter', async () => {
    const manager = createRuntimeManager();
    const remoteTerminal = createTerminalNode(
      {
        label: 'Remote',
        shell: 'powershell.exe',
        cwd: '.',
        agentType: 'codex',
        backendId: 'backend-remote',
      },
      0,
    );
    const workspace = createDefaultWorkspace();
    workspace.terminals = [remoteTerminal];
    workspace.backends = [
      {
        id: 'backend-remote',
        label: 'Remote',
        baseUrl: 'http://127.0.0.1:9999',
        token: 'token',
        transport: 'direct',
        enabled: true,
      },
    ];

    await manager.syncWithWorkspace(workspace);

    expect(manager.getBackendStatuses()).toEqual([
      expect.objectContaining({
        id: 'backend-remote',
        state: 'connecting',
      }),
    ]);
  });
});

function createRuntimeManager(options?: {
  localPtySessionManager?: ReturnType<typeof createPtySessionManagerStub>;
}) {
  const localPtySessionManager =
    options?.localPtySessionManager ?? createPtySessionManagerStub();
  const localAttentionService = createAttentionServiceStub();

  return new BackendRuntimeManager(createLogger() as never, {
    role: 'home',
    localBackendId: LOCAL_BACKEND_ID,
    localPtySessionManager: localPtySessionManager as never,
    localAttentionService: localAttentionService as never,
    workspaceService: {
      getWorkspace: vi.fn(() => createDefaultWorkspace()),
    } as never,
  });
}

function createPtySessionManagerStub() {
  const sessionListeners = new Set<(message: TerminalServerSocketMessage) => void>();

  return {
    syncWithWorkspace: vi.fn(async () => undefined),
    getSnapshots: vi.fn(() => [] as TerminalSessionSnapshot[]),
    sendInput: vi.fn(() => true),
    resizeSession: vi.fn(() => true),
    restartSession: vi.fn(() => true),
    markRead: vi.fn(() => true),
    subscribe: vi.fn((listener: (message: TerminalServerSocketMessage) => void) => {
      sessionListeners.add(listener);
      return () => {
        sessionListeners.delete(listener);
      };
    }),
  };
}

function createAttentionServiceStub() {
  const listeners = new Set<(event: AttentionEvent) => void>();

  return {
    getEvents: vi.fn(() => [] as AttentionEvent[]),
    subscribe: vi.fn((listener: (event: AttentionEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createLogger()),
  };
}

class FakeWebSocket {
  static readonly CONNECTING = 0;

  static readonly OPEN = 1;

  static readonly CLOSING = 2;

  static readonly CLOSED = 3;

  readonly readyState = FakeWebSocket.CONNECTING;

  constructor(readonly url: string) {}

  addEventListener(): void {}

  close(): void {}
}
