import type { TerminalSessionSnapshot } from '../../shared/terminalSessions';
import type { TerminalNode, TerminalStatus } from '../../shared/workspace';

const ATTENTION_STATUSES: readonly TerminalStatus[] = [
  'needs-input',
  'approval-needed',
  'failed',
  'disconnected',
];

export function getTerminalDisplayStatus(
  terminal: TerminalNode,
  session: TerminalSessionSnapshot | null,
): TerminalStatus {
  return session?.status ?? terminal.status;
}

export function hasAttentionState(status: TerminalStatus): boolean {
  return ATTENTION_STATUSES.includes(status);
}

export function getTerminalLastMeaningfulLine(
  terminal: TerminalNode,
  session: TerminalSessionSnapshot | null,
): string {
  const lastMeaningfulLine =
    session?.lastOutputLine?.trim() ??
    session?.previewLines.at(-1)?.trim() ??
    '';

  if (lastMeaningfulLine) {
    return lastMeaningfulLine;
  }

  return session?.summary ?? terminal.taskLabel ?? 'Waiting for session launch';
}

export function getTerminalLastEventAt(
  session: TerminalSessionSnapshot | null,
): string | null {
  return (
    session?.lastOutputAt ??
    session?.lastActivityAt ??
    session?.startedAt ??
    null
  );
}

export function formatTerminalEventTime(
  timestamp: string | null,
  now = new Date(),
): string {
  if (!timestamp) {
    return 'No recent events';
  }

  const eventDate = new Date(timestamp);

  if (!Number.isFinite(eventDate.getTime())) {
    return 'Event time unavailable';
  }

  const deltaMs = now.getTime() - eventDate.getTime();

  if (deltaMs < 45_000) {
    return 'Just now';
  }

  const deltaMinutes = Math.floor(deltaMs / 60_000);

  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }

  const deltaHours = Math.floor(deltaMinutes / 60);

  if (deltaHours < 24) {
    return `${deltaHours}h ago`;
  }

  const deltaDays = Math.floor(deltaHours / 24);

  if (deltaDays < 7) {
    return `${deltaDays}d ago`;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(eventDate);
}

export function getTerminalIntegrationBadgeLabel(
  terminal: TerminalNode,
  session: TerminalSessionSnapshot | null,
): string {
  if (!session) {
    return terminal.agentType === 'shell'
      ? 'shell pending'
      : `${terminal.agentType} pending`;
  }

  const owner = session?.integration.owner ?? getDefaultIntegrationOwner(terminal);
  const status = session?.integration.status ?? 'not-required';

  return `${owner} ${status}`;
}

export function getTerminalIntegrationMessage(
  terminal: TerminalNode,
  session: TerminalSessionSnapshot | null,
): string {
  if (!session) {
    return 'Waiting for PTY session snapshot.';
  }

  if (session?.integration.message?.trim()) {
    return session.integration.message;
  }

  if (terminal.agentType === 'shell') {
    return 'Integration is not required for shell sessions.';
  }

  return 'Waiting for integration state.';
}

export function getTerminalRuntimePath(
  terminal: TerminalNode,
  session: TerminalSessionSnapshot | null,
  kind: 'cwd' | 'root',
): string {
  if (kind === 'cwd') {
    return session?.liveCwd ?? terminal.cwd;
  }

  return session?.projectRoot ?? 'Waiting for project root detection.';
}

export function getTerminalIntegrationDisplayStatus(
  terminal: TerminalNode,
  session: TerminalSessionSnapshot | null,
): string {
  if (!session) {
    return terminal.agentType === 'shell' ? 'pending' : 'pending';
  }

  return session.integration.status;
}

function getDefaultIntegrationOwner(terminal: TerminalNode): string {
  if (terminal.agentType === 'shell') {
    return 'shell';
  }

  return terminal.agentType;
}
