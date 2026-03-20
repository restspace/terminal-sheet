import type { TerminalSessionSnapshot } from '../../shared/terminalSessions';
import {
  MAX_LIVE_READ_ONLY_TERMINAL_PREVIEWS,
  type TerminalNode,
} from '../../shared/workspace';

export type TerminalPresentationMode = 'overview' | 'inspect' | 'focus';

export interface TerminalPresentationState {
  focusedTerminalId: string | null;
  inspectTerminalIds: string[];
  overviewTerminalIds: string[];
  presentationById: Map<string, TerminalPresentationMode>;
}

export function deriveTerminalPresentationState(options: {
  terminals: readonly TerminalNode[];
  selectedNodeId: string | null;
  sessions: Readonly<Record<string, TerminalSessionSnapshot>>;
  interactionAtByTerminalId: Readonly<Record<string, number>>;
}): TerminalPresentationState {
  const {
    terminals,
    selectedNodeId,
    sessions,
    interactionAtByTerminalId,
  } = options;
  const terminalOrder = new Map(
    terminals.map((terminal, index) => [terminal.id, index] as const),
  );
  const focusedTerminalId = terminals.some(
    (terminal) => terminal.id === selectedNodeId,
  )
    ? selectedNodeId
    : null;
  const inspectPreviewBudget = focusedTerminalId
    ? Math.max(0, MAX_LIVE_READ_ONLY_TERMINAL_PREVIEWS - 1)
    : MAX_LIVE_READ_ONLY_TERMINAL_PREVIEWS;
  const inspectTerminalIds = terminals
    .filter((terminal) => terminal.id !== focusedTerminalId)
    .sort((left, right) => {
      const leftInteractionAt = getEffectiveInteractionAt(
        left.id,
        sessions[left.id] ?? null,
        interactionAtByTerminalId,
      );
      const rightInteractionAt = getEffectiveInteractionAt(
        right.id,
        sessions[right.id] ?? null,
        interactionAtByTerminalId,
      );

      if (leftInteractionAt !== rightInteractionAt) {
        return rightInteractionAt - leftInteractionAt;
      }

      return (
        (terminalOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (terminalOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      );
    })
    .slice(0, inspectPreviewBudget)
    .map((terminal) => terminal.id);
  const inspectTerminalIdSet = new Set(inspectTerminalIds);
  const presentationById = new Map<string, TerminalPresentationMode>();
  const overviewTerminalIds: string[] = [];

  for (const terminal of terminals) {
    if (terminal.id === focusedTerminalId) {
      presentationById.set(terminal.id, 'focus');
      continue;
    }

    if (inspectTerminalIdSet.has(terminal.id)) {
      presentationById.set(terminal.id, 'inspect');
      continue;
    }

    presentationById.set(terminal.id, 'overview');
    overviewTerminalIds.push(terminal.id);
  }

  return {
    focusedTerminalId,
    inspectTerminalIds,
    overviewTerminalIds,
    presentationById,
  };
}

function getEffectiveInteractionAt(
  terminalId: string,
  session: TerminalSessionSnapshot | null,
  interactionAtByTerminalId: Readonly<Record<string, number>>,
): number {
  return Math.max(
    interactionAtByTerminalId[terminalId] ?? Number.NEGATIVE_INFINITY,
    parseTimestamp(session?.lastActivityAt),
    parseTimestamp(session?.lastOutputAt),
  );
}

function parseTimestamp(value: string | null | undefined): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }

  const timestamp = Date.parse(value);

  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}
