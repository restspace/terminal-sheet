import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import {
  mergeManagedNotificationHook,
  prepareClaudeHookSetup,
} from './claudeHookSetup';

describe('mergeManagedNotificationHook', () => {
  it('adds the managed Notification hook when none exists', () => {
    const result = mergeManagedNotificationHook(
      { name: 'Example project' },
      managedEntry('http://127.0.0.1:4312/api/attention/claude'),
    );

    expect(result.phase).toBe('updated');
    expect(result.settings.hooks).toEqual({
      Notification: [
        managedEntry('http://127.0.0.1:4312/api/attention/claude'),
      ],
    });
    expect(result.settings.name).toBe('Example project');
  });

  it('treats an existing managed hook as unchanged', () => {
    const current = {
      hooks: {
        Notification: [
          managedEntry('http://127.0.0.1:4312/api/attention/claude'),
        ],
      },
      model: 'sonnet',
    };

    const result = mergeManagedNotificationHook(
      current,
      managedEntry('http://127.0.0.1:4312/api/attention/claude'),
    );

    expect(result.phase).toBe('unchanged');
    expect(result.settings).toEqual(current);
  });

  it('updates a managed hook when the receiver URL changes', () => {
    const result = mergeManagedNotificationHook(
      {
        hooks: {
          Notification: [
            managedEntry('http://127.0.0.1:9999/api/attention/claude'),
          ],
        },
      },
      managedEntry('http://127.0.0.1:4312/api/attention/claude'),
    );

    expect(result.phase).toBe('updated');
    expect(result.settings.hooks).toEqual({
      Notification: [
        managedEntry('http://127.0.0.1:4312/api/attention/claude'),
      ],
    });
  });

  it('flags conflicting Notification hooks conservatively', () => {
    const result = mergeManagedNotificationHook(
      {
        hooks: {
          Notification: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: 'echo custom',
                },
              ],
            },
          ],
        },
      },
      managedEntry('http://127.0.0.1:4312/api/attention/claude'),
    );

    expect(result.phase).toBe('conflict');
  });
});

describe('prepareClaudeHookSetup', () => {
  let tempDirectory: string | null = null;

  afterEach(async () => {
    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true, force: true });
      tempDirectory = null;
    }
  });

  it('creates a repo-local Claude settings file at the git root', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-claude-'));
    await mkdir(join(tempDirectory, '.git'));

    const result = await prepareClaudeHookSetup({
      projectRoot: tempDirectory,
      attentionReceiverUrl: 'http://127.0.0.1:4312/api/attention',
    });

    const settingsPath = join(tempDirectory, '.claude', 'settings.local.json');
    const raw = await readFile(settingsPath, 'utf8');

    expect(result.phase).toBe('created');
    expect(result.settingsPath).toBe(settingsPath);
    expect(raw).toContain('"Notification"');
    expect(raw).toContain('http://127.0.0.1:4312/api/attention/claude');
  });

  it('does not overwrite an incompatible existing Notification hook', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-claude-'));
    await mkdir(join(tempDirectory, '.git'));
    await mkdir(join(tempDirectory, '.claude'));
    await writeFile(
      join(tempDirectory, '.claude', 'settings.local.json'),
      JSON.stringify(
        {
          hooks: {
            Notification: [
              {
                matcher: '',
                hooks: [
                  {
                    type: 'command',
                    command: 'echo existing',
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const result = await prepareClaudeHookSetup({
      projectRoot: tempDirectory,
      attentionReceiverUrl: 'http://127.0.0.1:4312/api/attention',
    });
    const raw = await readFile(
      join(tempDirectory, '.claude', 'settings.local.json'),
      'utf8',
    );

    expect(result.phase).toBe('conflict');
    expect(raw).toContain('echo existing');
  });
});

function managedEntry(url: string) {
  return {
    matcher: '',
    hooks: [
      {
        type: 'http',
        url,
        timeout: 30,
        headers: {
          'x-terminal-canvas-token': '$TERMINAL_CANVAS_ATTENTION_TOKEN',
          'x-terminal-canvas-session-id': '$TERMINAL_CANVAS_SESSION_ID',
        },
        allowedEnvVars: [
          'TERMINAL_CANVAS_ATTENTION_TOKEN',
          'TERMINAL_CANVAS_SESSION_ID',
        ],
      },
    ],
  };
}
