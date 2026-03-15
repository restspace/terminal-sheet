import { describe, expect, it } from 'vitest';

import type { AttentionEvent } from '../../shared/events';
import type { TerminalServerSocketMessage } from '../../shared/terminalSessions';
import { createDefaultWorkspace } from '../../shared/workspace';
import {
  applyAttentionMessage,
  applyServerMessage,
  applyWorkspaceMessage,
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
});
