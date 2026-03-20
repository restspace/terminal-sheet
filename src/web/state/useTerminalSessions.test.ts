import { describe, expect, it } from 'vitest';

import type { AttentionEvent } from '../../shared/events';
import type {
  TerminalServerSocketMessage,
  TerminalSessionSnapshot,
} from '../../shared/terminalSessions';
import { createDefaultWorkspace } from '../../shared/workspace';
import {
  applyAttentionMessage,
  applyServerMessage,
  applyWorkspaceMessage,
  shouldPollSnapshots,
} from './useTerminalSessions';

describe('useTerminalSessions helpers', () => {
  it('keeps session state unchanged for attention messages', () => {
    const current = {};
    const message: TerminalServerSocketMessage = {
      type: 'attention.init',
      events: [],
    };

    expect(applyServerMessage(current, message)).toBe(current);
  });

  it('replaces and prepends attention event collections', () => {
    const initialEvent: AttentionEvent = {
      id: 'attention-1',
      backendId: 'local',
      sessionId: 'terminal-1',
      source: 'claude',
      eventType: 'needs-input',
      status: 'needs-input',
      timestamp: '2026-03-10T10:00:00.000Z',
      title: 'Claude needs input',
      detail: 'Please answer the follow-up question.',
      confidence: 'high',
    };
    const nextEvent: AttentionEvent = {
      ...initialEvent,
      id: 'attention-2',
      source: 'codex',
      eventType: 'completed',
      status: 'completed',
      title: 'Codex completed a task',
    };

    expect(
      applyAttentionMessage([], {
        type: 'attention.init',
        events: [initialEvent],
      }),
    ).toEqual([initialEvent]);
    expect(
      applyAttentionMessage([initialEvent], {
        type: 'attention.event',
        event: nextEvent,
      }),
    ).toEqual([nextEvent, initialEvent]);
  });

  it('applies workspace update messages separately from session state', () => {
    const workspace = createDefaultWorkspace();
    const nextWorkspace = {
      ...workspace,
      updatedAt: '2026-03-13T16:05:00.000Z',
    };
    const message: TerminalServerSocketMessage = {
      type: 'workspace.updated',
      workspace: nextWorkspace,
    };

    expect(applyServerMessage({}, message)).toEqual({});
    expect(applyWorkspaceMessage(null, message)).toEqual(nextWorkspace);
  });

  it('polls snapshots only while websocket is not open', () => {
    expect(shouldPollSnapshots('connecting')).toBe(true);
    expect(shouldPollSnapshots('closed')).toBe(true);
    expect(shouldPollSnapshots('error')).toBe(true);
    expect(shouldPollSnapshots('open')).toBe(false);
  });

  it('merges incremental output without requiring a full snapshot', () => {
    const currentSession = createSessionSnapshot({
      sessionId: 'terminal-1',
      scrollback: 'hello',
      unreadCount: 1,
      summary: 'hello',
    });

    const next = applyServerMessage(
      { 'terminal-1': currentSession },
      {
        type: 'session.output',
        sessionId: 'terminal-1',
        backendId: 'local',
        data: ' world',
        state: {
          ...toOutputState(currentSession),
          unreadCount: 2,
          summary: 'hello world',
        },
      },
    );

    expect(next['terminal-1']).toMatchObject({
      sessionId: 'terminal-1',
      backendId: 'local',
      scrollback: 'hello world',
      unreadCount: 2,
      summary: 'hello world',
    });
  });
});

function createSessionSnapshot(
  overrides: Partial<TerminalSessionSnapshot> = {},
): TerminalSessionSnapshot {
  return {
    sessionId: 'terminal-default',
    backendId: 'local',
    pid: null,
    status: 'running',
    commandState: 'running-command',
    connected: true,
    recoveryState: 'live',
    startedAt: '2026-03-20T12:00:00.000Z',
    lastActivityAt: '2026-03-20T12:00:00.000Z',
    lastOutputAt: '2026-03-20T12:00:00.000Z',
    lastOutputLine: 'hello',
    previewLines: ['hello'],
    scrollback: '',
    unreadCount: 0,
    summary: 'running',
    exitCode: null,
    disconnectReason: null,
    cols: 80,
    rows: 24,
    liveCwd: 'C:\\workspace',
    projectRoot: 'C:\\workspace',
    integration: {
      owner: null,
      status: 'not-required',
      message: null,
      updatedAt: null,
    },
    ...overrides,
  };
}

function toOutputState(snapshot: TerminalSessionSnapshot) {
  const { sessionId: _sessionId, backendId: _backendId, scrollback: _scrollback, ...state } =
    snapshot;
  void _sessionId;
  void _backendId;
  void _scrollback;

  return state;
}
