import { resolve } from 'node:path';

import type { FastifyBaseLogger } from 'fastify';
import { spawn, type IDisposable, type IPty } from 'node-pty';

import { LOCAL_BACKEND_ID } from '../../shared/backends';
import type { AttentionEvent } from '../../shared/events';
import {
  clampTerminalDimensions,
  estimateTerminalDimensionsFromNodeBounds,
} from '../../shared/terminalSizeConstraints';
import {
  type TerminalIntegrationState,
  type TerminalServerSocketMessage,
  type TerminalSessionOutputState,
  type TerminalSessionSnapshot,
} from '../../shared/terminalSessions';
import type { AgentType, TerminalNode, Workspace } from '../../shared/workspace';
import { createAgentIntegrationRegistry } from '../integrations/agentIntegrationRegistry';
import type {
  AgentIntegrationProvider,
  AgentIntegrationRegistry,
} from '../integrations/agentIntegration';
import type { AttentionService } from '../integrations/attentionService';
import type { MarkdownService } from '../markdown/markdownService';
import { parseCommand } from './commandLine';
import {
  augmentShellEnvironmentForTracking,
  augmentPowerShellArgsForCwdTracking,
  parseCwdTrackingOutput,
  supportsPowerShellCwdTracking,
} from './cwdTracking';
import {
  applyAttentionEventSnapshot,
  createCommandStateSnapshot,
  createContextSnapshot,
  createExitSnapshot,
  createAppliedResizeSnapshot,
  createInitialSnapshot,
  createInputSnapshot,
  createOutputSnapshot,
  createReadSnapshot,
  createRunningSnapshot,
  createSpawnFailedSnapshot,
} from './sessionSnapshot';

interface SessionRecord {
  terminal: TerminalNode;
  pty: IPty | null;
  disposables: IDisposable[];
  snapshot: TerminalSessionSnapshot;
  runtime: SessionRuntimeState;
}
interface ResizeRequest {
  cols: number;
  rows: number;
  generation: number;
}

interface SessionRuntimeState {
  liveCwd: string;
  projectRoot: string | null;
  pendingOutput: string;
  contextVersion: number;
  disposeEpoch: number;
  lastPreparedProjectRoot: string | null;
  currentIntegrationProjectRoot: string | null;
  queuedIntegrationProjectRoot: string | null;
  integrationTask: Promise<void> | null;
  deferredSpawnTimer: ReturnType<typeof setTimeout> | null;
  spawnInFlight: boolean;
  requestedResize: ResizeRequest | null;
}

type SessionListener = (message: TerminalServerSocketMessage) => void;

/** When the client never sends `terminal.resize`, spawn using an estimated fallback size after this delay. */
const DEFERRED_PTY_SPAWN_MS = 2000;
const FALLBACK_RESIZE_GENERATION = 0;

export class PtySessionManager {
  private readonly sessions = new Map<string, SessionRecord>();

  private readonly listeners = new Set<SessionListener>();

  private readonly integrationRegistry: AgentIntegrationRegistry;

  constructor(
    private readonly logger: FastifyBaseLogger,
    private readonly options: {
      attentionService: AttentionService;
      attentionReceiverUrl: string;
      attentionToken: string;
      markdownService: MarkdownService;
      workspaceRoot?: string;
      backendId?: string;
      spawnBaseUrl?: string;
      integrationRegistry?: AgentIntegrationRegistry;
    },
  ) {
    this.integrationRegistry =
      options.integrationRegistry ??
      createAgentIntegrationRegistry({
        attentionReceiverUrl: options.attentionReceiverUrl,
      });
  }

