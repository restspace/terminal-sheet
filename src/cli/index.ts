#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import open from 'open';

import type { ServerRole } from '../shared/backends';
import { LOCAL_BACKEND_ID } from '../shared/backends';
import { createServer } from '../server/app';
import { runSpawnCommand } from './spawn';
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
  const rawArgs = process.argv.slice(2);
  const commandIndex = rawArgs.findIndex((arg) => !arg.startsWith('-'));
  const command = commandIndex >= 0 ? rawArgs[commandIndex] : undefined;
  const rest = commandIndex >= 0 ? rawArgs.slice(commandIndex + 1) : rawArgs;

  if (!command) {
    await runServeCommand(rawArgs);
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
    case 'spawn':
      await runSpawnCommand(rest);
      return;
    case 'remote':
      await runRemoteCommand(rest);
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
    serverIdentityFilePath: identityFilePath,
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

async function runRemoteCommand(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;

  switch (subcommand) {
    case 'install':
      await runRemoteInstallCommand(rest);
      return;
    default:
      throw new Error(
        'Usage: tsheet remote install --ssh user@host [--label "Name"] [--port 4312] [--server <url>]',
      );
  }
}

async function runRemoteInstallCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      ssh: {
        type: 'string',
      },
      label: {
        type: 'string',
      },
      port: {
        type: 'string',
        default: String(DEFAULT_PORT),
      },
      server: {
        type: 'string',
        default: DEFAULT_SERVER_URL,
      },
    },
  });

  if (!values.ssh) {
    throw new Error(
      'Usage: tsheet remote install --ssh user@host [--label "Name"] [--port 4312] [--server <url>]',
    );
  }

  const label = values.label ?? values.ssh;
  const remotePort = Number.parseInt(values.port, 10);

  if (!Number.isFinite(remotePort)) {
    throw new Error(`Invalid port: ${values.port}`);
  }

  const homeUrl = normalizeBaseUrl(values.server);
  const installUrl = `${homeUrl}/install.sh`;

  console.log(`Installing Terminal Sheet on ${values.ssh} via SSH...`);
  console.log(`Home server: ${homeUrl}`);

  const token = await runSshInstall(values.ssh, installUrl);

  if (!token) {
    throw new Error(
      'Install completed but no TSHEET_TOKEN found in output. ' +
        'Run `tsheet token show` on the remote machine to get the token, ' +
        'then use `tsheet backend add` to register it.',
    );
  }

  const sshHost = values.ssh.includes('@') ? values.ssh.split('@').slice(1).join('@') : values.ssh;
  const remoteUrl = `http://${sshHost}:${remotePort}`;

  console.log(`Registering backend: ${label} at ${remoteUrl}`);

  const response = await fetchJson(resolveUrl(values.server, '/api/backends'), {
    method: 'POST',
    body: { label, baseUrl: remoteUrl, token },
  });

  const backendId =
    typeof response.backend === 'object' &&
    response.backend &&
    'id' in response.backend &&
    typeof response.backend.id === 'string'
      ? response.backend.id
      : label;
  const importedTerminalCount =
    typeof response.importedTerminalCount === 'number'
      ? response.importedTerminalCount
      : 0;

  console.log(
    `Remote install complete. Backend ${backendId} added with ${importedTerminalCount} imported terminals.`,
  );
}

async function runSshInstall(sshTarget: string, installUrl: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const sshProcess = spawn(
      'ssh',
      [sshTarget, `curl -fsSL '${installUrl}' | bash`],
      { stdio: ['inherit', 'pipe', 'inherit'] },
    );

    let capturedToken: string | null = null;
    let outputBuffer = '';

    sshProcess.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      outputBuffer += text;
      process.stdout.write(text);

      const match = outputBuffer.match(/TSHEET_TOKEN=([a-f0-9]+)/);

      if (match) {
        capturedToken = match[1] ?? null;
      }
    });

    sshProcess.on('close', (code: number | null) => {
      if (code === 0) {
        resolve(capturedToken);
      } else {
        reject(new Error(`SSH install exited with code ${String(code)}`));
      }
    });

    sshProcess.on('error', (err: Error) => {
      reject(new Error(`SSH failed: ${err.message}`));
    });
  });
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

function printHelp(): void {
  console.log(`tsheet commands:
  tsheet serve [--port <n>] [--workspace <path>] [--role <standalone|home|remote>] [--no-open]
  tsheet open <path> [--server <url>]
  tsheet spawn --command "..." [--label "..."] [--cwd "."] [--agent-type shell] [--wait] [--timeout 300]
  tsheet token <show|rotate> [--workspace <path>]
  tsheet backend add --label <name> --url <remote-url> --token <token> [--server <url>]
  tsheet backend list [--server <url>]
  tsheet backend remove <backend-id> [--server <url>]
  tsheet remote install --ssh user@host [--label "Name"] [--port 4312] [--server <url>]`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to run tsheet: ${message}`);
  process.exit(1);
});
