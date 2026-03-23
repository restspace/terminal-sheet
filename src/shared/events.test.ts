import { describe, expect, it } from 'vitest';

import {
  ATTENTION_REQUIRED_STATUSES,
  isAttentionRequiredStatus,
  mapAttentionEventTypeToStatus,
  shouldNotifyForAttentionEvent,
} from './events';

describe('events helpers', () => {
  it('maps attention event types to terminal statuses', () => {
    expect(mapAttentionEventTypeToStatus('activity')).toBe('active-output');
    expect(mapAttentionEventTypeToStatus('needs-input')).toBe('needs-input');
    expect(mapAttentionEventTypeToStatus('approval-needed')).toBe('approval-needed');
    expect(mapAttentionEventTypeToStatus('completed')).toBe('completed');
    expect(mapAttentionEventTypeToStatus('failed')).toBe('failed');
    expect(mapAttentionEventTypeToStatus('disconnected')).toBe('disconnected');
  });

  it('flags only attention-required statuses', () => {
    for (const status of ATTENTION_REQUIRED_STATUSES) {
      expect(isAttentionRequiredStatus(status)).toBe(true);
    }

    expect(isAttentionRequiredStatus('running')).toBe(false);
    expect(isAttentionRequiredStatus('completed')).toBe(false);
  });

  it('suppresses notifications for plain activity', () => {
    expect(shouldNotifyForAttentionEvent({ eventType: 'activity' })).toBe(false);
    expect(shouldNotifyForAttentionEvent({ eventType: 'needs-input' })).toBe(true);
  });
});
