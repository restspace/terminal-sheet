import { describe, expect, it } from 'vitest';

import type { TerminalSessionSnapshot } from '../../shared/terminalSessions';
import {
  MAX_LIVE_READ_ONLY_TERMINAL_PREVIEWS,
  createPlaceholderTerminal,
} from '../../shared/workspace';
import { deriveTerminalSurfaceModelState } from './terminalSurfaceModel';

describe('deriveTerminalSurfaceModelState', () => {
  it('derives interactive focus and live previews from one explicit model', () => {
    const terminals = Array.from({ length: 3 }, (_, index) =>
      createPlaceholderTerminal(index),
    );
    const focusedTerminal = terminals[0];

    expect(focusedTerminal).toBeDefined();

    const result = deriveTerminalSurfaceModelState({
      terminals,
      selectedNodeId: focusedTerminal!.id,
      sessions: buildSessions(terminals),
      interactionAtByTerminalId: {},
      layoutMode: 'free',
    });

    expect(result.modelById.get(focusedTerminal!.id)).toEqual({
      presentationMode: 'focus',
      surfaceKind: 'live',
      acceptsInput: true,
    });
    expect(result.modelById.get(terminals[1]!.id)).toEqual({
      presentationMode: 'inspect',
      surfaceKind: 'live',
      acceptsInput: false,
    });
    expect(result.modelById.get(terminals[2]!.id)).toEqual({
      presentationMode: 'inspect',
      surfaceKind: 'live',
      acceptsInput: false,
    });
  });

  it('falls back to summary surfaces when sessions are missing', () => {
    const terminals = Array.from({ length: 2 }, (_, index) =>
      createPlaceholderTerminal(index),
    );

    const result = deriveTerminalSurfaceModelState({
      terminals,
      selectedNodeId: terminals[0]!.id,
      sessions: {
        [terminals[0]!.id]: buildSession(terminals[0]!.id),
      },
      interactionAtByTerminalId: {},
      layoutMode: 'focus-tiles',
    });

    expect(result.modelById.get(terminals[0]!.id)).toEqual({
      presentationMode: 'focus',
      surfaceKind: 'live',
      acceptsInput: true,
    });
    expect(result.modelById.get(terminals[1]!.id)).toEqual({
      presentationMode: 'inspect',
      surfaceKind: 'summary',
      acceptsInput: false,
    });
  });

  it('grants measured resize ownership to visible read-only live previews in focus-tiles', () => {
    const terminals = Array.from({ length: 6 }, (_, index) =>
      createPlaceholderTerminal(index),
    );
    const focusedTerminal = terminals[0]!;

    const result = deriveTerminalSurfaceModelState({
      terminals,
      selectedNodeId: focusedTerminal.id,
      sessions: buildSessions(terminals),
      interactionAtByTerminalId: {},
      layoutMode: 'focus-tiles',
    });

    expect(result.modelById.get(focusedTerminal.id)).toEqual({
      presentationMode: 'focus',
      surfaceKind: 'live',
      acceptsInput: true,
    });
    expect(result.inspectTerminalIds).toEqual(
      terminals.slice(1, 5).map((terminal) => terminal.id),
    );
    expect(result.modelById.get(terminals[1]!.id)).toEqual({
      presentationMode: 'inspect',
      surfaceKind: 'live',
      acceptsInput: false,
    });
    expect(result.modelById.get(terminals[5]!.id)).toEqual({
      presentationMode: 'overview',
      surfaceKind: 'summary',
      acceptsInput: false,
    });
  });

  it('keeps focus-tiles startup resize-correct with null selection by assigning visible read-only owners', () => {
    const terminals = Array.from({ length: 6 }, (_, index) =>
      createPlaceholderTerminal(index),
    );
    const result = deriveTerminalSurfaceModelState({
      terminals,
      selectedNodeId: null,
      sessions: buildSessions(terminals),
      interactionAtByTerminalId: {},
      layoutMode: 'focus-tiles',
    });

    expect(result.focusedTerminalId).toBeNull();
    expect(result.inspectTerminalIds).toEqual(
      terminals.slice(0, 5).map((terminal) => terminal.id),
    );
    for (const terminal of terminals.slice(0, 5)) {
      expect(result.modelById.get(terminal.id)).toEqual({
        presentationMode: 'inspect',
        surfaceKind: 'live',
        acceptsInput: false,
      });
    }
    expect(result.modelById.get(terminals[5]!.id)).toEqual({
      presentationMode: 'overview',
      surfaceKind: 'summary',
      acceptsInput: false,
    });
  });

  it('always focuses the selected terminal and excludes it from inspect previews', () => {
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
    const result = deriveTerminalSurfaceModelState({
      terminals,
      selectedNodeId: selectedTerminal!.id,
      sessions,
      interactionAtByTerminalId: {},
      layoutMode: 'free',
    });

    expect(result.focusedTerminalId).toBe(selectedTerminal!.id);
    expect(result.modelById.get(selectedTerminal!.id)?.presentationMode).toBe(
      'focus',
    );
    expect(result.inspectTerminalIds).not.toContain(selectedTerminal!.id);
  });

  it('keeps inspect previews within the live surface budget', () => {
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
    const result = deriveTerminalSurfaceModelState({
      terminals,
      selectedNodeId: selectedTerminal!.id,
      sessions,
      interactionAtByTerminalId: {},
      layoutMode: 'free',
    });

    expect(result.inspectTerminalIds).toHaveLength(
      MAX_LIVE_READ_ONLY_TERMINAL_PREVIEWS - 1,
    );
    expect(result.inspectTerminalIds).toEqual(
      terminals.slice(1, 8).map((terminal) => terminal.id),
    );
    expect(result.overviewTerminalIds).toEqual(
      terminals.slice(8).map((terminal) => terminal.id),
    );
  });

  it('falls back to inspect previews when no terminal is selected', () => {
    const terminals = Array.from({ length: 3 }, (_, index) =>
      createPlaceholderTerminal(index),
    );
    const result = deriveTerminalSurfaceModelState({
      terminals,
      selectedNodeId: null,
      sessions: {},
      interactionAtByTerminalId: {
        [terminals[1]!.id]: 2,
        [terminals[2]!.id]: 1,
      },
      layoutMode: 'free',
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
    const result = deriveTerminalSurfaceModelState({
      terminals,
      selectedNodeId: null,
      sessions,
      interactionAtByTerminalId: {
        [terminals[1]!.id]: Date.parse('2026-03-12T10:00:00.000Z'),
      },
      layoutMode: 'free',
    });

    expect(result.inspectTerminalIds[0]).toBe(terminals[1]!.id);
  });

  it('breaks recency ties with terminal order', () => {
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
    const result = deriveTerminalSurfaceModelState({
      terminals,
      selectedNodeId: null,
      sessions,
      interactionAtByTerminalId: {},
      layoutMode: 'free',
    });

    expect(result.inspectTerminalIds.slice(0, 2)).toEqual([
      terminals[0]!.id,
      terminals[1]!.id,
    ]);
  });
});

function buildSessions(
  terminals: ReturnType<typeof createPlaceholderTerminal>[],
  overrides: Record<string, Partial<TerminalSessionSnapshot>> = {},
): Record<string, TerminalSessionSnapshot> {
  return Object.fromEntries(
    terminals.map((terminal) => [
      terminal.id,
      buildSession(terminal.id, overrides[terminal.id]),
    ]),
  );
}

function buildSession(
  sessionId: string,
  overrides?: Partial<TerminalSessionSnapshot>,
): TerminalSessionSnapshot {
  const {
    appliedResizeGeneration = null,
    ...remainingOverrides
  } = overrides ?? {};
  return {
    sessionId,
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
    summary: sessionId,
    exitCode: null,
    disconnectReason: null,
    cols: 80,
    rows: 24,
    appliedResizeGeneration,
    liveCwd: '.',
    projectRoot: '.',
    integration: {
      owner: null,
      status: 'not-required',
      message: null,
      updatedAt: null,
    },
    ...remainingOverrides,
  };
}
