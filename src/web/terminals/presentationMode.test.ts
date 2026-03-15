import { describe, expect, it } from 'vitest';

import type { TerminalSessionSnapshot } from '../../shared/terminalSessions';
import {
  MAX_LIVE_READ_ONLY_TERMINAL_PREVIEWS,
  createPlaceholderTerminal,
} from '../../shared/workspace';
import { deriveTerminalPresentationState } from './presentationMode';

describe('deriveTerminalPresentationState', () => {
  it('always focuses the selected terminal', () => {
    const terminals = Array.from({ length: 4 }, (_, index) =>
      createPlaceholderTerminal(index),
    );
    const selectedTerminal = terminals[3];

    expect(selectedTerminal).toBeDefined();

    const sessions = buildSessions(terminals, {
      [selectedTerminal!.id]: {
        lastActivityAt: '2026-03-10T10:00:00.000Z',
      },
      [terminals[0]!.id]: {
        lastActivityAt: '2026-03-12T10:00:00.000Z',
      },
    });

    const result = deriveTerminalPresentationState({
      terminals,
      selectedNodeId: selectedTerminal!.id,
      sessions,
      interactionAtByTerminalId: {},
    });

    expect(result.focusedTerminalId).toBe(selectedTerminal!.id);
    expect(result.presentationById.get(selectedTerminal!.id)).toBe('focus');
    expect(result.inspectTerminalIds).not.toContain(selectedTerminal!.id);
  });

  it('uses the eight most recent non-selected terminals for inspect mode', () => {
    const terminals = Array.from({ length: 12 }, (_, index) =>
      createPlaceholderTerminal(index),
    );
    const selectedTerminal = terminals[0];

    expect(selectedTerminal).toBeDefined();

    const sessions = buildSessions(
      terminals,
      Object.fromEntries(
        terminals.map((terminal, index) => [
          terminal.id,
          {
            lastActivityAt: `2026-03-${String(12 - index).padStart(2, '0')}T10:00:00.000Z`,
          },
        ]),
      ),
    );

    const result = deriveTerminalPresentationState({
      terminals,
      selectedNodeId: selectedTerminal!.id,
      sessions,
      interactionAtByTerminalId: {},
    });

    expect(result.inspectTerminalIds).toHaveLength(
      MAX_LIVE_READ_ONLY_TERMINAL_PREVIEWS,
    );
    expect(result.inspectTerminalIds).toEqual(
      terminals.slice(1, 9).map((terminal) => terminal.id),
    );
    expect(result.overviewTerminalIds).toEqual(
      terminals.slice(9).map((terminal) => terminal.id),
    );
  });

  it('falls back to inspect mode when no terminal is selected', () => {
    const terminals = Array.from({ length: 3 }, (_, index) =>
      createPlaceholderTerminal(index),
    );
    const result = deriveTerminalPresentationState({
      terminals,
      selectedNodeId: null,
      sessions: {},
      interactionAtByTerminalId: {
        [terminals[1]!.id]: 2,
        [terminals[2]!.id]: 1,
      },
    });

    expect(result.focusedTerminalId).toBeNull();
    expect(result.inspectTerminalIds).toEqual([
      terminals[1]!.id,
      terminals[2]!.id,
      terminals[0]!.id,
    ]);
    expect(result.overviewTerminalIds).toEqual([]);
  });

  it('lets explicit frontend interactions outrank backend activity', () => {
    const terminals = Array.from({ length: 2 }, (_, index) =>
      createPlaceholderTerminal(index),
    );
    const sessions = buildSessions(terminals, {
      [terminals[0]!.id]: {
        lastOutputAt: '2026-03-11T10:00:00.000Z',
      },
      [terminals[1]!.id]: {
        lastOutputAt: '2026-03-10T10:00:00.000Z',
      },
    });

    const result = deriveTerminalPresentationState({
      terminals,
      selectedNodeId: null,
      sessions,
      interactionAtByTerminalId: {
        [terminals[1]!.id]: Date.parse('2026-03-12T10:00:00.000Z'),
      },
    });

    expect(result.inspectTerminalIds[0]).toBe(terminals[1]!.id);
  });

  it('breaks timestamp ties with terminal order', () => {
    const terminals = Array.from({ length: 3 }, (_, index) =>
      createPlaceholderTerminal(index),
    );
    const sessions = buildSessions(terminals, {
      [terminals[0]!.id]: {
        lastActivityAt: '2026-03-11T10:00:00.000Z',
      },
      [terminals[1]!.id]: {
        lastActivityAt: '2026-03-11T10:00:00.000Z',
      },
    });

    const result = deriveTerminalPresentationState({
      terminals,
      selectedNodeId: null,
      sessions,
      interactionAtByTerminalId: {},
    });

    expect(result.inspectTerminalIds.slice(0, 2)).toEqual([
      terminals[0]!.id,
      terminals[1]!.id,
    ]);
  });
});

function buildSessions(
  terminals: ReturnType<typeof createPlaceholderTerminal>[],
  overrides: Record<string, Partial<TerminalSessionSnapshot>>,
): Record<string, TerminalSessionSnapshot> {
  return Object.fromEntries(
    terminals.map((terminal) => [
      terminal.id,
      {
        sessionId: terminal.id,
        backendId: 'local',
        pid: null,
        status: 'idle',
        commandState: 'idle-at-prompt',
        connected: true,
        recoveryState: 'live',
        startedAt: null,
        lastActivityAt: null,
        lastOutputAt: null,
        lastOutputLine: null,
        previewLines: [],
        scrollback: '',
        unreadCount: 0,
        summary: terminal.label,
        exitCode: null,
        disconnectReason: null,
        cols: 80,
        rows: 24,
        liveCwd: terminal.cwd,
        projectRoot: terminal.cwd,
        integration: {
          owner: null,
          status: 'not-required',
          message: null,
          updatedAt: null,
        },
        ...overrides[terminal.id],
      } satisfies TerminalSessionSnapshot,
    ]),
  );
}
