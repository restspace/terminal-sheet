import type { AttentionEvent } from '../../shared/events';
import type { TerminalNode } from '../../shared/workspace';
import { formatTerminalEventTime } from '../terminals/presentation';

const MAX_SUMMARY_LENGTH = 72;

interface BuildAttentionFooterSummaryOptions {
  attentionEvents: AttentionEvent[];
  attentionTerminalCount: number;
  terminals: TerminalNode[];
  now?: Date;
}

export function buildAttentionFooterSummary(
  options: BuildAttentionFooterSummaryOptions,
): string {
  const latestEvent = options.attentionEvents[0];
  const actionSummary = formatAttentionActionSummary(options.attentionTerminalCount);

  if (!latestEvent) {
    return `${actionSummary} | no recent activity`;
  }

  const terminalLabel =
    options.terminals.find((terminal) => terminal.id === latestEvent.sessionId)
      ?.label ?? latestEvent.sessionId;
  const headline = truncateSummary(
    latestEvent.detail.trim() || latestEvent.title.trim() || latestEvent.eventType,
  );
  const eventTime = formatTerminalEventTime(latestEvent.timestamp, options.now);

  return `${actionSummary} | ${terminalLabel}: ${headline} (${eventTime})`;
}

function formatAttentionActionSummary(attentionTerminalCount: number): string {
  if (attentionTerminalCount === 1) {
    return '1 terminal needs action';
  }

  if (attentionTerminalCount > 1) {
    return `${attentionTerminalCount} terminals need action`;
  }

  return 'No terminals need action';
}

function truncateSummary(summary: string): string {
  const normalized = summary.replace(/\s+/g, ' ').trim();

  if (normalized.length <= MAX_SUMMARY_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_SUMMARY_LENGTH - 3).trimEnd()}...`;
}
