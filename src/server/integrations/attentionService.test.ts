import { describe, expect, it, vi } from 'vitest';

import { AttentionService } from './attentionService';

describe('AttentionService', () => {
  it('normalizes Claude notification payloads into approval events', () => {
    const service = new AttentionService({
      receiverUrl: 'http://127.0.0.1:4312/api/attention',
      token: 'test-token',
    });

    const event = service.ingestExternalEvent('claude', {
      sessionId: 'terminal-1',
      notification_type: 'permission_request',
      message: 'Approve the proposed edits?',
    });

    expect(event?.eventType).toBe('approval-needed');
    expect(event?.source).toBe('claude');
    expect(event?.status).toBe('approval-needed');
  });

  it('normalizes Codex completion notifications', () => {
    const service = new AttentionService({
      receiverUrl: 'http://127.0.0.1:4312/api/attention',
      token: 'test-token',
    });

    const event = service.ingestExternalEvent('codex', {
      sessionId: 'terminal-2',
      event: 'agent-turn-complete',
      message: 'Task completed successfully',
    });

    expect(event?.eventType).toBe('completed');
    expect(event?.source).toBe('codex');
    expect(event?.status).toBe('completed');
  });

  it('normalizes Codex legacy notify payloads into completed events', () => {
    const service = new AttentionService({
      receiverUrl: 'http://127.0.0.1:4312/api/attention',
      token: 'test-token',
    });

    const event = service.ingestExternalEvent(
      'codex',
      {
        type: 'agent-turn-complete',
        'last-assistant-message': 'Rename complete and verified cargo build succeeds.',
        'input-messages': ['Rename foo to bar'],
      },
      'terminal-legacy',
    );

    expect(event?.eventType).toBe('completed');
    expect(event?.detail).toBe(
      'Rename complete and verified cargo build succeeds.',
    );
    expect(event?.source).toBe('codex');
  });

  it('detects low-confidence PTY waiting prompts', () => {
    const service = new AttentionService({
      receiverUrl: 'http://127.0.0.1:4312/api/attention',
      token: 'test-token',
    });

    const event = service.detectFromPtyOutput({
      sessionId: 'terminal-3',
      terminal: {
        id: 'terminal-3',
        backendId: 'local',
        label: 'Shell 3',
        repoLabel: 'local workspace',
        taskLabel: 'watch worker',
        shell: 'powershell.exe',
        cwd: '.',
        agentType: 'shell',
        status: 'running',
        bounds: {
          x: 0,
          y: 0,
          width: 400,
          height: 280,
        },
        tags: [],
      },
      snapshot: {
        sessionId: 'terminal-3',
        backendId: 'local',
        pid: 10,
        status: 'active-output',
        commandState: 'running-command',
        connected: true,
        recoveryState: 'live',
        startedAt: '2026-03-10T10:00:00.000Z',
        lastActivityAt: '2026-03-10T10:00:00.000Z',
        lastOutputAt: '2026-03-10T10:00:00.000Z',
        lastOutputLine: 'Press Enter to continue',
        previewLines: ['Press Enter to continue'],
        scrollback: 'Press Enter to continue',
        unreadCount: 1,
        summary: 'Press Enter to continue',
        exitCode: null,
        disconnectReason: null,
        cols: 100,
        rows: 30,
        liveCwd: 'C:/dev/terminal-sheet',
        projectRoot: 'C:/dev/terminal-sheet',
        integration: {
          owner: null,
          status: 'not-required',
          message: 'Integration is not required for shell sessions.',
          updatedAt: null,
        },
      },
      chunk: 'Press Enter to continue',
      timestamp: '2026-03-10T10:00:01.000Z',
    });

    expect(event?.eventType).toBe('needs-input');
    expect(event?.confidence).toBe('medium');
  });

  it('deduplicates repeated events in the same burst window', () => {
    const service = new AttentionService({
      receiverUrl: 'http://127.0.0.1:4312/api/attention',
      token: 'test-token',
    });

    const first = service.ingestExternalEvent('codex', {
      sessionId: 'terminal-4',
      event: 'agent-turn-complete',
      message: 'Task completed successfully',
      timestamp: '2026-03-10T10:00:00.000Z',
    });
    const second = service.ingestExternalEvent('codex', {
      sessionId: 'terminal-4',
      event: 'agent-turn-complete',
      message: 'Task completed successfully',
      timestamp: '2026-03-10T10:00:02.000Z',
    });

    expect(first).toBeTruthy();
    expect(second).toBeNull();
    expect(service.getEvents()).toHaveLength(1);
  });

  it('continues notifying later listeners when one listener throws', () => {
    const service = new AttentionService({
      receiverUrl: 'http://127.0.0.1:4312/api/attention',
      token: 'test-token',
    });
    const delivered = vi.fn();

    service.subscribe(() => {
      throw new Error('socket closed');
    });
    service.subscribe(delivered);

    expect(() =>
      service.ingestExternalEvent('codex', {
        sessionId: 'terminal-5',
        event: 'agent-turn-complete',
        message: 'Task completed successfully',
      }),
    ).not.toThrow();
    expect(delivered).toHaveBeenCalledTimes(1);
  });

  it('returns concrete Codex notify config snippets in setup helpers', () => {
    const service = new AttentionService({
      receiverUrl: 'http://127.0.0.1:4312/api/attention',
      token: 'test-token',
    });
    const setup = service.getSetup();

    expect(setup.bash.codexNotifyCommand).toContain('notify = [');
    expect(setup.bash.codexNotifyCommand).toContain(
      'TERMINAL_CANVAS_SESSION_ID',
    );
    expect(setup.bash.codexNotifyCommand).toContain(
      'TERMINAL_CANVAS_ATTENTION_URL/codex',
    );
    expect(setup.powershell.codexNotifyCommand).toContain('notify = [');
    expect(setup.powershell.codexNotifyCommand).toContain(
      'TERMINAL_CANVAS_ATTENTION_TOKEN',
    );
  });
});
