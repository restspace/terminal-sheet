import { describe, expect, it } from 'vitest';

import type { TerminalNode } from '../../shared/workspace';
import {
  createExitSnapshot,
  createInitialSnapshot,
  createOutputSnapshot,
  createReadSnapshot,
  createResizeSnapshot,
  createRunningSnapshot,
} from './sessionSnapshot';

const terminal: TerminalNode = {
  id: 'terminal-1',
  label: 'Shell 1',
  repoLabel: 'local workspace',
  taskLabel: 'live terminal session',
  shell: 'bash',
  cwd: '.',
  agentType: 'shell',
  status: 'idle',
  bounds: {
    x: 0,
    y: 0,
    width: 400,
    height: 280,
  },
  tags: [],
};

describe('session snapshot helpers', () => {
  it('creates a running snapshot with cleared output state', () => {
    const snapshot = createRunningSnapshot({
      snapshot: createInitialSnapshot(terminal.id),
      terminal,
      pid: 42,
      startedAt: '2026-03-09T20:00:00.000Z',
    });

    expect(snapshot.connected).toBe(true);
    expect(snapshot.pid).toBe(42);
    expect(snapshot.summary).toContain('started');
  });

  it('tracks output preview and unread counts', () => {
    const snapshot = createOutputSnapshot({
      snapshot: createRunningSnapshot({
        snapshot: createInitialSnapshot(terminal.id),
        terminal,
        pid: 42,
        startedAt: '2026-03-09T20:00:00.000Z',
      }),
      terminal,
      chunk: 'hello world\r\n',
      timestamp: '2026-03-09T20:00:01.000Z',
    });

    expect(snapshot.previewLines.at(-1)).toBe('hello world');
    expect(snapshot.unreadCount).toBe(1);
  });

  it('clears unread counts and updates size/exit state', () => {
    const withOutput = createOutputSnapshot({
      snapshot: createRunningSnapshot({
        snapshot: createInitialSnapshot(terminal.id),
        terminal,
        pid: 42,
        startedAt: '2026-03-09T20:00:00.000Z',
      }),
      terminal,
      chunk: 'hello world\r\n',
      timestamp: '2026-03-09T20:00:01.000Z',
    });

    const resized = createResizeSnapshot(withOutput, 120, 40);
    const read = createReadSnapshot(resized);
    const exited = createExitSnapshot({
      snapshot: read,
      exitCode: 1,
      timestamp: '2026-03-09T20:00:02.000Z',
    });

    expect(read.unreadCount).toBe(0);
    expect(resized.cols).toBe(120);
    expect(resized.rows).toBe(40);
    expect(exited.status).toBe('failed');
  });
});
