import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
  estimateTerminalDimensionsFromNodeBounds,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
} from '../../shared/terminalSizeConstraints';
import type { Workspace } from '../../shared/workspace';
import { AttentionService } from '../integrations/attentionService';
import type { AgentIntegrationRegistry } from '../integrations/agentIntegration';
import type { MarkdownService } from '../markdown/markdownService';
import { PtySessionManager } from './ptySessionManager';

const spawnedPtys: FakePty[] = [];

vi.mock('node-pty', () => ({
  spawn: vi.fn(
    (
      file: string,
      args: string[],
      options?: { cols?: number; rows?: number },
    ) => {
      const pty = new FakePty(file, args, options);
      spawnedPtys.push(pty);
      return pty;
    },
  ),
}));

describe('PtySessionManager', () => {
  beforeEach(() => {
    spawnedPtys.length = 0;
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tracks live cwd changes and prepares each project root once', async () => {
    const provider = {
      agentType: 'claude' as const,
      supports: (agentType: string) => agentType === 'claude',
      resolveProjectRoot: vi.fn(async (cwd: string) => {
        if (cwd.includes('repo-a')) {
          return 'C:\\workspace\\repo-a';
        }

        if (cwd.includes('repo-b')) {
          return 'C:\\workspace\\repo-b';
        }

        return null;
      }),
      prepareForProject: vi.fn(async ({ projectRoot }: { projectRoot: string }) => ({
        status: 'configured' as const,
        message: `Configured ${projectRoot}`,
      })),
    };
    const manager = createManager({
      get: vi.fn(() => provider),
    });

    await manager.syncWithWorkspace(
      createWorkspace({
        id: 'terminal-1',
        shell: 'powershell.exe',
        cwd: './repo-a',
        agentType: 'claude',
      }),
    );
    primeDeferredSpawn(manager, 'terminal-1');

    await vi.waitFor(() => {
      expect(provider.prepareForProject).toHaveBeenCalledTimes(1);
    });

    const pty = expectSpawnedPty();
    pty.emitData(createCwdMarker('C:\\workspace\\repo-a\\packages\\app'));
    pty.emitData(createCwdMarker('C:\\workspace\\repo-a\\packages\\app'));

    await Promise.resolve();
    expect(provider.prepareForProject).toHaveBeenCalledTimes(1);

    pty.emitData(createCwdMarker('C:\\workspace\\repo-b'));

    await vi.waitFor(() => {
      expect(provider.prepareForProject).toHaveBeenCalledTimes(2);
    });

    const snapshot = manager.getSnapshots()[0];

    expect(snapshot?.liveCwd).toBe('C:\\workspace\\repo-b');
    expect(snapshot?.projectRoot).toBe('C:\\workspace\\repo-b');
    expect(snapshot?.integration.status).toBe('configured');
    expect(snapshot?.integration.message).toContain('Configured C:\\workspace\\repo-b');
  });

  it('strips cwd markers from terminal output', async () => {
    const manager = createManager({
      get: vi.fn(() => null),
    });
    const delivered = vi.fn();

    manager.subscribe(delivered);
    await manager.syncWithWorkspace(
      createWorkspace({
        id: 'terminal-2',
        shell: 'powershell.exe',
        cwd: '.',
        agentType: 'shell',
      }),
    );
    primeDeferredSpawn(manager, 'terminal-2');

    const pty = expectSpawnedPty();
    pty.emitData(`build complete\r\n${createCwdMarker('C:\\workspace')}`);

    expect(delivered).toHaveBeenCalledWith({
      type: 'session.output',
      sessionId: 'terminal-2',
      backendId: 'local',
      data: 'build complete\r\n',
      state: expect.objectContaining({
        summary: expect.any(String),
      }),
    });
    expect(manager.getSnapshots()[0]?.scrollback).toContain('build complete');
    expect(manager.getSnapshots()[0]?.scrollback).not.toContain(
      'TerminalCanvasCwd',
    );
  });

  it('marks sessions without a provider as not required', async () => {
    const registry = {
      get: vi.fn(() => null),
    };
    const manager = createManager(registry);

    await manager.syncWithWorkspace(
      createWorkspace({
        id: 'terminal-3',
        shell: 'powershell.exe',
        cwd: '.',
        agentType: 'codex',
      }),
    );
    primeDeferredSpawn(manager, 'terminal-3');

    await vi.waitFor(() => {
      expect(manager.getSnapshots()[0]?.integration.status).toBe('not-required');
    });
    expect(manager.getSnapshots()[0]?.integration.message).toContain(
      'No integration provider is registered for codex',
    );
  });

  it('does not prepare a provider until a project root is resolved', async () => {
    const provider = {
      agentType: 'claude' as const,
      supports: (agentType: string) => agentType === 'claude',
      resolveProjectRoot: vi.fn(async () => null),
      prepareForProject: vi.fn(),
    };
    const manager = createManager({
      get: vi.fn(() => provider),
    });

    await manager.syncWithWorkspace(
      createWorkspace({
        id: 'terminal-4',
        shell: 'powershell.exe',
        cwd: './scratch',
        agentType: 'claude',
      }),
    );

    await vi.waitFor(() => {
      expect(manager.getSnapshots()[0]?.integration.status).toBe('not-configured');
    });
    expect(provider.prepareForProject).not.toHaveBeenCalled();
    expect(manager.getSnapshots()[0]?.projectRoot).toBeNull();
  });

  it('ignores integration updates that complete after session disposal', async () => {
    let resolvePreparation: () => void = () => {
      throw new Error('Expected integration preparation callback to be available.');
    };
    const preparation = new Promise<{ status: 'configured'; message: string }>((resolve) => {
      resolvePreparation = () => {
        resolve({
          status: 'configured',
          message: 'Configured after delay',
        });
      };
    });
    const provider = {
      agentType: 'claude' as const,
      supports: (agentType: string) => agentType === 'claude',
      resolveProjectRoot: vi.fn(async () => 'C:\\workspace\\repo-a'),
      prepareForProject: vi.fn(async () => preparation),
    };
    const manager = createManager({
      get: vi.fn(() => provider),
    });
    const delivered = vi.fn();
    manager.subscribe(delivered);

    const workspace = createWorkspace({
      id: 'terminal-dispose',
      shell: 'powershell.exe',
      cwd: './repo-a',
      agentType: 'claude',
    });
    await manager.syncWithWorkspace(workspace);
    primeDeferredSpawn(manager, 'terminal-dispose');
    await vi.waitFor(() => {
      expect(provider.prepareForProject).toHaveBeenCalledTimes(1);
    });

    await manager.syncWithWorkspace({
      ...workspace,
      terminals: [],
    });
    const callCountAfterDispose = delivered.mock.calls.length;
    expect(manager.hasSession('terminal-dispose')).toBe(false);
    resolvePreparation();

    await Promise.resolve();
    await Promise.resolve();

    expect(delivered).toHaveBeenCalledTimes(callCountAfterDispose);
    expect(manager.getSnapshots()).toHaveLength(0);
  });

  it('continues notifying later listeners when one listener throws', () => {
    const logger = createLogger();
    const attentionService = new AttentionService({
      receiverUrl: 'http://127.0.0.1:4312/api/attention',
      token: 'test-token',
    });
    const manager = new PtySessionManager(logger as never, {
      attentionService,
      attentionReceiverUrl: attentionService.getSetup().receiverUrl,
      attentionToken: attentionService.getSetup().token,
      markdownService: createMarkdownServiceStub(),
    });
    const delivered = vi.fn();

    manager.subscribe(() => {
      throw new Error('socket closed');
    });
    manager.subscribe(delivered);

    expect(() =>
      (
        manager as unknown as {
          broadcast: (message: {
            type: 'ready';
            timestamp: string;
          }) => void;
        }
      ).broadcast({
        type: 'ready',
        timestamp: '2026-03-11T00:00:00.000Z',
      }),
    ).not.toThrow();
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('logs when resize requests are clamped to backend bounds', async () => {
    const logger = createLogger();
    const attentionService = new AttentionService({
      receiverUrl: 'http://127.0.0.1:4312/api/attention',
      token: 'test-token',
    });
    const manager = new PtySessionManager(logger as never, {
      attentionService,
      attentionReceiverUrl: attentionService.getSetup().receiverUrl,
      attentionToken: attentionService.getSetup().token,
      markdownService: createMarkdownServiceStub(),
      workspaceRoot: 'C:\\workspace',
      integrationRegistry: {
        get: vi.fn(() => null),
      },
    });

    await manager.syncWithWorkspace(
      createWorkspace({
        id: 'terminal-clamp',
        shell: 'powershell.exe',
        cwd: '.',
        agentType: 'shell',
      }),
    );

    expect(spawnedPtys.length).toBe(0);
    expect(manager.resizeSession('terminal-clamp', 15, 4)).toBe(true);
    const pty = expectSpawnedPty();
    expect(pty.spawnOptions).toMatchObject({
      cols: MIN_TERMINAL_COLS,
      rows: MIN_TERMINAL_ROWS,
    });
    expect(manager.resizeSession('terminal-clamp', 15, 4)).toBe(true);
    expect(pty.resize).toHaveBeenCalledWith(
      MIN_TERMINAL_COLS,
      MIN_TERMINAL_ROWS,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'terminal-clamp',
        requestedCols: 15,
        requestedRows: 4,
        clampedCols: MIN_TERMINAL_COLS,
        clampedRows: MIN_TERMINAL_ROWS,
      }),
      'Clamped PTY resize request to allowed bounds',
    );
  });

  it('does not spawn a PTY until the first resize message arrives', async () => {
    const manager = createManager({
      get: vi.fn(() => null),
    });

    await manager.syncWithWorkspace(
      createWorkspace({
        id: 'terminal-defer',
        shell: 'powershell.exe',
        cwd: '.',
        agentType: 'shell',
      }),
    );

    expect(spawnedPtys.length).toBe(0);

    expect(manager.resizeSession('terminal-defer', 100, 40)).toBe(true);
    const pty = expectSpawnedPty();
    expect(pty.spawnOptions).toMatchObject({ cols: 100, rows: 40 });
  });

  it('spawns with estimated snapshot dimensions after the deferred fallback timeout', async () => {
    vi.useFakeTimers();
    const manager = createManager({
      get: vi.fn(() => null),
    });
    const ws = createWorkspace({
      id: 'terminal-fallback',
      shell: 'powershell.exe',
      cwd: '.',
      agentType: 'shell',
    });

    await manager.syncWithWorkspace(ws);

    expect(spawnedPtys.length).toBe(0);

    const estimated = estimateTerminalDimensionsFromNodeBounds(
      ws.terminals[0]!.bounds,
    );

    await vi.advanceTimersByTimeAsync(2000);

    expect(spawnedPtys.length).toBe(1);
    expect(spawnedPtys[0]?.spawnOptions).toMatchObject({
      cols: estimated.cols,
      rows: estimated.rows,
    });
  });

  it('exposes initial snapshot dimensions estimated from node bounds, not 80x24 defaults', async () => {
    const manager = createManager({
      get: vi.fn(() => null),
    });
    const ws = createWorkspace({
      id: 'terminal-initial-snapshot',
      shell: 'powershell.exe',
      cwd: '.',
      agentType: 'shell',
    });

    await manager.syncWithWorkspace(ws);

    const snapshot = manager.getSnapshots()[0];
    const expected = estimateTerminalDimensionsFromNodeBounds(
      ws.terminals[0]!.bounds,
    );

    expect(snapshot?.cols).toBe(expected.cols);
    expect(snapshot?.rows).toBe(expected.rows);
    expect(snapshot?.cols).not.toBe(DEFAULT_TERMINAL_COLS);
    expect(snapshot?.rows).not.toBe(DEFAULT_TERMINAL_ROWS);
    expect(spawnedPtys.length).toBe(0);
  });

  it('refreshes idle unspawned snapshot dimensions when workspace sync updates bounds', async () => {
    vi.useFakeTimers();
    const manager = createManager({
      get: vi.fn(() => null),
    });
    const ws = createWorkspace({
      id: 'terminal-bounds-sync',
      shell: 'powershell.exe',
      cwd: '.',
      agentType: 'shell',
    });

    await manager.syncWithWorkspace(ws);
    const first = estimateTerminalDimensionsFromNodeBounds(
      ws.terminals[0]!.bounds,
    );
    expect(manager.getSnapshots()[0]?.cols).toBe(first.cols);

    const wider = {
      ...ws,
      terminals: [
        {
          ...ws.terminals[0]!,
          bounds: { ...ws.terminals[0]!.bounds, width: 960, height: 640 },
        },
      ],
    };
    await manager.syncWithWorkspace(wider);

    const next = estimateTerminalDimensionsFromNodeBounds(
      wider.terminals[0]!.bounds,
    );
    expect(manager.getSnapshots()[0]?.cols).toBe(next.cols);
    expect(manager.getSnapshots()[0]?.rows).toBe(next.rows);
    expect(next.cols).toBeGreaterThan(first.cols);
    expect(spawnedPtys.length).toBe(0);
  });

  it('restartSession spawns a new PTY immediately using current snapshot dimensions', async () => {
    const manager = createManager({
      get: vi.fn(() => null),
    });

    await manager.syncWithWorkspace(
      createWorkspace({
        id: 'terminal-restart',
        shell: 'powershell.exe',
        cwd: '.',
        agentType: 'shell',
      }),
    );

    expect(manager.resizeSession('terminal-restart', 88, 36)).toBe(true);
    expect(spawnedPtys.length).toBe(1);
    expect(spawnedPtys[0]?.spawnOptions).toMatchObject({ cols: 88, rows: 36 });

    expect(manager.restartSession('terminal-restart')).toBe(true);
    expect(spawnedPtys.length).toBe(2);
    expect(spawnedPtys[1]?.spawnOptions).toMatchObject({ cols: 88, rows: 36 });
  });
});