  async syncWithWorkspace(workspace: Workspace): Promise<void> {
    const activeIds = new Set(
      workspace.terminals
        .filter(
          (terminal) =>
            (terminal.backendId || LOCAL_BACKEND_ID) ===
            (this.options.backendId ?? LOCAL_BACKEND_ID),
        )
        .map((terminal) => terminal.id),
    );

    for (const terminal of workspace.terminals) {
      if (
        (terminal.backendId || LOCAL_BACKEND_ID) !==
        (this.options.backendId ?? LOCAL_BACKEND_ID)
      ) {
        continue;
      }

      const existing = this.sessions.get(terminal.id);

      if (existing) {
        existing.terminal = terminal;
        continue;
      }

      await this.createSession(terminal);
    }

    for (const [sessionId] of this.sessions) {
      if (!activeIds.has(sessionId)) {
        this.disposeSession(sessionId);
        this.broadcast({
          type: 'session.removed',
          sessionId,
          backendId: this.options.backendId ?? LOCAL_BACKEND_ID,
        });
      }
    }
  }

  getSnapshots(): TerminalSessionSnapshot[] {
    return [...this.sessions.values()].map((record) => record.snapshot);
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  sendInput(sessionId: string, data: string): boolean {
    const record = this.sessions.get(sessionId);

    if (!record?.pty) {
      return false;
    }

    const timestamp = new Date().toISOString();
    record.pty.write(data);
    if (/[\r\n]/.test(data)) {
      this.options.markdownService.activateQueuedLink(sessionId);
      this.setSnapshot(
        record,
        createCommandStateSnapshot(
          createInputSnapshot(record.snapshot, timestamp),
          'running-command',
        ),
      );
      return true;
    }
    this.setSnapshot(
      record,
      createInputSnapshot(record.snapshot, timestamp),
    );

    return true;
  }

  resizeSession(
    sessionId: string,
    cols: number,
    rows: number,
    generation: number,
  ): boolean {
    const record = this.sessions.get(sessionId);

    if (!record) {
      return false;
    }

    const nextDimensions = clampTerminalDimensions(cols, rows);
    const { cols: nextCols, rows: nextRows } = nextDimensions;

    if (nextCols !== cols || nextRows !== rows) {
      this.logger.warn(
        {
          sessionId,
          generation,
          requestedCols: cols,
          requestedRows: rows,
          clampedCols: nextCols,
          clampedRows: nextRows,
        },
        'Clamped PTY resize request to allowed bounds',
      );
    }
    const latestRequestedGeneration =
      record.runtime.requestedResize?.generation ?? Number.NEGATIVE_INFINITY;
    const latestAppliedGeneration =
      record.snapshot.appliedResizeGeneration ?? Number.NEGATIVE_INFINITY;
    if (
      generation <= latestRequestedGeneration ||
      generation <= latestAppliedGeneration
    ) {
      return true;
    }

    this.clearDeferredSpawnTimer(record);
    record.runtime.requestedResize = {
      cols: nextCols,
      rows: nextRows,
      generation,
    };

    if (record.pty) {
      this.applyLatestRequestedResize(record);
      return true;
    }

    if (record.runtime.spawnInFlight) {
      return true;
    }

    record.runtime.spawnInFlight = true;
    void this.spawnTerminal(record).finally(() => {
      record.runtime.spawnInFlight = false;
      this.applyLatestRequestedResize(record);
    });

    return true;
  }

  restartSession(sessionId: string): boolean {
    const record = this.sessions.get(sessionId);

    if (!record) {
      return false;
    }

    this.options.markdownService.clearTerminalLink(sessionId);
    this.clearDeferredSpawnTimer(record);
    this.disposePty(record);
    record.runtime.spawnInFlight = true;
    void this.spawnTerminal(record).finally(() => {
      record.runtime.spawnInFlight = false;
      this.applyLatestRequestedResize(record);
    });
    return true;
  }

  markRead(sessionId: string): boolean {
    const record = this.sessions.get(sessionId);

    if (!record || record.snapshot.unreadCount === 0) {
      return Boolean(record);
    }

    this.setSnapshot(record, createReadSnapshot(record.snapshot));

    return true;
  }

  close(): void {
    for (const [sessionId] of this.sessions) {
      this.disposeSession(sessionId);
    }

    this.listeners.clear();
  }

  private async createSession(terminal: TerminalNode): Promise<void> {
    const liveCwd = resolve(
      this.options.workspaceRoot ?? process.cwd(),
      terminal.cwd,
    );
    const record: SessionRecord = {
      terminal,
      pty: null,
      disposables: [],
      snapshot: createInitialSnapshot(
        terminal.id,
        this.options.backendId ?? LOCAL_BACKEND_ID,
        terminal.agentType,
        liveCwd,
      ),
      runtime: {
        liveCwd,
        projectRoot: null,
        pendingOutput: '',
        contextVersion: 0,
        disposeEpoch: 0,
        lastPreparedProjectRoot: null,
        currentIntegrationProjectRoot: null,
        queuedIntegrationProjectRoot: null,
        integrationTask: null,
        deferredSpawnTimer: null,
        spawnInFlight: false,
        requestedResize: null,
      },
    };

    this.sessions.set(terminal.id, record);
    this.scheduleDeferredSpawn(record);
  }

  private clearDeferredSpawnTimer(record: SessionRecord): void {
    if (record.runtime.deferredSpawnTimer !== null) {
      clearTimeout(record.runtime.deferredSpawnTimer);
      record.runtime.deferredSpawnTimer = null;
    }
  }

  private scheduleDeferredSpawn(record: SessionRecord): void {
    this.clearDeferredSpawnTimer(record);
    record.runtime.deferredSpawnTimer = setTimeout(() => {
      record.runtime.deferredSpawnTimer = null;
      this.onDeferredSpawnDeadline(record);
    }, DEFERRED_PTY_SPAWN_MS);
  }

  private onDeferredSpawnDeadline(record: SessionRecord): void {
    if (this.sessions.get(record.terminal.id) !== record) {
      return;
    }

    if (record.pty || record.runtime.spawnInFlight) {
      return;
    }

    if (
      record.snapshot.recoveryState === 'spawn-failed' ||
      record.snapshot.status !== 'idle'
    ) {
      return;
    }

    record.runtime.spawnInFlight = true;
    void this.spawnTerminal(record).finally(() => {
      record.runtime.spawnInFlight = false;
      this.applyLatestRequestedResize(record);
    });
  }

  private async spawnTerminal(record: SessionRecord): Promise<void> {
    if (record.pty) {
      return;
    }
    const spawnResize = this.resolveSpawnResizeRequest(record);

    const command = parseCommand(record.terminal.shell);
    const cwd = resolve(
      this.options.workspaceRoot ?? process.cwd(),
      record.terminal.cwd,
    );
    const startedAt = new Date().toISOString();
    const args = supportsPowerShellCwdTracking(command.file)
      ? augmentPowerShellArgsForCwdTracking(command.args)
      : command.args;
    record.runtime.liveCwd = cwd;
    record.runtime.pendingOutput = '';
    record.runtime.contextVersion += 1;
    this.clearDeferredSpawnTimer(record);

    try {
      const spawnEnv: Record<string, string> = {
        ...augmentShellEnvironmentForTracking(command.file, process.env),
        TERMINAL_CANVAS_SESSION_ID: record.terminal.id,
        TERMINAL_CANVAS_ATTENTION_URL: this.options.attentionReceiverUrl,
        TERMINAL_CANVAS_ATTENTION_TOKEN: this.options.attentionToken,
        TERMINAL_CANVAS_AGENT_TYPE: record.terminal.agentType,
      };

      if (this.options.spawnBaseUrl) {
        spawnEnv.TERMINAL_CANVAS_SPAWN_URL = this.options.spawnBaseUrl;
      }

      if (record.terminal.parentTerminalId) {
        spawnEnv.TERMINAL_CANVAS_PARENT_ID = record.terminal.parentTerminalId;

        if (this.options.spawnBaseUrl) {
          spawnEnv.TERMINAL_CANVAS_RESULT_URL =
            `${this.options.spawnBaseUrl}/${record.terminal.id}/result`;
        }
      }

      const pty = spawn(command.file, args, {
        name: 'xterm-256color',
        cwd,
        cols: spawnResize.cols,
        rows: spawnResize.rows,
        env: spawnEnv,
      });

      record.pty = pty;
      record.disposables = [
        pty.onData((data) => {
          try {
            this.handleOutput(record, data);
          } catch (error) {
            this.logger.error(
              {
                sessionId: record.terminal.id,
                error: error instanceof Error ? error.message : String(error),
              },
              'PTY output handler failed',
            );
          }
        }),
        pty.onExit(({ exitCode, signal }) => {
          try {
            this.handleExit(record, exitCode, signal);
          } catch (error) {
            this.logger.error(
              {
                sessionId: record.terminal.id,
                exitCode,
                signal,
                error: error instanceof Error ? error.message : String(error),
              },
              'PTY exit handler failed',
            );
          }
        }),
      ];

      this.logger.info(
        {
          sessionId: record.terminal.id,
          pid: pty.pid,
          shell: record.terminal.shell,
          cwd,
          cols: spawnResize.cols,
          rows: spawnResize.rows,
          resizeGeneration: spawnResize.generation,
        },
        'Spawned PTY session',
      );
      const runningSnapshot = createRunningSnapshot({
        snapshot: createAppliedResizeSnapshot(
          record.snapshot,
          spawnResize.cols,
          spawnResize.rows,
          spawnResize.generation,
        ),
        terminal: record.terminal,
        pid: pty.pid,
        startedAt,
        summary: `${record.terminal.shell} started in ${record.terminal.cwd}`,
      });

      this.setSnapshot(
        record,
        runningSnapshot,
      );
      if (record.runtime.requestedResize?.generation === spawnResize.generation) {
        record.runtime.requestedResize = null;
      }
      this.applyLatestRequestedResize(record);
      void this.refreshSessionContext(
        record,
        cwd,
        record.runtime.contextVersion,
        record.runtime.disposeEpoch,
        true,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(
        {
          sessionId: record.terminal.id,
          error: message,
        },
        'Failed to spawn PTY session',
      );

      this.setSnapshot(
        record,
        createSpawnFailedSnapshot({
          snapshot: record.snapshot,
          startedAt,
          message,
        }),
      );
    }
  }

  private resolveSpawnResizeRequest(record: SessionRecord): ResizeRequest {
    const requestedResize = record.runtime.requestedResize;

    if (requestedResize) {
      return requestedResize;
    }

    if (
      record.snapshot.cols !== null &&
      record.snapshot.rows !== null &&
      record.snapshot.appliedResizeGeneration !== null
    ) {
      return {
        cols: record.snapshot.cols,
        rows: record.snapshot.rows,
        generation: record.snapshot.appliedResizeGeneration,
      };
    }

    return this.estimateFallbackResize(record);
  }

  private estimateFallbackResize(record: SessionRecord): ResizeRequest {
    const { cols, rows } = estimateTerminalDimensionsFromNodeBounds(
      record.terminal.bounds,
    );

    return {
      cols,
      rows,
      generation: FALLBACK_RESIZE_GENERATION,
    };
  }

  private applyLatestRequestedResize(record: SessionRecord): void {
    const requestedResize = record.runtime.requestedResize;

    if (!requestedResize) {
      return;
    }

    const appliedGeneration =
      record.snapshot.appliedResizeGeneration ?? Number.NEGATIVE_INFINITY;
    if (requestedResize.generation <= appliedGeneration) {
      if (isSnapshotResizeApplied(record.snapshot, requestedResize)) {
        record.runtime.requestedResize = null;
      }
      return;
    }

    this.applyResizeRequest(record, requestedResize);
  }

  private applyResizeRequest(
    record: SessionRecord,
    request: ResizeRequest,
  ): void {
    if (!record.pty) {
      return;
    }

    if (isSnapshotResizeApplied(record.snapshot, request)) {
      if (record.runtime.requestedResize?.generation === request.generation) {
        record.runtime.requestedResize = null;
      }
      return;
    }

    record.pty.resize(request.cols, request.rows);
    this.setSnapshot(
      record,
      createAppliedResizeSnapshot(
        record.snapshot,
        request.cols,
        request.rows,
        request.generation,
      ),
    );

    if (record.runtime.requestedResize?.generation === request.generation) {
      record.runtime.requestedResize = null;
    }
  }

  private handleOutput(record: SessionRecord, chunk: string): void {
    const cwdResult = parseCwdTrackingOutput(chunk, record.runtime.pendingOutput);
    record.runtime.pendingOutput = cwdResult.pending;

    if (cwdResult.liveCwd) {
      this.updateLiveCwd(record, cwdResult.liveCwd);
    }

    if (cwdResult.promptReturned) {
      this.options.markdownService.clearTerminalLink(record.terminal.id);
      this.setSnapshot(
        record,
        createCommandStateSnapshot(record.snapshot, 'idle-at-prompt'),
      );
    }

    if (!cwdResult.output.length) {
      return;
    }

    const timestamp = new Date().toISOString();
    let nextSnapshot = createOutputSnapshot({
      snapshot: record.snapshot,
      terminal: record.terminal,
      chunk: cwdResult.output,
      timestamp,
    });
    const attentionEvent = this.options.attentionService.detectFromPtyOutput({
      sessionId: record.terminal.id,
      terminal: record.terminal,
      snapshot: nextSnapshot,
      chunk: cwdResult.output,
      timestamp,
    });

    if (attentionEvent) {
      nextSnapshot = applyAttentionEventSnapshot(nextSnapshot, attentionEvent);
    }

    this.broadcast({
      type: 'session.output',
      sessionId: record.terminal.id,
      backendId: this.options.backendId ?? LOCAL_BACKEND_ID,
      data: cwdResult.output,
      state: buildSessionOutputState(nextSnapshot),
    });

    record.snapshot = nextSnapshot;
  }

  private handleExit(
    record: SessionRecord,
    exitCode: number,
    signal?: number,
  ): void {
    this.disposePty(record, false);
    this.options.markdownService.clearTerminalLink(record.terminal.id);

    const timestamp = new Date().toISOString();

    this.setSnapshot(
      record,
      createExitSnapshot({
        snapshot: record.snapshot,
        exitCode,
        signal,
        timestamp,
      }),
    );

    if (record.terminal.parentTerminalId) {
      this.options.attentionService.record({
        sessionId: record.terminal.parentTerminalId,
        source: 'pty',
        eventType: exitCode === 0 ? 'completed' : 'failed',
        timestamp,
        title: `Child terminal exited (code ${exitCode})`,
        detail: `${record.terminal.label}: ${record.snapshot.lastOutputLine ?? ''}`.trim(),
        confidence: 'high',
      });
    }
  }

  private setSnapshot(record: SessionRecord, snapshot: TerminalSessionSnapshot): void {
    record.snapshot = snapshot;
    this.broadcast({
      type: 'session.snapshot',
      session: snapshot,
    });
  }

  private disposePty(record: SessionRecord, kill = true): void {
    for (const disposable of record.disposables) {
      disposable.dispose();
    }

    record.disposables = [];

    if (kill && record.pty) {
      try {
        record.pty.kill();
      } catch (error) {
        this.logger.warn(
          {
            sessionId: record.terminal.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'PTY kill failed during disposal',
        );
      }
    }

    record.pty = null;
  }

  private disposeSession(sessionId: string): void {
    const record = this.sessions.get(sessionId);

    if (!record) {
      return;
    }

    record.runtime.disposeEpoch += 1;
    this.clearDeferredSpawnTimer(record);
    this.disposePty(record);
    this.options.markdownService.clearTerminalLink(sessionId);
    this.sessions.delete(sessionId);
  }

  private isSessionRecordActive(
    record: SessionRecord,
    disposeEpoch: number,
  ): boolean {
    return (
      this.sessions.get(record.terminal.id) === record &&
      record.runtime.disposeEpoch === disposeEpoch
    );
  }

  private broadcast(message: TerminalServerSocketMessage): void {
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch (error) {
        this.logger.warn(
          {
            messageType: message.type,
            error: error instanceof Error ? error.message : String(error),
          },
          'PTY listener callback failed',
        );
      }
    }
  }

  applyAttentionEvent(event: AttentionEvent): boolean {
    const record = this.sessions.get(event.sessionId);

    if (!record) {
      return false;
    }

    this.setSnapshot(record, applyAttentionEventSnapshot(record.snapshot, event));
    return true;
  }

  private updateLiveCwd(record: SessionRecord, liveCwd: string): void {
    if (record.runtime.liveCwd === liveCwd) {
      return;
    }

    record.runtime.liveCwd = liveCwd;
    record.runtime.contextVersion += 1;
    this.setSnapshot(
      record,
      createContextSnapshot(record.snapshot, {
        liveCwd,
      }),
    );
    void this.refreshSessionContext(
      record,
      liveCwd,
      record.runtime.contextVersion,
      record.runtime.disposeEpoch,
      false,
    );
  }

  private async refreshSessionContext(
    record: SessionRecord,
    liveCwd: string,
    contextVersion: number,
    disposeEpoch: number,
    forceSnapshot: boolean,
  ): Promise<void> {
    if (!this.isSessionRecordActive(record, disposeEpoch)) {
      return;
    }

    const provider = this.integrationRegistry.get(record.terminal.agentType);

    if (!provider) {
      if (
        !this.isSessionRecordActive(record, disposeEpoch) ||
        contextVersion !== record.runtime.contextVersion
      ) {
        return;
      }

      record.runtime.projectRoot = null;
      this.applyContext(
        record,
        {
          liveCwd,
          projectRoot: null,
          integration: createIntegrationState(
            record.terminal.agentType,
            'not-required',
            record.terminal.agentType === 'shell'
              ? 'Integration is not required for shell sessions.'
              : `No integration provider is registered for ${record.terminal.agentType}.`,
          ),
        },
        forceSnapshot,
      );
      return;
    }

    const projectRoot = await provider.resolveProjectRoot(liveCwd);

    if (
      !this.isSessionRecordActive(record, disposeEpoch) ||
      contextVersion !== record.runtime.contextVersion ||
      record.runtime.liveCwd !== liveCwd
    ) {
      return;
    }

    record.runtime.projectRoot = projectRoot;

    if (!projectRoot) {
      this.applyContext(
        record,
        {
          liveCwd,
          projectRoot: null,
          integration: createIntegrationState(
            record.terminal.agentType,
            'not-configured',
            'Waiting for a project root to be detected.',
          ),
        },
        forceSnapshot || record.snapshot.projectRoot !== null,
      );
      return;
    }

    const shouldPrepare = projectRoot !== record.runtime.lastPreparedProjectRoot;
    const integration = shouldPrepare
      ? createIntegrationState(
          record.terminal.agentType,
          'not-configured',
          `Project root detected at ${projectRoot}.`,
        )
      : record.snapshot.integration;

    this.applyContext(
      record,
      {
        liveCwd,
        projectRoot,
        integration,
      },
      forceSnapshot ||
        record.snapshot.projectRoot !== projectRoot ||
        integration !== record.snapshot.integration,
    );

    if (shouldPrepare) {
      this.scheduleIntegration(record, provider, projectRoot, disposeEpoch);
    }
  }

  private applyContext(
    record: SessionRecord,
    context: {
      liveCwd: string;
      projectRoot: string | null;
      integration: TerminalIntegrationState;
    },
    force: boolean,
  ): void {
    if (
      !force &&
      record.snapshot.liveCwd === context.liveCwd &&
      record.snapshot.projectRoot === context.projectRoot &&
      areIntegrationStatesEqual(record.snapshot.integration, context.integration)
    ) {
      return;
    }

    this.setSnapshot(
      record,
      createContextSnapshot(record.snapshot, context),
    );
  }

  private scheduleIntegration(
    record: SessionRecord,
    provider: AgentIntegrationProvider,
    projectRoot: string,
    disposeEpoch: number,
  ): void {
    if (!this.isSessionRecordActive(record, disposeEpoch)) {
      return;
    }

    if (record.runtime.currentIntegrationProjectRoot === projectRoot) {
      return;
    }

    if (record.runtime.integrationTask) {
      record.runtime.queuedIntegrationProjectRoot = projectRoot;
      return;
    }

    record.runtime.currentIntegrationProjectRoot = projectRoot;
    record.runtime.queuedIntegrationProjectRoot = null;
    const startedAt = new Date().toISOString();

    this.applyContext(
      record,
      {
        liveCwd: record.runtime.liveCwd,
        projectRoot,
        integration: createIntegrationState(
          record.terminal.agentType,
          'configuring',
          `Preparing ${capitalize(record.terminal.agentType)} integration in ${projectRoot}.`,
          startedAt,
        ),
      },
      true,
    );

    const task = this.runIntegration(record, provider, projectRoot, disposeEpoch);
    record.runtime.integrationTask = task;
    void task.finally(() => {
      if (!this.isSessionRecordActive(record, disposeEpoch)) {
        return;
      }

      record.runtime.integrationTask = null;
      record.runtime.currentIntegrationProjectRoot = null;
      const queuedProjectRoot = record.runtime.queuedIntegrationProjectRoot;
      record.runtime.queuedIntegrationProjectRoot = null;

      if (
        queuedProjectRoot &&
        queuedProjectRoot !== record.runtime.lastPreparedProjectRoot
      ) {
        this.scheduleIntegration(
          record,
          provider,
          queuedProjectRoot,
          record.runtime.disposeEpoch,
        );
      }
    });
  }

  private async runIntegration(
    record: SessionRecord,
    provider: AgentIntegrationProvider,
    projectRoot: string,
    disposeEpoch: number,
  ): Promise<void> {
    try {
      const result = await provider.prepareForProject({
        terminal: record.terminal,
        projectRoot,
      });

      if (!this.isSessionRecordActive(record, disposeEpoch)) {
        return;
      }

      record.runtime.lastPreparedProjectRoot = projectRoot;

      this.logger.info(
        {
          sessionId: record.terminal.id,
          agentType: record.terminal.agentType,
          projectRoot,
          status: result.status,
        },
        'Prepared terminal integration for project root',
      );

      if (record.runtime.projectRoot !== projectRoot) {
        return;
      }

      this.applyContext(
        record,
        {
          liveCwd: record.runtime.liveCwd,
          projectRoot,
          integration: createIntegrationState(
            record.terminal.agentType,
            result.status,
            result.message,
            new Date().toISOString(),
          ),
        },
        true,
      );
    } catch (error) {
      if (!this.isSessionRecordActive(record, disposeEpoch)) {
        return;
      }

      record.runtime.lastPreparedProjectRoot = projectRoot;
      const message =
        error instanceof Error
          ? `Integration setup failed: ${error.message}`
          : 'Integration setup failed.';

      this.logger.error(
        {
          sessionId: record.terminal.id,
          agentType: record.terminal.agentType,
          projectRoot,
          error: error instanceof Error ? error.message : String(error),
        },
        'Terminal integration preparation failed',
      );

      if (record.runtime.projectRoot !== projectRoot) {
        return;
      }

      this.applyContext(
        record,
        {
          liveCwd: record.runtime.liveCwd,
          projectRoot,
          integration: createIntegrationState(
            record.terminal.agentType,
            'error',
            message,
            new Date().toISOString(),
          ),
        },
        true,
      );
    }
  }
}

function buildSessionOutputState(
  snapshot: TerminalSessionSnapshot,
): TerminalSessionOutputState {
  const { sessionId: _sessionId, backendId: _backendId, scrollback: _scrollback, ...state } =
    snapshot;
  void _sessionId;
  void _backendId;
  void _scrollback;

  return state;
}

function isSnapshotResizeApplied(
  snapshot: TerminalSessionSnapshot,
  request: ResizeRequest,
): boolean {
  return (
    snapshot.cols === request.cols &&
    snapshot.rows === request.rows &&
    snapshot.appliedResizeGeneration === request.generation
  );
}

function createIntegrationState(
  agentType: AgentType,
  status: TerminalIntegrationState['status'],
  message: string,
  updatedAt: string | null = null,
): TerminalIntegrationState {
  return {
    owner: agentType === 'shell' ? null : agentType,
    status,
    message,
    updatedAt,
  };
}

function areIntegrationStatesEqual(
  left: TerminalIntegrationState,
  right: TerminalIntegrationState,
): boolean {
  return (
    left.owner === right.owner &&
    left.status === right.status &&
    left.message === right.message &&
    left.updatedAt === right.updatedAt
  );
}

function capitalize(value: string): string {
  if (!value.length) {
    return value;
  }

  return `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
}
