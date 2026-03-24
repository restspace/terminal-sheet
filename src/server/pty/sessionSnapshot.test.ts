import { describe, expect, it } from 'vitest';

import type { TerminalNode } from '../../shared/workspace';
import {
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
  estimateTerminalDimensionsFromNodeBounds,
} from '../../shared/terminalSizeConstraints';
import {
  applyAttentionEventSnapshot,
  createInputSnapshot,
  createExitSnapshot,
  createInitialSnapshot,
  createOutputSnapshot,
  createReadSnapshot,
  createResizeSnapshot,
  createRunningSnapshot,
} from './sessionSnapshot';

const terminal: TerminalNode = {
  id: 'terminal-1',
  backendId: 'local',
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
  it('uses conservative default PTY dimensions when no node bounds hint is provided', () => {
    const snapshot = createInitialSnapshot(terminal.id, 'local', terminal.agentType);

    expect(snapshot.cols).toBe(DEFAULT_TERMINAL_COLS);
    expect(snapshot.rows).toBe(DEFAULT_TERMINAL_ROWS);
  });

  it('estimates PTY dimensions from terminal node bounds with clamping', () => {
    const snapshot = createInitialSnapshot(
      terminal.id,
      'local',
      terminal.agentType,
      null,
      terminal.bounds,
    );
    const expected = estimateTerminalDimensionsFromNodeBounds(terminal.bounds);

    expect(snapshot.cols).toBe(expected.cols);
    expect(snapshot.rows).toBe(expected.rows);
  });

  it('creates a running snapshot with cleared output state', () => {
    const snapshot = createRunningSnapshot({
      snapshot: createInitialSnapshot(terminal.id, 'local', terminal.agentType),
      terminal,
      pid: 42,
      startedAt: '2026-03-09T20:00:00.000Z',
    });

    expect(snapshot.connected).toBe(true);
    expect(snapshot.pid).toBe(42);
    expect(snapshot.summary).toContain('started');
    expect(snapshot.commandState).toBe('running-command');
  });

  it('tracks output preview and unread counts', () => {
    const snapshot = createOutputSnapshot({
      snapshot: createRunningSnapshot({
        snapshot: createInitialSnapshot(terminal.id, 'local', terminal.agentType),
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
    expect(snapshot.commandState).toBe('running-command');
  });

  it('clears unread counts and updates size/exit state', () => {
    const withOutput = createOutputSnapshot({
      snapshot: createRunningSnapshot({
        snapshot: createInitialSnapshot(terminal.id, 'local', terminal.agentType),
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
    expect(exited.commandState).toBe('idle-at-prompt');
  });

  it('preserves attention status through output and clears it on input', () => {
    const attentionSnapshot = applyAttentionEventSnapshot(
      createRunningSnapshot({
        snapshot: createInitialSnapshot(terminal.id, 'local', terminal.agentType),
        terminal,
        pid: 42,
        startedAt: '2026-03-09T20:00:00.000Z',
      }),
      {
        id: 'attention-1',
        backendId: 'local',
        sessionId: terminal.id,
        source: 'claude',
        eventType: 'approval-needed',
        status: 'approval-needed',
        timestamp: '2026-03-09T20:00:01.000Z',
        title: 'Claude needs approval',
        detail: 'Review file edits',
        confidence: 'high',
      },
    );
    const afterOutput = createOutputSnapshot({
      snapshot: attentionSnapshot,
      terminal,
      chunk: 'still waiting...\r\n',
      timestamp: '2026-03-09T20:00:02.000Z',
    });
    const afterInput = createInputSnapshot(
      afterOutput,
      '2026-03-09T20:00:03.000Z',
    );

    expect(afterOutput.status).toBe('approval-needed');
    expect(afterInput.status).toBe('running');
    expect(afterInput.commandState).toBe('running-command');
  });
});