class FakePty {
  readonly pid = 100;

  private readonly dataHandlers = new Set<(data: string) => void>();

  private readonly exitHandlers = new Set<
    (event: { exitCode: number; signal?: number }) => void
  >();

  readonly write = vi.fn();

  readonly resize = vi.fn();

  readonly kill = vi.fn();

  constructor(
    readonly file: string,
    readonly args: string[],
    readonly spawnOptions?: { cols?: number; rows?: number },
  ) {}

  onData(handler: (data: string) => void) {
    this.dataHandlers.add(handler);
    return {
      dispose: () => {
        this.dataHandlers.delete(handler);
      },
    };
  }

  onExit(handler: (event: { exitCode: number; signal?: number }) => void) {
    this.exitHandlers.add(handler);
    return {
      dispose: () => {
        this.exitHandlers.delete(handler);
      },
    };
  }

  emitData(data: string): void {
    for (const handler of this.dataHandlers) {
      handler(data);
    }
  }

  emitExit(exitCode: number, signal?: number): void {
    for (const handler of this.exitHandlers) {
      handler({ exitCode, signal });
    }
  }
}

function createManager(integrationRegistry: AgentIntegrationRegistry): PtySessionManager {
  const logger = createLogger();
  const attentionService = new AttentionService({
    receiverUrl: 'http://127.0.0.1:4312/api/attention',
    token: 'test-token',
  });

  return new PtySessionManager(logger as never, {
    attentionService,
    attentionReceiverUrl: attentionService.getSetup().receiverUrl,
    attentionToken: attentionService.getSetup().token,
    markdownService: createMarkdownServiceStub(),
    workspaceRoot: 'C:\\workspace',
    integrationRegistry,
  });
}

