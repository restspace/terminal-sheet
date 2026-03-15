#!/usr/bin/env node

import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import open from 'open';

import type { ServerRole } from '../shared/backends';
import { LOCAL_BACKEND_ID } from '../shared/backends';
import { createServer } from '../server/app';
import {
  loadOrCreateServerIdentity,
  resolveServerIdentityFilePath,
  rotateServerIdentityToken,
} from '../server/persistence/serverIdentityStore';
import { resolveWorkspaceFilePath } from '../server/persistence/workspaceStore';

const DEFAULT_PORT = 4312;
const DEFAULT_SERVER_URL = `http://127.0.0.1:${DEFAULT_PORT}`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main(): Promise<void> {
  const { positionals } = parseArgs({
    allowPositionals: true,
    options: {},
    strict: false,
  });
  const [command, ...rest] = positionals;

  if (!command || command.startsWith('-')) {
    await runServeCommand([command, ...rest].filter(isString));
    return;
  }

  switch (command) {
    case 'serve':
      await runServeCommand(rest);
      return;
    case 'open':
      await runOpenCommand(rest);
      return;
    case 'token':
      await runTokenCommand(rest);
      return;
    case 'backend':
      await runBackendCommand(rest);
      return;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function runServeCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      port: {
        type: 'string',
        default: String(DEFAULT_PORT),
      },
      workspace: {
        type: 'string',
      },
      role: {
        type: 'string',
        default: 'standalone',
      },
      'no-open': {
        type: 'boolean',
        default: false,
      },
    },
  });

  const port = Number.parseInt(values.port, 10);

  if (!Number.isFinite(port)) {
    throw new Error(`Invalid port: ${values.port}`);
  }

  const role = parseServerRole(values.role);
  const workspaceFilePath = resolveWorkspaceFilePath(values.workspace);
  const identityFilePath = resolveServerIdentityFilePath(workspaceFilePath);
  const identity = await loadOrCreateServerIdentity(identityFilePath);
  const devWebUrl = process.env.TERMINAL_CANVAS_DEV_WEB_URL;
  const webRoot = await resolveWebRoot();
  const app = await createServer({
    port,
    role,
    serverId: identity.serverId,
    localBackendId: LOCAL_BACKEND_ID,
    machineToken: identity.machineToken,
    workspaceFilePath,
    contentRoot: process.cwd(),
    devWebUrl,
    webRoot,
  });

  const host = '127.0.0.1';
  await app.listen({ host, port });

  const launchUrl = `http://${host}:${port}`;
  app.log.info(`Terminal Sheet listening at ${launchUrl}`);
  app.log.info(`Workspace file: ${workspaceFilePath}`);
  app.log.info(`Server role: ${role}`);
  app.log.info(`Machine token file: ${identityFilePath}`);

  if (!values['no-open']) {
    await open(launchUrl);
  }

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function runOpenCommand(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      server: {
        type: 'string',
        default: DEFAULT_SERVER_URL,
      },
    },
  });
  const filePath = positionals[0];

  if (!filePath?.trim()) {
    throw new Error('Usage: tsheet open <path> [--server <url>]');
  }

  const response = await fetchJson(resolveUrl(values.server, '/api/markdown/open'), {
    method: 'POST',
    body: {
      filePath,
      createIfMissing: true,
    },
  });
  const nodeId =
    typeof response.node === 'object' &&
    response.node &&
    'id' in response.node &&
    typeof response.node.id === 'string'
      ? response.node.id
      : 'unknown-node';

  console.log(
    `Opened ${filePath} on ${normalizeBaseUrl(values.server)} as ${nodeId}`,
  );
}

async function runTokenCommand(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;

  switch (subcommand) {
    case 'show': {
      const { values } = parseArgs({
        args: rest,
        allowPositionals: false,
        options: {
          workspace: {
            type: 'string',
          },
        },
      });
      const workspaceFilePath = resolveWorkspaceFilePath(values.workspace);
      const identity = await loadOrCreateServerIdentity(
        resolveServerIdentityFilePath(workspaceFilePath),
      );

      console.log(`serverId=${identity.serverId}`);
      console.log(`machineToken=${identity.machineToken}`);
      return;
    }
    case 'rotate': {
      const { values } = parseArgs({
        args: rest,
        allowPositionals: false,
        options: {
          workspace: {
            type: 'string',
          },
        },
      });
      const workspaceFilePath = resolveWorkspaceFilePath(values.workspace);
      const identity = await rotateServerIdentityToken(
        resolveServerIdentityFilePath(workspaceFilePath),
      );

      console.log(`serverId=${identity.serverId}`);
      console.log(`machineToken=${identity.machineToken}`);
      return;
    }
    default:
      throw new Error('Usage: tsheet token <show|rotate> [--workspace <path>]');
  }
}

