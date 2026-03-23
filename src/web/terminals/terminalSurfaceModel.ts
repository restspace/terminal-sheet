import type { TerminalSessionSnapshot } from '../../shared/terminalSessions';
import {
  MAX_LIVE_READ_ONLY_TERMINAL_PREVIEWS,
  type TerminalNode,
  type WorkspaceLayoutMode,
} from '../../shared/workspace';

export type TerminalPresentationMode = 'overview' | 'inspect' | 'focus';
export type TerminalSurfaceKind = 'interactive' | 'live-preview' | 'summary';
export type TerminalInteractionMode = 'interactive' | 'read-only';
export type TerminalSizeSource = 'measured' | 'snapshot';
export type TerminalResizeAuthority = 'owner' | 'none';

export interface TerminalSurfaceModel {
  presentationMode: TerminalPresentationMode;
  surfaceKind: TerminalSurfaceKind;
  interactionMode: TerminalInteractionMode;
  sizeSource: TerminalSizeSource;
  resizeAuthority: TerminalResizeAuthority;
}

export interface TerminalSurfaceModelState {
  focusedTerminalId: string | null;
  inspectTerminalIds: string[];
  overviewTerminalIds: string[];
  modelById: Map<string, TerminalSurfaceModel>;
}

export function deriveTerminalSurfaceModelState(options: {
  terminals: readonly TerminalNode[];
  selectedNodeId: string | null;
  sessions: Readonly<Record<string, TerminalSessionSnapshot>>;
  interactionAtByTerminalId: Readonly<Record<string, number>>;
  layoutMode: WorkspaceLayoutMode;
}): TerminalSurfaceModelState {
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
  const modelById = new Map<string, TerminalSurfaceModel>();
  const overviewTerminalIds: string[] = [];

  for (const terminal of terminals) {
    if (terminal.id === focusedTerminalId) {
      modelById.set(terminal.id, {
        presentationMode: 'focus',
        surfaceKind: sessions[terminal.id] ? 'interactive' : 'summary',
        interactionMode: 'interactive',
        sizeSource: 'measured',
        resizeAuthority: 'owner',
      });
      continue;
    }

    if (inspectTerminalIdSet.has(terminal.id)) {
      modelById.set(terminal.id, {
        presentationMode: 'inspect',
        surfaceKind: sessions[terminal.id] ? 'live-preview' : 'summary',
        interactionMode: 'read-only',
        sizeSource: 'snapshot',
        resizeAuthority: 'none',
      });
      continue;
    }

    modelById.set(terminal.id, {
      presentationMode: 'overview',
      surfaceKind: 'summary',
      interactionMode: 'read-only',
      sizeSource: 'snapshot',
      resizeAuthority: 'none',
    });
    overviewTerminalIds.push(terminal.id);
  }

  return {
    focusedTerminalId,
    inspectTerminalIds,
    overviewTerminalIds,
    modelById,
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
