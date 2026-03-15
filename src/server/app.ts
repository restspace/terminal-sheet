import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';

import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';

import { LOCAL_BACKEND_ID, type ServerRole } from '../shared/backends';
import { registerHealthRoutes } from './routes/health';
import { registerSessionRoutes } from './routes/sessions';
import { registerAttentionRoutes } from './routes/attention';
import { registerBackendRoutes } from './routes/backends';
import { registerBackendMachineRoutes } from './routes/backendMachine';
import { registerMarkdownRoutes } from './routes/markdown';
import { registerWorkspaceRoutes } from './routes/workspace';
import { AttentionService } from './integrations/attentionService';
import { MarkdownService } from './markdown/markdownService';
import { WorkspaceService } from './persistence/workspaceService';
import { PtySessionManager } from './pty/ptySessionManager';
import { BackendRuntimeManager } from './runtime/backendRuntimeManager';
import { registerBackendSocket } from './ws/registerBackendSocket';
import { registerWorkspaceSocket } from './ws/registerWorkspaceSocket';

export interface TerminalCanvasServerOptions {
  port: number;
  role?: ServerRole;
  serverId?: string;
  localBackendId?: string;
  machineToken?: string;
  workspaceFilePath: string;
  contentRoot?: string;
  devWebUrl?: string;
  webRoot?: string;
}

export async function createServer(
  options: TerminalCanvasServerOptions,
): Promise<FastifyInstance> {
  const role = options.role ?? 'standalone';
  const serverId = options.serverId ?? 'server-local';
  const localBackendId = options.localBackendId ?? LOCAL_BACKEND_ID;
  const machineToken = options.machineToken ?? 'dev-machine-token';
  const contentRoot = options.contentRoot ?? process.cwd();
  const app = Fastify({ logger: true });
  const workspaceService = await WorkspaceService.create(options.workspaceFilePath);
  const markdownService = new MarkdownService(
    contentRoot,
    dirname(options.workspaceFilePath),
  );
  const attentionService = new AttentionService({
    backendId: localBackendId,
    receiverUrl: `http://127.0.0.1:${options.port}/api/attention`,
    token: process.env.TERMINAL_CANVAS_ATTENTION_TOKEN,
  });
  const ptySessionManager = new PtySessionManager(
    app.log.child({ component: 'pty' }),
    {
      attentionService,
      attentionReceiverUrl: attentionService.getSetup().receiverUrl,
      attentionToken: attentionService.getSetup().token,
      markdownService,
      backendId: localBackendId,
      workspaceRoot: contentRoot,
    },
  );
  const runtimeManager = new BackendRuntimeManager(
    app.log.child({ component: 'runtime' }),
    {
      role,
      localBackendId,
      localPtySessionManager: ptySessionManager,
      localAttentionService: attentionService,
      workspaceService,
    },
  );

  await app.register(websocket);
  await markdownService.syncWithWorkspace(workspaceService.getWorkspace());
  await runtimeManager.syncWithWorkspace(workspaceService.getWorkspace());
  workspaceService.subscribe((workspace) => {
    void markdownService.syncWithWorkspace(workspace).catch((error) => {
      app.log.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to sync markdown documents with workspace update',
      );
    });
    void runtimeManager.syncWithWorkspace(workspace).catch((error) => {
      app.log.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to sync PTY sessions with workspace update',
      );
    });
  });

  await registerHealthRoutes(app, {
    port: options.port,
    role,
    serverId,
    localBackendId,
    workspaceFilePath: options.workspaceFilePath,
    devWebUrl: options.devWebUrl,
    runtimeManager,
    attentionService,
  });
  await registerAttentionRoutes(app, {
    attentionService,
    ptySessionManager,
  });
  await registerSessionRoutes(app, {
    runtimeManager,
  });
  await registerBackendRoutes(app, {
    role,
    workspaceService,
    runtimeManager,
  });
  await registerBackendMachineRoutes(app, {
    role,
    serverId,
    machineToken,
    localBackendId,
    workspaceService,
    ptySessionManager,
    attentionService,
  });
  await registerMarkdownRoutes(app, {
    markdownService,
    workspaceService,
  });
  await registerWorkspaceRoutes(app, {
    workspaceService,
  });
  await registerWorkspaceSocket(app, {
    runtimeManager,
    markdownService,
    workspaceService,
  });
  await registerBackendSocket(app, {
    machineToken,
    ptySessionManager,
    attentionService,
  });

  app.addHook('onClose', async () => {
    markdownService.close();
    await runtimeManager.close();
    ptySessionManager.close();
  });

  if (options.webRoot) {
    const webRoot = resolve(options.webRoot);
    const indexHtml = await readFile(resolve(webRoot, 'index.html'), 'utf8');
    const devWebUrl = options.devWebUrl;

    app.get('/', async (_request, reply) => {
      if (devWebUrl && (await shouldRedirectToDevWeb(devWebUrl))) {
        return reply.redirect(devWebUrl);
      }

      return reply.type('text/html').send(indexHtml);
    });

    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      index: false,
    });

    app.setNotFoundHandler(async (request, reply) => {
      const requestPath = request.url;

      if (requestPath.startsWith('/api') || requestPath.startsWith('/ws')) {
        return reply.code(404).send({ message: 'Not found' });
      }

      if (extname(requestPath)) {
        return reply.code(404).send({ message: 'Asset not found' });
      }

      if (devWebUrl && (await shouldRedirectToDevWeb(devWebUrl))) {
        return reply.redirect(resolveDevWebUrl(devWebUrl, requestPath));
      }

      return reply.type('text/html').send(indexHtml);
    });
  } else if (options.devWebUrl) {
    const devWebUrl = options.devWebUrl;

    app.get('/', async (_request, reply) => {
      if (devWebUrl && (await shouldRedirectToDevWeb(devWebUrl))) {
        return reply.redirect(devWebUrl);
      }

      return reply
        .code(503)
        .type('text/plain')
        .send(`Frontend dev server unavailable at ${devWebUrl}`);
    });
  }

  return app;
}

async function shouldRedirectToDevWeb(
  devWebUrl: string | undefined,
): Promise<boolean> {
  if (!devWebUrl) {
    return false;
  }

  return isDevWebAvailable(devWebUrl);
}

async function isDevWebAvailable(devWebUrl: string): Promise<boolean> {
  try {
    const response = await fetch(devWebUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(750),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function resolveDevWebUrl(devWebUrl: string, requestPath: string): string {
  const baseUrl = devWebUrl.endsWith('/')
    ? devWebUrl.slice(0, -1)
    : devWebUrl;
  const path = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;

  return `${baseUrl}${path}`;
}
