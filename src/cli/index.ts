#!/usr/bin/env node

import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import open from 'open';

import { createServer } from '../server/app';
import { resolveWorkspaceFilePath } from '../server/persistence/workspaceStore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: {
        type: 'string',
        default: '4312',
      },
      workspace: {
        type: 'string',
      },
      'no-open': {
        type: 'boolean',
        default: false,
      },
    },
    allowPositionals: false,
  });

  const port = Number.parseInt(values.port, 10);

  if (!Number.isFinite(port)) {
    throw new Error(`Invalid port: ${values.port}`);
  }

  const workspaceFilePath = resolveWorkspaceFilePath(values.workspace);
  const devWebUrl = process.env.TERMINAL_CANVAS_DEV_WEB_URL;
  const webRoot = devWebUrl ? undefined : await resolveWebRoot();
  const app = await createServer({
    port,
    workspaceFilePath,
    devWebUrl,
    webRoot,
  });

  const host = '127.0.0.1';
  await app.listen({ host, port });

  const launchUrl = devWebUrl ?? `http://${host}:${port}`;
  app.log.info(`Terminal Canvas listening at ${launchUrl}`);
  app.log.info(`Workspace file: ${workspaceFilePath}`);

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

async function resolveWebRoot(): Promise<string | undefined> {
  const candidate = resolve(__dirname, '..', 'web');

  try {
    await access(candidate, constants.F_OK);
    return candidate;
  } catch {
    return undefined;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start Terminal Canvas: ${message}`);
  process.exit(1);
});