async function runBackendCommand(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;

  switch (subcommand) {
    case 'add': {
      const { values } = parseArgs({
        args: rest,
        allowPositionals: false,
        options: {
          server: {
            type: 'string',
            default: DEFAULT_SERVER_URL,
          },
          label: {
            type: 'string',
          },
          url: {
            type: 'string',
          },
          token: {
            type: 'string',
          },
        },
      });

      if (!values.label || !values.url || !values.token) {
        throw new Error(
          'Usage: tsheet backend add --label <name> --url <remote-url> --token <token> [--server <url>]',
        );
      }

      const response = await fetchJson(resolveUrl(values.server, '/api/backends'), {
        method: 'POST',
        body: {
          label: values.label,
          baseUrl: values.url,
          token: values.token,
        },
      });
      const backendId =
        typeof response.backend === 'object' &&
        response.backend &&
        'id' in response.backend &&
        typeof response.backend.id === 'string'
          ? response.backend.id
          : values.label;
      const importedTerminalCount =
        typeof response.importedTerminalCount === 'number'
          ? response.importedTerminalCount
          : 0;

      console.log(
        `Added backend ${backendId} and imported ${importedTerminalCount} terminals.`,
      );
      return;
    }
    case 'list': {
      const { values } = parseArgs({
        args: rest,
        allowPositionals: false,
        options: {
          server: {
            type: 'string',
            default: DEFAULT_SERVER_URL,
          },
        },
      });
      const response = await fetchJson(resolveUrl(values.server, '/api/backends'));
      const backends = Array.isArray(response.backends) ? response.backends : [];

      if (!backends.length) {
        console.log('No remote backends configured.');
        return;
      }

      for (const backend of backends) {
        const state = backend.status?.state ?? (backend.enabled ? 'configured' : 'disabled');
        console.log(`${backend.id}\t${backend.label}\t${backend.baseUrl}\t${state}`);
      }
      return;
    }
    case 'remove': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          server: {
            type: 'string',
            default: DEFAULT_SERVER_URL,
          },
        },
      });
      const backendId = positionals[0];

      if (!backendId) {
        throw new Error('Usage: tsheet backend remove <backend-id> [--server <url>]');
      }

      await fetchJson(resolveUrl(values.server, `/api/backends/${encodeURIComponent(backendId)}`), {
        method: 'DELETE',
      });
      console.log(`Removed backend ${backendId}.`);
      return;
    }
    default:
      throw new Error('Usage: tsheet backend <add|list|remove> ...');
  }
}

async function fetchJson(
  url: string,
  options?: {
    method?: string;
    body?: object;
  },
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: options?.method ?? 'GET',
    headers: options?.body
      ? {
          'Content-Type': 'application/json',
        }
      : undefined,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      text || `Server request failed with ${response.status} for ${url}`,
    );
  }

  return response.json();
}

function parseServerRole(value: string): ServerRole {
  if (value === 'standalone' || value === 'home' || value === 'remote') {
    return value;
  }

  throw new Error(`Invalid role: ${value}`);
}

async function resolveWebRoot(): Promise<string | undefined> {
  const candidate = resolve(__dirname, '..', 'web');
  const indexHtmlPath = resolve(candidate, 'index.html');

  try {
    await access(candidate, constants.F_OK);
    await access(indexHtmlPath, constants.F_OK);
    return candidate;
  } catch {
    return undefined;
  }
}

function resolveUrl(baseUrl: string, path: string): string {
  return new URL(path, `${normalizeBaseUrl(baseUrl)}/`).toString();
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function isString(value: string | undefined): value is string {
  return typeof value === 'string';
}

function printHelp(): void {
  console.log(`tsheet commands:
  tsheet serve [--port <n>] [--workspace <path>] [--role <standalone|home|remote>] [--no-open]
  tsheet open <path> [--server <url>]
  tsheet token <show|rotate> [--workspace <path>]
  tsheet backend add --label <name> --url <remote-url> --token <token> [--server <url>]
  tsheet backend list [--server <url>]
  tsheet backend remove <backend-id> [--server <url>]`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to run tsheet: ${message}`);
  process.exit(1);
});
