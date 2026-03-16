import { describe, expect, it } from 'vitest';

import type { AttentionEvent } from '../../shared/events';
import { createPlaceholderTerminal } from '../../shared/workspace';
import { buildAttentionFooterSummary } from './attentionSummary';

describe('buildAttentionFooterSummary', () => {
  it('returns an empty-state summary when there are no events', () => {
    const summary = buildAttentionFooterSummary({
      attentionEvents: [],
      attentionTerminalCount: 0,
      terminals: [],
    });

    expect(summary).toBe('No terminals need action | no recent activity');
  });

  it('includes the latest terminal label, detail, and relative time', () => {
    const terminal = createPlaceholderTerminal(0);
    const summary = buildAttentionFooterSummary({
      attentionEvents: [
        createAttentionEvent({
          sessionId: terminal.id,
          detail: 'Waiting for user approval before deploy.',
          timestamp: '2026-03-16T11:00:00.000Z',
        }),
      ],
      attentionTerminalCount: 2,
      terminals: [
        {
          ...terminal,
          label: 'Deploy Agent',
        },
      ],
      now: new Date('2026-03-16T11:05:00.000Z'),
    });

    expect(summary).toBe(
      '2 terminals need action | Deploy Agent: Waiting for user approval before deploy. (5m ago)',
    );
  });

  it('falls back to session id and truncates long details', () => {
    const summary = buildAttentionFooterSummary({
      attentionEvents: [
        createAttentionEvent({
          detail:
            'This activity detail is intentionally long so it should be clipped by the status bar summary renderer.',
          timestamp: '2026-03-16T11:00:00.000Z',
        }),
      ],
      attentionTerminalCount: 1,
      terminals: [],
      now: new Date('2026-03-16T11:10:00.000Z'),
    });

    expect(summary).toContain(
      '1 terminal needs action | terminal-1: This activity detail is intentionally long so it should be clipped by...',
    );
    expect(summary).toContain('(10m ago)');
  });
});

function createAttentionEvent(
  overrides: Partial<AttentionEvent> = {},
): AttentionEvent {
  return {
    id: 'attention-1',
    backendId: 'local',
    sessionId: 'terminal-1',
    source: 'codex',
    eventType: 'needs-input',
    status: 'needs-input',
    timestamp: '2026-03-16T11:00:00.000Z',
    title: 'Needs input',
    detail: 'Needs input',
    confidence: 'high',
    ...overrides,
  };
}
