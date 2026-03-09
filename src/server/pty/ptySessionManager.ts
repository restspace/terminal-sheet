import { resolve } from 'node:path';

import type { FastifyBaseLogger } from 'fastify';
import { spawn, type IDisposable, type IPty } from 'node-pty';

import {
  type TerminalServerSocketMessage,
  type TerminalSessionSnapshot,
} from '../../shared/terminalSessions';
import type { TerminalNode, Workspace } from '../../shared/workspace';
import { parseCommand } from './commandLine';
import {
  createExitSnapshot,
  createInitialSnapshot,
  createInputSnapshot,
  createOutputSnapshot,
  createReadSnapshot,
  createResizeSnapshot,
  createRunningSnapshot,
  createSpawnFailedSnapshot,
} from './sessionSnapshot';

interface SessionRecord {
  terminal: TerminalNode;
  pty: IPty | null;
  disposables: IDisposable[];
  snapshot: TerminalSessionSnapshot;
}

type SessionListener = (message: TerminalServerSocketMessage) => void;

export class PtySessionManager {
  private readonly sessions = new Map<string, SessionRecord>();

  private readonly listeners = new Set<SessionListener>();

  constructor(private readonly logger: FastifyBaseLogger) {}

  async syncWithWorkspace(workspace: Workspace): Promise<void> {
    const activeIds = new Set(
      workspace.terminals.map((terminal) => terminal.id),
    );

    for (const terminal of workspace.terminals) {
      const existing = this.sessions.get(terminal.id);

      if (existing) {
        existing.terminal = terminal;
        continue;
      }

      this.createSession(terminal);
    }

    for (const [sessionId] of this.sessions) {
      if (!activeIds.has(sessionId)) {
        this.disposeSession(sessionId);
        this.broadcast({
          type: 'session.removed',
          sessionId,
        });
      }
    }
  }

  getSnapshots(): TerminalSessionSnapshot[] {
    return [...this.sessions.values()].map((record) => record.snapshot);
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

    record.pty.write(data);
    this.setSnapshot(
      record,
      createInputSnapshot(record.snapshot, new Date().toISOString()),
    );

    return true;
  }

  resizeSession(sessionId: string, cols: number, rows: number): boolean {
    const record = this.sessions.get(sessionId);

    if (!record) {
      return false;
    }

    const nextCols = clamp(cols, 20, 240);
    const nextRows = clamp(rows, 8, 120);

    record.pty?.resize(nextCols, nextRows);
    this.setSnapshot(
      record,
      createResizeSnapshot(record.snapshot, nextCols, nextRows),
    );

    return true;
  }

  restartSession(sessionId: string): boolean {
    const record = this.sessions.get(sessionId);

    if (!record) {
      return false;
    }

    this.disposePty(record);
    this.spawnTerminal(record);
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

  private createSession(terminal: TerminalNode): void {
    const record: SessionRecord = {
      terminal,
      pty: null,
      disposables: [],
      snapshot: createInitialSnapshot(terminal.id),
    };

    this.sessions.set(terminal.id, record);
    this.spawnTerminal(record);
  }

  private spawnTerminal(record: SessionRecord): void {
    const command = parseCommand(record.terminal.shell);
    const cwd = resolve(process.cwd(), record.terminal.cwd);
    const startedAt = new Date().toISOString();

    try {
      const pty = spawn(command.file, command.args, {
        name: 'xterm-256color',
        cwd,
        cols: record.snapshot.cols,
        rows: record.snapshot.rows,
        env: process.env,
      });

      record.pty = pty;
      record.disposables = [
        pty.onData((data) => {
          this.handleOutput(record, data);
        }),
        pty.onExit(({ exitCode, signal }) => {
          this.handleExit(record, exitCode, signal);
        }),
      ];

      this.logger.info(
        {
          sessionId: record.terminal.id,
          pid: pty.pid,
          shell: record.terminal.shell,
          cwd,
        },
        'Spawned PTY session',
      );

      this.setSnapshot(
        record,
        createRunningSnapshot({
          snapshot: record.snapshot,
          terminal: record.terminal,
          pid: pty.pid,
          startedAt,
        }),
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

  private handleOutput(record: SessionRecord, chunk: string): void {
    const timestamp = new Date().toISOString();

    this.broadcast({
      type: 'session.output',
      sessionId: record.terminal.id,
      data: chunk,
    });

    this.setSnapshot(
      record,
      createOutputSnapshot({
        snapshot: record.snapshot,
        terminal: record.terminal,
        chunk,
        timestamp,
      }),
    );
  }

  private handleExit(
    record: SessionRecord,
    exitCode: number,
    signal?: number,
  ): void {
    this.disposePty(record, false);

    this.setSnapshot(
      record,
      createExitSnapshot({
        snapshot: record.snapshot,
        exitCode,
        signal,
        timestamp: new Date().toISOString(),
      }),
    );
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

    this.disposePty(record);
    this.sessions.delete(sessionId);
  }

  private broadcast(message: TerminalServerSocketMessage): void {
    for (const listener of this.listeners) {
      listener(message);
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
