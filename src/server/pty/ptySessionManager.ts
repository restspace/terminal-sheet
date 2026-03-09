import { resolve } from 'node:path';

import type { FastifyBaseLogger } from 'fastify';
import { spawn, type IDisposable, type IPty } from 'node-pty';

import {
  type TerminalServerSocketMessage,
  type TerminalSessionSnapshot,
} from '../../shared/terminalSessions';
import type {
  TerminalNode,
  TerminalStatus,
  Workspace,
} from '../../shared/workspace';
import { extractPreviewLines, renderTerminalText } from './outputPreview';

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const MAX_SCROLLBACK_CHARS = 120_000;

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
    this.updateSnapshot(record, {
      status: 'running',
      lastActivityAt: new Date().toISOString(),
    });

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
    this.updateSnapshot(record, {
      cols: nextCols,
      rows: nextRows,
    });

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

    this.updateSnapshot(record, {
      unreadCount: 0,
    });

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

      this.updateSnapshot(record, {
        pid: pty.pid,
        status: 'running',
        connected: true,
        recoveryState: 'live',
        startedAt,
        lastActivityAt: startedAt,
        lastOutputAt: null,
        lastOutputLine: null,
        previewLines: [],
        scrollback: '',
        unreadCount: 0,
        summary: `${record.terminal.shell} started in ${record.terminal.cwd}`,
        exitCode: null,
        disconnectReason: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(
        {
          sessionId: record.terminal.id,
          error: message,
        },
        'Failed to spawn PTY session',
      );

      this.updateSnapshot(record, {
        pid: null,
        status: 'disconnected',
        connected: false,
        recoveryState: 'spawn-failed',
        startedAt,
        summary: `Launch failed: ${message}`,
        exitCode: null,
        disconnectReason: message,
      });
    }
  }

  private handleOutput(record: SessionRecord, chunk: string): void {
    const timestamp = new Date().toISOString();
    const nextScrollback = appendScrollback(record.snapshot.scrollback, chunk);
    const readableOutput = renderTerminalText(nextScrollback);
    const previewLines = extractPreviewLines(readableOutput);
    const lastOutputLine =
      previewLines.at(-1) ?? record.snapshot.lastOutputLine;
    const unreadDelta = chunk.trim().length > 0 ? 1 : 0;

    this.broadcast({
      type: 'session.output',
      sessionId: record.terminal.id,
      data: chunk,
    });

    this.updateSnapshot(record, {
      status: 'active-output',
      connected: true,
      recoveryState: 'live',
      lastActivityAt: timestamp,
      lastOutputAt: timestamp,
      lastOutputLine,
      previewLines,
      scrollback: nextScrollback,
      unreadCount: record.snapshot.unreadCount + unreadDelta,
      summary:
        lastOutputLine ??
        `Running ${record.terminal.shell} in ${record.terminal.cwd}`,
    });
  }

  private handleExit(
    record: SessionRecord,
    exitCode: number,
    signal?: number,
  ): void {
    this.disposePty(record, false);

    const disconnectReason =
      signal === undefined
        ? `Exited with code ${exitCode}`
        : `Exited with code ${exitCode} (signal ${signal})`;

    const nextStatus: TerminalStatus = exitCode === 0 ? 'completed' : 'failed';

    this.updateSnapshot(record, {
      pid: null,
      connected: false,
      recoveryState: 'restartable',
      status: nextStatus,
      exitCode,
      disconnectReason,
      summary: disconnectReason,
      lastActivityAt: new Date().toISOString(),
    });
  }

  private updateSnapshot(
    record: SessionRecord,
    partialSnapshot: Partial<TerminalSessionSnapshot>,
  ): void {
    record.snapshot = {
      ...record.snapshot,
      ...partialSnapshot,
    };

    this.broadcast({
      type: 'session.snapshot',
      session: record.snapshot,
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

function createInitialSnapshot(sessionId: string): TerminalSessionSnapshot {
  return {
    sessionId,
    pid: null,
    status: 'idle',
    connected: false,
    recoveryState: 'restartable',
    startedAt: null,
    lastActivityAt: null,
    lastOutputAt: null,
    lastOutputLine: null,
    previewLines: [],
    scrollback: '',
    unreadCount: 0,
    summary: 'Session not started yet.',
    exitCode: null,
    disconnectReason: null,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  };
}

function parseCommand(commandLine: string): { file: string; args: string[] } {
  const parts = tokenizeCommandLine(commandLine.trim());

  if (!parts.length) {
    return {
      file: process.platform === 'win32' ? 'powershell.exe' : 'bash',
      args: [],
    };
  }

  return {
    file: normalizeExecutable(parts[0] ?? commandLine),
    args: parts.slice(1),
  };
}

function normalizeExecutable(file: string): string {
  if (process.platform !== 'win32') {
    return file;
  }

  const normalized = file.toLowerCase();

  if (normalized === 'powershell') {
    return 'powershell.exe';
  }

  if (normalized === 'pwsh') {
    return 'pwsh.exe';
  }

  if (normalized === 'cmd') {
    return 'cmd.exe';
  }

  if (/^[^\\/]+\.[a-z0-9]+$/i.test(file)) {
    return file;
  }

  if (!file.includes('\\') && !file.includes('/')) {
    return `${file}.exe`;
  }

  return file;
}

function tokenizeCommandLine(commandLine: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (const character of commandLine) {
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }

      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        parts.push(current);
        current = '';
      }

      continue;
    }

    current += character;
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

function appendScrollback(scrollback: string, chunk: string): string {
  const combined = scrollback + chunk;

  if (combined.length <= MAX_SCROLLBACK_CHARS) {
    return combined;
  }

  return combined.slice(combined.length - MAX_SCROLLBACK_CHARS);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
