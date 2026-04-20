import { randomBytes } from 'node:crypto';

import { LOCAL_BACKEND_ID } from '../../shared/backends';
import {
  type AttentionEvent,
  type AttentionEventConfidence,
  type AttentionEventSource,
  type AttentionEventType,
  type AttentionIntegrationSetup,
  mapAttentionEventTypeToStatus,
} from '../../shared/events';
import type { TerminalSessionSnapshot } from '../../shared/terminalSessions';
import type { TerminalNode } from '../../shared/workspace';
import { renderCodexNotifyTomlSnippet } from './codexNotifySetup';

const EVENT_HISTORY_LIMIT = 48;
const DEDUPE_WINDOW_MS = 4_000;

type AttentionEventListener = (event: AttentionEvent) => void;

type AttentionEventInput = Omit<AttentionEvent, 'id' | 'status' | 'backendId'> & {
  backendId?: AttentionEvent['backendId'];
  status?: AttentionEvent['status'];
};

interface ExternalAttentionPayload {
  sessionId?: string;
  source?: AttentionEventSource;
  eventType?: AttentionEventType | 'error';
  title?: string;
  detail?: string;
}

export class AttentionService {
  private readonly listeners = new Set<AttentionEventListener>();

  private readonly events: AttentionEvent[] = [];

  private readonly dedupeCache = new Map<
    string,
    {
      fingerprint: string;
      timestampMs: number;
    }
  >();

  private sequence = 0;

  private readonly setup: AttentionIntegrationSetup;

  private readonly backendId: string;

  constructor(options: {
    backendId?: string;
    receiverUrl: string;
    token?: string;
  }) {
    const token = options.token ?? randomBytes(24).toString('hex');
    this.backendId = options.backendId ?? LOCAL_BACKEND_ID;

    this.setup = {
      receiverUrl: options.receiverUrl,
      token,
      bash: {
        claudeHookCommand: buildBashSnippet('claude'),
        codexNotifyCommand: renderCodexNotifyTomlSnippet({
          shell: 'bash',
        }),
      },
      powershell: {
        claudeHookCommand: buildPowerShellSnippet('claude'),
        codexNotifyCommand: renderCodexNotifyTomlSnippet({
          shell: 'powershell',
        }),
      },
    };
  }

  getEvents(): AttentionEvent[] {
    return [...this.events];
  }

  getSetup(): AttentionIntegrationSetup {
    return this.setup;
  }

  validateToken(token: string | null | undefined): boolean {
    return Boolean(token && token === this.setup.token);
  }

  subscribe(listener: AttentionEventListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  ingestExternalEvent(
    source: Exclude<AttentionEventSource, 'pty'>,
    payload: unknown,
    sessionIdOverride?: string,
  ): AttentionEvent | null {
    const candidate =
      source === 'claude'
        ? normalizeClaudeAttentionPayload(payload, sessionIdOverride)
        : normalizeCodexAttentionPayload(payload, sessionIdOverride);

    if (!candidate) {
      return null;
    }

    return this.record(candidate);
  }

  detectFromPtyOutput(options: {
    sessionId: string;
    terminal: TerminalNode;
    snapshot: TerminalSessionSnapshot;
    chunk: string;
    timestamp: string;
  }): AttentionEvent | null {
    const detection = detectPtyAttentionSignal(options.chunk);

    if (!detection) {
      return null;
    }

    const fallbackDetail =
      options.snapshot.lastOutputLine ??
      options.snapshot.summary ??
      `PTY activity detected in ${options.terminal.label}`;

    return this.record({
      sessionId: options.sessionId,
      source: 'pty',
      eventType: detection.eventType,
      timestamp: options.timestamp,
      title: detection.title,
      detail: fallbackDetail,
      confidence: detection.confidence,
    });
  }

  record(input: AttentionEventInput): AttentionEvent | null {
    const status = input.status ?? mapAttentionEventTypeToStatus(input.eventType);
    const event: AttentionEvent = {
      ...input,
      backendId: input.backendId ?? this.backendId,
      status,
      id: `attention-${Date.now()}-${this.sequence}`,
    };
    this.sequence += 1;

    const fingerprint = [
      event.sessionId,
      event.source,
      event.eventType,
      normalizeText(event.title),
      normalizeText(event.detail),
    ].join('|');
    const nowMs = Date.parse(event.timestamp);
    const dedupeKey = `${event.sessionId}:${event.source}`;
    const existing = this.dedupeCache.get(dedupeKey);

    if (
      existing &&
      existing.fingerprint === fingerprint &&
      Number.isFinite(nowMs) &&
      nowMs - existing.timestampMs <= DEDUPE_WINDOW_MS
    ) {
      return null;
    }

    if (Number.isFinite(nowMs)) {
      this.dedupeCache.set(dedupeKey, {
        fingerprint,
        timestampMs: nowMs,
      });
    }

    this.events.unshift(event);
    this.events.splice(EVENT_HISTORY_LIMIT);

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Ignore listener failures so one stale subscriber cannot break delivery.
      }
    }

