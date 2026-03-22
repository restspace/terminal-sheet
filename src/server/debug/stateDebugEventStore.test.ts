import { describe, expect, it } from 'vitest';

import type { StateDebugEvent } from '../../shared/debugState';
import { StateDebugEventStore } from './stateDebugEventStore';

describe('StateDebugEventStore', () => {
  it('stores and lists events by session', () => {
    const store = new StateDebugEventStore();
    const firstEvent = createEvent('2026-03-22T14:20:00.000Z', 'canvas', 'moveStart');
    const secondEvent = createEvent('2026-03-22T14:20:01.000Z', 'workspace', 'persistStart');

    store.append('session-a', [firstEvent]);
    store.append('session-b', [secondEvent]);

    expect(store.getEvents('session-a')).toEqual([firstEvent]);
    expect(store.listSessions()).toEqual([
      {
        sessionId: 'session-b',
        eventCount: 1,
        lastEventAt: secondEvent.timestamp,
      },
      {
        sessionId: 'session-a',
        eventCount: 1,
        lastEventAt: firstEvent.timestamp,
      },
    ]);
  });
});

function createEvent(
  timestamp: string,
  scope: string,
  event: string,
): StateDebugEvent {
  return {
    timestamp,
    scope,
    event,
    details: null,
  };
}
