import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { constants } from 'node:fs';

export type ClaudeHookSetupPhase =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'conflict'
  | 'error';

export interface ClaudeHookSetupResult {
  phase: ClaudeHookSetupPhase;
  message: string;
  settingsPath: string;
  projectRoot: string;
}

interface ClaudeSettingsFile {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

const NOTIFICATION_EVENT = 'Notification';
const TOKEN_HEADER = 'x-terminal-canvas-token';
const SESSION_HEADER = 'x-terminal-canvas-session-id';
const ALLOWED_ENV_VARS = [
  'TERMINAL_CANVAS_ATTENTION_TOKEN',
  'TERMINAL_CANVAS_SESSION_ID',
] as const;

export async function prepareClaudeHookSetup(options: {
  projectRoot: string;
  attentionReceiverUrl: string;
}): Promise<ClaudeHookSetupResult> {
  try {
    const settingsPath = join(
      options.projectRoot,
      '.claude',
      'settings.local.json',
    );
    const managedEntry = createManagedNotificationEntry(
      `${stripTrailingSlash(options.attentionReceiverUrl)}/claude`,
    );
    const existing = await readSettingsIfPresent(settingsPath);

    if (existing === null) {
      await mkdir(dirname(settingsPath), { recursive: true });
      await writeFile(
        settingsPath,
        JSON.stringify(
          {
            hooks: {
              [NOTIFICATION_EVENT]: [managedEntry],
            },
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );

      return {
        phase: 'created',
        message: `Claude Notification hook created in ${settingsPath}.`,
        settingsPath,
        projectRoot: options.projectRoot,
      };
    }

    const mergeResult = mergeManagedNotificationHook(existing, managedEntry);

    if (mergeResult.phase === 'conflict') {
      return {
        phase: 'conflict',
        message: `Claude Notification hook setup skipped because ${settingsPath} already defines an incompatible Notification hook.`,
        settingsPath,
        projectRoot: options.projectRoot,
      };
    }

    if (mergeResult.phase === 'unchanged') {
      return {
        phase: 'unchanged',
        message: `Claude Notification hook already configured in ${settingsPath}.`,
        settingsPath,
        projectRoot: options.projectRoot,
      };
    }

    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify(mergeResult.settings, null, 2) + '\n',
      'utf8',
    );

    return {
      phase: mergeResult.phase,
      message: `Claude Notification hook ${mergeResult.phase} in ${settingsPath}.`,
      settingsPath,
      projectRoot: options.projectRoot,
    };
  } catch (error) {
    return {
      phase: 'error',
      message:
        error instanceof Error
          ? `Claude hook setup failed: ${error.message}`
          : 'Claude hook setup failed.',
      settingsPath: join(options.projectRoot, '.claude', 'settings.local.json'),
      projectRoot: options.projectRoot,
    };
  }
}

export function mergeManagedNotificationHook(
  settings: ClaudeSettingsFile,
  managedEntry: Record<string, unknown>,
): {
  phase: 'updated' | 'unchanged' | 'conflict';
  settings: ClaudeSettingsFile;
} {
  const hooks = settings.hooks;

  if (hooks === undefined) {
    return {
      phase: 'updated',
      settings: {
        ...settings,
        hooks: {
          [NOTIFICATION_EVENT]: [managedEntry],
        },
      },
    };
  }

  if (!isRecord(hooks)) {
    return {
      phase: 'conflict',
      settings,
    };
  }

  const currentNotification = hooks[NOTIFICATION_EVENT];

  if (currentNotification === undefined) {
    return {
      phase: 'updated',
      settings: {
        ...settings,
        hooks: {
          ...hooks,
          [NOTIFICATION_EVENT]: [managedEntry],
        },
      },
    };
  }

  if (!Array.isArray(currentNotification)) {
    return {
      phase: 'conflict',
      settings,
    };
  }

  if (!isManagedNotificationCollection(currentNotification)) {
    return {
      phase: 'conflict',
      settings,
    };
  }

  const nextSettings: ClaudeSettingsFile = {
    ...settings,
    hooks: {
      ...hooks,
      [NOTIFICATION_EVENT]: [managedEntry],
    },
  };

  return {
    phase:
      JSON.stringify(currentNotification) === JSON.stringify([managedEntry])
        ? 'unchanged'
        : 'updated',
    settings: nextSettings,
  };
}

function isManagedNotificationCollection(value: unknown[]): boolean {
  return value.length === 1 && isManagedNotificationEntry(value[0]);
}

function isManagedNotificationEntry(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const matcher = value.matcher;
  const hooks = value.hooks;

  if (matcher !== '' || !Array.isArray(hooks) || hooks.length !== 1) {
    return false;
  }

  return isManagedHttpHook(hooks[0]);
}

function isManagedHttpHook(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const allowedEnvVars = value.allowedEnvVars;

  return (
    value.type === 'http' &&
    typeof value.url === 'string' &&
    value.url.includes('/api/attention/claude') &&
    isRecord(value.headers) &&
    value.headers[TOKEN_HEADER] === '$TERMINAL_CANVAS_ATTENTION_TOKEN' &&
    value.headers[SESSION_HEADER] === '$TERMINAL_CANVAS_SESSION_ID' &&
    Array.isArray(allowedEnvVars) &&
    allowedEnvVars.length === ALLOWED_ENV_VARS.length &&
    ALLOWED_ENV_VARS.every((name) => allowedEnvVars.includes(name))
  );
}

function createManagedNotificationEntry(
  attentionReceiverUrl: string,
): Record<string, unknown> {
  return {
    matcher: '',
    hooks: [
      {
        type: 'http',
        url: attentionReceiverUrl,
        timeout: 30,
        headers: {
          [TOKEN_HEADER]: '$TERMINAL_CANVAS_ATTENTION_TOKEN',
          [SESSION_HEADER]: '$TERMINAL_CANVAS_SESSION_ID',
        },
        allowedEnvVars: [...ALLOWED_ENV_VARS],
      },
    ],
  };
}

async function readSettingsIfPresent(
  settingsPath: string,
): Promise<ClaudeSettingsFile | null> {
  try {
    await access(settingsPath, constants.F_OK);
  } catch {
    return null;
  }

  const raw = await readFile(settingsPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;

  if (!isRecord(parsed)) {
    throw new Error('Claude settings file does not contain a JSON object.');
  }

  return parsed as ClaudeSettingsFile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
