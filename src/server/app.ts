import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerHealthRoutes } from './routes/health';
import { registerWorkspaceRoutes } from './routes/workspace';
import { WorkspaceService } from './persistence/workspaceService';
import { PtySessionManager } from './pty/ptySessionManager';
import { registerWorkspaceSocket } from './ws/registerWorkspaceSocket';

export interface TerminalCanvasServerOptions {
  port: number;
  workspaceFilePath: string;
  devWebUrl?: string;
  webRoot?: string;
}

export async function createServer(
  options: TerminalCanvasServerOptions,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  const workspaceService = await WorkspaceService.create(options.workspaceFilePath);
  const ptySessionManager = new PtySessionManager(app.log.child({ component: 'pty' }));

  await app.register(websocket);
  await ptySessionManager.syncWithWorkspace(workspaceService.getWorkspace());
  workspaceService.subscribe((workspace) => ptySessionManager.syncWithWorkspace(workspace));

  await registerHealthRoutes(app, {
    port: options.port,
    workspaceFilePath: options.workspaceFilePath,
    devWebUrl: options.devWebUrl,
    ptySessionManager,
  });
  await registerWorkspaceRoutes(app, {
    workspaceService,
  });
  await registerWorkspaceSocket(app, {
    ptySessionManager,
  });

  app.addHook('onClose', async () => {
    ptySessionManager.close();
  });

  if (options.webRoot) {
    const webRoot = resolve(options.webRoot);
    const indexHtml = await readFile(resolve(webRoot, 'index.html'), 'utf8');

    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      index: ['index.html'],
    });

    app.setNotFoundHandler(async (request, reply) => {
      const requestPath = request.url;

      if (requestPath.startsWith('/api') || requestPath.startsWith('/ws')) {
        return reply.code(404).send({ message: 'Not found' });
      }

      if (extname(requestPath)) {
        return reply.code(404).send({ message: 'Asset not found' });
      }

      return reply.type('text/html').send(indexHtml);
    });
  } else if (options.devWebUrl) {
    const devWebUrl = options.devWebUrl;

    app.get('/', async (_request, reply) => {
      return reply.redirect(devWebUrl);
    });
  }

  return app;
}