    return event;
  }
}

function normalizeClaudeAttentionPayload(
  payload: unknown,
  sessionIdOverride?: string,
): AttentionEventInput | null {
  const candidate = readExternalAttentionPayload(payload, sessionIdOverride);

  if (!candidate?.sessionId) {
    return null;
  }

  const detail =
    candidate.detail ??
    getStringProperty(payload, 'message') ??
    getStringProperty(payload, 'description') ??
    'Claude requested attention.';
  const notificationType =
    getStringProperty(payload, 'notification_type') ??
    getStringProperty(payload, 'notificationType') ??
    getStringProperty(payload, 'hook_event_name') ??
    getStringProperty(payload, 'event') ??
    '';
  const eventType = resolveEventType(notificationType, detail, candidate.eventType, {
    fallback: 'needs-input',
  });
  const title =
    candidate.title ??
    buildDefaultTitle('claude', eventType, getStringProperty(payload, 'title'));

  return {
    sessionId: candidate.sessionId,
    source: 'claude',
    eventType,
    timestamp: getTimestamp(payload),
    title,
    detail,
    confidence: candidate.eventType ? 'high' : 'medium',
  };
}

function normalizeCodexAttentionPayload(
  payload: unknown,
  sessionIdOverride?: string,
): AttentionEventInput | null {
  const candidate = readExternalAttentionPayload(payload, sessionIdOverride);

  if (!candidate?.sessionId) {
    return null;
  }

  const eventName =
    getStringProperty(payload, 'event') ??
    getStringProperty(payload, 'eventType') ??
    getStringProperty(payload, 'type') ??
    getStringProperty(payload, 'kind') ??
    '';
  const detail =
    candidate.detail ??
    getStringProperty(payload, 'message') ??
    getStringProperty(payload, 'description') ??
    getStringProperty(payload, 'last-assistant-message') ??
    getStringArrayProperty(payload, 'input-messages')?.[0] ??
    'Codex emitted a notification.';
  const eventType = resolveEventType(eventName, detail, candidate.eventType, {
    fallback: 'activity',
  });
  const title =
    candidate.title ??
    buildDefaultTitle('codex', eventType, getStringProperty(payload, 'title'));

  return {
    sessionId: candidate.sessionId,
    source: 'codex',
    eventType,
    timestamp: getTimestamp(payload),
    title,
    detail,
    confidence:
      candidate.eventType || eventName.trim().length > 0 ? 'high' : 'medium',
  };
}

function readExternalAttentionPayload(
  payload: unknown,
  sessionIdOverride?: string,
): ExternalAttentionPayload | null {
  if (!payload || typeof payload !== 'object') {
    return sessionIdOverride
      ? {
          sessionId: sessionIdOverride,
        }
      : null;
  }

  const sessionId =
    sessionIdOverride ??
    getStringProperty(payload, 'sessionId') ??
    getStringProperty(payload, 'session_id') ??
    getStringProperty(payload, 'terminalId') ??
    getStringProperty(payload, 'terminal_id') ??
    getStringProperty(payload, 'nodeId') ??
    getStringProperty(payload, 'node_id');
  const source = readSource(getStringProperty(payload, 'source'));
  const eventType = readEventType(
    getStringProperty(payload, 'eventType') ??
      getStringProperty(payload, 'event_type') ??
      getStringProperty(payload, 'status'),
  );

  return {
    sessionId,
    source,
    eventType,
    title: getStringProperty(payload, 'title'),
    detail: getStringProperty(payload, 'detail'),
  };
}

function detectPtyAttentionSignal(chunk: string): {
  eventType: AttentionEventType;
  title: string;
  confidence: AttentionEventConfidence;
} | null {
  const combinedText = stripAnsiEscapes(chunk).toLowerCase();

  if (hasOscSequence(chunk)) {
    return {
      eventType: 'activity',
      title: 'Terminal emitted an OSC notification',
      confidence: 'low',
    };
  }

  if (/\[y\/n\]|\(y\/n\)|approve|permission|allow this|continue\?/i.test(combinedText)) {
    return {
      eventType: 'approval-needed',
      title: 'Terminal is waiting for approval',
      confidence: 'medium',
    };
  }

  if (
    /press enter|waiting for input|waiting on you|hit any key|provide input|enter to continue/i.test(
      combinedText,
    )
  ) {
    return {
      eventType: 'needs-input',
      title: 'Terminal is waiting for input',
      confidence: 'medium',
    };
  }

  if (chunk.includes('\u0007')) {
    return {
      eventType: 'needs-input',
      title: 'Terminal bell rang',
      confidence: 'low',
    };
  }

  return null;
}

