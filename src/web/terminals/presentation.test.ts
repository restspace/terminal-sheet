import { describe, expect, it } from 'vitest';

import type { TerminalSessionSnapshot } from '../../shared/terminalSessions';
import { createPlaceholderTerminal } from '../../shared/workspace';
import {
  formatTerminalEventTime,
  getTerminalDisplayStatus,
  getTerminalIntegrationBadgeLabel,
  getTerminalIntegrationDisplayStatus,
  getTerminalIntegrationMessage,
  getTerminalLastEventAt,
  getTerminalLastMeaningfulLine,
  getTerminalRuntimePath,
  hasAttentionState,
} from './presentation';

function createSessionSnapshot(
  overrides: Partial<TerminalSessionSnapshot> = {},
): TerminalSessionSnapshot {
  return {
    sessionId: 'terminal-1',
    backendId: 'local',
    pid: 1234,
    status: 'running',
    commandState: 'running-command',
    connected: true,
    recoveryState: 'live',
    startedAt: '2026-03-09T16:00:00.000Z',
    lastActivityAt: '2026-03-09T16:02:00.000Z',
    lastOutputAt: '2026-03-09T16:03:00.000Z',
    lastOutputLine: 'finished lint pass',
    previewLines: ['npm run lint', 'finished lint pass'],
    scrollback: '',
    unreadCount: 2,
    summary: 'lint is running',
    exitCode: null,
    disconnectReason: null,
    cols: 100,
    rows: 30,
    liveCwd: 'C:/dev/terminal-sheet',
    projectRoot: 'C:/dev/terminal-sheet',
    integration: {
      owner: null,
      status: 'not-required',
      message: 'Integration is not required for shell sessions.',
      updatedAt: null,
    },
    ...overrides,
  };
}

describe('terminal presentation helpers', () => {
  it('prefers live session status over persisted terminal status', () => {
    const terminal = createPlaceholderTerminal(0);
    const session = createSessionSnapshot({ status: 'approval-needed' });

    expect(getTerminalDisplayStatus(terminal, session)).toBe('approval-needed');
  });

  it('identifies attention states', () => {
    expect(hasAttentionState('needs-input')).toBe(true);
    expect(hasAttentionState('running')).toBe(false);
  });

  it('surfaces the most meaningful terminal line first', () => {
    const terminal = createPlaceholderTerminal(0);
    const session = createSessionSnapshot();

    expect(getTerminalLastMeaningfulLine(terminal, session)).toBe(
      'finished lint pass',
    );
  });

  it('falls back from output lines to task labels when needed', () => {
    const terminal = createPlaceholderTerminal(0);
    const session = createSessionSnapshot({
      lastOutputLine: null,
      previewLines: [],
      summary: 'session waiting',
    });

    expect(getTerminalLastMeaningfulLine(terminal, session)).toBe(
      'session waiting',
    );
    expect(getTerminalLastMeaningfulLine(terminal, null)).toBeTruthy();
  });

  it('prefers output time over activity and start time', () => {
    const session = createSessionSnapshot();

    expect(getTerminalLastEventAt(session)).toBe('2026-03-09T16:03:00.000Z');
    expect(
      getTerminalLastEventAt(
        createSessionSnapshot({
          lastOutputAt: null,
        }),
      ),
    ).toBe('2026-03-09T16:02:00.000Z');
  });

  it('formats relative event times for recent activity', () => {
    expect(
      formatTerminalEventTime(
        '2026-03-09T16:59:45.000Z',
        new Date('2026-03-09T17:00:00.000Z'),
      ),
    ).toBe('Just now');
    expect(
      formatTerminalEventTime(
        '2026-03-09T16:30:00.000Z',
        new Date('2026-03-09T17:00:00.000Z'),
      ),
    ).toBe('30m ago');
  });

  it('formats integration labels and runtime paths from session context', () => {
    const terminal = createPlaceholderTerminal(0);
    const session = createSessionSnapshot({
      integration: {
        owner: 'claude',
        status: 'configured',
        message: 'Claude Notification hook already configured.',
        updatedAt: '2026-03-09T16:03:00.000Z',
      },
      liveCwd: 'C:/dev/terminal-sheet/packages/app',
      projectRoot: 'C:/dev/terminal-sheet',
    });

    expect(getTerminalIntegrationBadgeLabel(terminal, session)).toBe(
      'claude configured',
    );
    expect(getTerminalIntegrationDisplayStatus(terminal, session)).toBe(
      'configured',
    );
    expect(getTerminalIntegrationMessage(terminal, session)).toContain(
      'already configured',
    );
    expect(getTerminalRuntimePath(terminal, session, 'cwd')).toBe(
      'C:/dev/terminal-sheet/packages/app',
    );
    expect(getTerminalRuntimePath(terminal, session, 'root')).toBe(
      'C:/dev/terminal-sheet',
    );
  });

  it('falls back to generic integration copy when no session exists', () => {
    const terminal = createPlaceholderTerminal(0);

    expect(getTerminalIntegrationBadgeLabel(terminal, null)).toBe(
      'shell pending',
    );
    expect(getTerminalIntegrationDisplayStatus(terminal, null)).toBe(
      'pending',
    );
    expect(getTerminalIntegrationMessage(terminal, null)).toContain(
      'Waiting for PTY session snapshot',
    );
    expect(getTerminalRuntimePath(terminal, null, 'cwd')).toBe('.');
    expect(getTerminalRuntimePath(terminal, null, 'root')).toBe(
      'Waiting for project root detection.',
    );
  });

  it('uses pending integration copy for codex terminals before attach', () => {
    const terminal = {
      ...createPlaceholderTerminal(0),
      agentType: 'codex' as const,
    };

    expect(getTerminalIntegrationBadgeLabel(terminal, null)).toBe(
      'codex pending',
    );
    expect(getTerminalIntegrationDisplayStatus(terminal, null)).toBe(
      'pending',
    );
  });
});