function createWorkspace(terminal: {
  id: string;
  shell: string;
  cwd: string;
  agentType: 'claude' | 'codex' | 'shell';
}): Workspace {
  return {
    version: 2,
    id: 'workspace-default',
    name: 'Terminal Canvas',
    createdAt: '2026-03-11T10:00:00.000Z',
    updatedAt: '2026-03-11T10:00:00.000Z',
    layoutMode: 'free',
    currentViewport: { x: 0, y: 0, zoom: 1 },
    terminals: [
      {
        id: terminal.id,
        backendId: 'local',
        label: terminal.id,
        shell: terminal.shell,
        cwd: terminal.cwd,
        agentType: terminal.agentType,
        status: 'idle',
        bounds: {
          x: 0,
          y: 0,
          width: 400,
          height: 280,
        },
        tags: [],
      },
    ],
    markdown: [],
    backends: [],
    cameraPresets: [],
    filters: {
      attentionOnly: false,
      activeMarkdownId: null,
    },
  };
}

function createMarkdownServiceStub(): MarkdownService {
  return {
    activateQueuedLink: vi.fn(),
    clearTerminalLink: vi.fn(),
  } as unknown as MarkdownService;
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
}

function createCwdMarker(cwd: string): string {
  return `\u001b]633;TerminalCanvasCwd=${Buffer.from(cwd, 'utf8').toString('base64')}\u0007`;
}

function expectSpawnedPty(): FakePty {
  const pty = spawnedPtys[0];

  expect(pty).toBeDefined();
  return pty as FakePty;
}

function primeDeferredSpawn(manager: PtySessionManager, sessionId: string): void {
  manager.resizeSession(sessionId, MIN_TERMINAL_COLS, MIN_TERMINAL_ROWS);
}
