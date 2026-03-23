import { describe, expect, it, vi } from 'vitest';

import { createDefaultWorkspace } from '../../shared/workspace';
import { LocalBackendAdapter } from './localBackendAdapter';

describe('LocalBackendAdapter', () => {
  it('delegates runtime operations to the local PTY and attention services', async () => {
    const workspace = createDefaultWorkspace();
    const sessionListener = vi.fn();
    const attentionListener = vi.fn();
    const unsubscribeSession = vi.fn();
    const unsubscribeAttention = vi.fn();
    const snapshots = [
      {
        sessionId: 'terminal-1',
      },
    ];
    const events = [
      {
        id: 'attention-1',
      },
    ];
    const ptySessionManager = {
      syncWithWorkspace: vi.fn(async () => {}),
      getSnapshots: vi.fn(() => snapshots),
      subscribe: vi.fn(() => unsubscribeSession),
      sendInput: vi.fn(() => true),
      resizeSession: vi.fn(() => true),
      restartSession: vi.fn(() => true),
      markRead: vi.fn(() => true),
    };
    const attentionService = {
      getEvents: vi.fn(() => events),
      subscribe: vi.fn(() => unsubscribeAttention),
    };
    const adapter = new LocalBackendAdapter(
      'local',
      ptySessionManager as never,
      attentionService as never,
      {
        warn: vi.fn(),
      } as never,
    );

    await adapter.syncWithWorkspace(workspace);

    expect(ptySessionManager.syncWithWorkspace).toHaveBeenCalledWith(workspace);
    expect(adapter.getSnapshots()).toBe(snapshots);
    expect(adapter.getAttentionEvents()).toBe(events);
    expect(adapter.getStatus()).toBeNull();
    expect(adapter.sendInput('terminal-1', 'ls')).toBe(true);
    expect(adapter.resizeSession('terminal-1', 120, 40)).toBe(true);
    expect(adapter.restartSession('terminal-1')).toBe(true);
    expect(adapter.markRead('terminal-1')).toBe(true);
    expect(typeof adapter.subscribeSession(sessionListener)).toBe('function');
    expect(typeof adapter.subscribeAttention(attentionListener)).toBe('function');
  });
});
