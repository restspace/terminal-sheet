import type { StateDebugEvent } from '../../shared/debugState';

interface StateDebugSessionSnapshot {
  sessionId: string;
  eventCount: number;
  lastEventAt: string | null;
}

const MAX_EVENTS_PER_SESSION = 2_000;

export class StateDebugEventStore {
  private readonly eventsBySessionId = new Map<string, StateDebugEvent[]>();

  append(sessionId: string, events: readonly StateDebugEvent[]): void {
    if (!events.length) {
      return;
    }

    const existing = this.eventsBySessionId.get(sessionId) ?? [];
    const next = [...existing, ...events];

    if (next.length > MAX_EVENTS_PER_SESSION) {
      next.splice(0, next.length - MAX_EVENTS_PER_SESSION);
    }

    this.eventsBySessionId.set(sessionId, next);
  }

  getEvents(sessionId: string): StateDebugEvent[] {
    return [...(this.eventsBySessionId.get(sessionId) ?? [])];
  }

  listSessions(): StateDebugSessionSnapshot[] {
    return [...this.eventsBySessionId.entries()]
      .map(([sessionId, events]) => ({
        sessionId,
        eventCount: events.length,
        lastEventAt: events.at(-1)?.timestamp ?? null,
      }))
      .sort((left, right) => {
        const leftTimestamp = left.lastEventAt ? Date.parse(left.lastEventAt) : 0;
        const rightTimestamp = right.lastEventAt ? Date.parse(right.lastEventAt) : 0;
        return rightTimestamp - leftTimestamp;
      });
  }
}
