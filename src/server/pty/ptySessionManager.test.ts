import { describe, expect, it, beforeEach, vi } from 'vitest';

import type { Workspace } from '../../shared/workspace';
import { AttentionService } from '../integrations/attentionService';
import type { AgentIntegrationRegistry } from '../integrations/agentIntegration';
import type { MarkdownService } from '../markdown/markdownService';
import { PtySessionManager } from './ptySessionManager';

const spawnedPtys: FakePty[] = [];

vi.mock('node-pty', () => ({
  spawn: vi.fn((file: string, args: string[]) => {
    const pty = new FakePty(file, args);
    spawnedPtys.push(pty);
    return pty;
  }),
}));

describe('PtySessionManager', () => {
  beforeEach(() => {
    spawnedPtys.length = 0;
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
    selectedNodeId: null,
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