function hasOscSequence(chunk: string): boolean {
  const oscStart = '\u001b]';

  if (!chunk.includes(oscStart)) {
    return false;
  }

  return chunk.includes('\u0007') || chunk.includes('\u001b\\');
}

function buildDefaultTitle(
  source: Exclude<AttentionEventSource, 'pty'>,
  eventType: AttentionEventType,
  fallback?: string,
): string {
  if (fallback?.trim()) {
    return fallback.trim();
  }

  const sourceLabel = source === 'claude' ? 'Claude' : 'Codex';

  switch (eventType) {
    case 'needs-input':
      return `${sourceLabel} needs input`;
    case 'approval-needed':
      return `${sourceLabel} needs approval`;
    case 'completed':
      return `${sourceLabel} completed a task`;
    case 'failed':
      return `${sourceLabel} reported an error`;
    case 'disconnected':
      return `${sourceLabel} disconnected`;
    case 'activity':
      return `${sourceLabel} activity`;
  }
}

function resolveEventType(
  eventName: string,
  detail: string,
  explicitEventType: ExternalAttentionPayload['eventType'],
  options: {
    fallback: AttentionEventType;
  },
): AttentionEventType {
  if (explicitEventType === 'error') {
    return 'failed';
  }

  if (explicitEventType) {
    return explicitEventType;
  }

  const combined = `${eventName}\n${detail}`.toLowerCase();

  if (/approval|permission|confirm|review/.test(combined)) {
    return 'approval-needed';
  }

  if (/needs[-\s]?input|waiting|prompt|input required|respond/.test(combined)) {
    return 'needs-input';
  }

  if (/complete|completed|done|turn complete|turn-complete|finished/.test(combined)) {
    return 'completed';
  }

  if (/disconnect|disconnected/.test(combined)) {
    return 'disconnected';
  }

  if (/error|failed|failure|crash/.test(combined)) {
    return 'failed';
  }

  return options.fallback;
}

function getTimestamp(payload: unknown): string {
  return (
    getStringProperty(payload, 'timestamp') ??
    getStringProperty(payload, 'time') ??
    new Date().toISOString()
  );
}

function readSource(
  source: string | null | undefined,
): AttentionEventSource | undefined {
  switch (normalizeText(source)) {
    case 'claude':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'pty':
      return 'pty';
    default:
      return undefined;
  }
}

function readEventType(
  eventType: string | null | undefined,
): AttentionEventType | 'error' | undefined {
  switch (normalizeText(eventType)) {
    case 'activity':
      return 'activity';
    case 'needs-input':
    case 'needsinput':
      return 'needs-input';
    case 'approval-needed':
    case 'approvalneeded':
      return 'approval-needed';
    case 'completed':
    case 'complete':
      return 'completed';
    case 'failed':
    case 'failure':
      return 'failed';
    case 'error':
      return 'error';
    case 'disconnected':
    case 'disconnect':
      return 'disconnected';
    default:
      return undefined;
  }
}

function getStringProperty(
  payload: unknown,
  key: string,
): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const value = (payload as Record<string, unknown>)[key];

  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getStringArrayProperty(
  payload: unknown,
  key: string,
): string[] | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const value = (payload as Record<string, unknown>)[key];

  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value.filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0,
  );

  return items.length ? items : undefined;
}

function normalizeText(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1b(?:\[[^a-zA-Z]*[a-zA-Z]|\][^\x07]*\x07|\].)/g;

function stripAnsiEscapes(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, '');
}

function buildBashSnippet(source: 'claude'): string {
  return [
    `curl -sS -X POST "$TERMINAL_CANVAS_ATTENTION_URL/${source}" \\`,
    '  -H "Content-Type: application/json" \\',
    '  -H "x-terminal-canvas-token: $TERMINAL_CANVAS_ATTENTION_TOKEN" \\',
    '  -d "{\\"sessionId\\":\\"$TERMINAL_CANVAS_SESSION_ID\\",\\"title\\":\\"' +
      'Claude notification' +
      '\\",\\"message\\":\\"Replace this with the real notify payload\\",\\"eventType\\":\\"activity\\"}"',
  ].join('\n');
}

function buildPowerShellSnippet(source: 'claude'): string {
  return [
    '$body = @{',
    '  sessionId = $env:TERMINAL_CANVAS_SESSION_ID',
    "  title = 'Claude notification'",
    "  message = 'Replace this with the real notify payload'",
    "  eventType = 'activity'",
    '} | ConvertTo-Json',
    `Invoke-RestMethod -Method Post -Uri "$env:TERMINAL_CANVAS_ATTENTION_URL/${source}" ` +
      "-Headers @{ 'x-terminal-canvas-token' = $env:TERMINAL_CANVAS_ATTENTION_TOKEN } " +
      '-ContentType "application/json" -Body $body',
  ].join('\n');
}
