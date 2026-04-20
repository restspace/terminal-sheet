import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import open from 'open';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..', '..');
const stateDir = resolve(rootDir, '.terminal-canvas');
const stateFilePath = resolve(stateDir, 'dev-launcher.json');
const webHost = '127.0.0.1';
const webPort = 4313;
const serverPort = 4312;
const webUrl = `http://${webHost}:${webPort}`;
const frontendSessionUrl = `${webUrl}/api/frontend-session`;
const healthUrl = `http://${webHost}:${serverPort}/api/health`;

interface ManagedChildSpec {
  name: 'web' | 'server';
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface ManagedChild {
  name: ManagedChildSpec['name'];
  process: ChildProcess;
}

interface LauncherState {
  rootDir: string;
  startedAt: string;
  processes: Array<{
    name: ManagedChildSpec['name'];
    pid: number;
  }>;
}

const noOpen = process.argv.includes('--no-open');
let shuttingDown = false;

async function main(): Promise<void> {
  await cleanupStaleProcesses();

  const children = [
    spawnManagedChild({
      name: 'web',
      command: process.execPath,
      args: [
        resolve(rootDir, 'node_modules', 'vite', 'bin', 'vite.js'),
        '--host',
        webHost,
        '--port',
        String(webPort),
        '--strictPort',
      ],
    }),
    spawnManagedChild({
      name: 'server',
      command: process.execPath,
      args: [
        resolve(rootDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        'watch',
        'src/cli/index.ts',
        'serve',
        '--role',
        'home',
        '--no-open'
      ],
      env: {
        NODE_ENV: 'development',
        TERMINAL_CANVAS_DEV_WEB_URL: webUrl,
      },
    }),
  ];

  await writeLauncherState(children);

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = async (exitCode: number): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shuttingDown = true;
    shutdownPromise = (async () => {
      await Promise.allSettled(children.map((child) => terminateManagedChild(child)));
      await removeLauncherState();
      process.exit(exitCode);
    })();

    return shutdownPromise;
  };

  process.on('SIGINT', () => {
    void shutdown(0);
  });
  process.on('SIGTERM', () => {
    void shutdown(0);
  });

  const childExitWatchers = children.map((child) =>
    waitForChildExit(child).then((exitCode) => ({ name: child.name, exitCode })),
  );

  try {
    await Promise.race([
      waitForStartup(),
      Promise.race(childExitWatchers).then((firstExit) => {
        throw new Error(
          `${firstExit.name} exited during startup with code ${firstExit.exitCode ?? 'null'}`,
        );
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Dev startup failed: ${message}`);
    await shutdown(1);
    return;
  }

  console.log(`Frontend ready at ${webUrl}`);
  console.log(`Backend ready at ${healthUrl}`);

  if (!noOpen) {
    await open(webUrl);
  }

  const firstExit = await Promise.race(childExitWatchers);
  if (!shuttingDown) {
    console.error(
      `${firstExit.name} exited unexpectedly with code ${firstExit.exitCode ?? 'null'}`,
    );
  }

  await shutdown(firstExit.exitCode ?? 1);
}

function spawnManagedChild(spec: ManagedChildSpec): ManagedChild {
  const child = spawn(spec.command, spec.args, {
    cwd: rootDir,
    env: {
      ...process.env,
      ...spec.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  if (!child.pid) {
    throw new Error(`Failed to start ${spec.name}`);
  }

  pipeWithPrefix(child.stdout, spec.name, process.stdout);
  pipeWithPrefix(child.stderr, spec.name, process.stderr);

  return {
    name: spec.name,
    process: child,
  };
}

function pipeWithPrefix(
  stream: NodeJS.ReadableStream | null,
  prefix: string,
  destination: NodeJS.WriteStream,
): void {
  if (!stream) {
    return;
  }

  stream.setEncoding('utf8');
  let buffer = '';

  stream.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      destination.write(`[${prefix}] ${line}\n`);
    }
  });

  stream.on('end', () => {
    if (buffer.length > 0) {
      destination.write(`[${prefix}] ${buffer}\n`);
    }
  });
}

async function waitForStartup(): Promise<void> {
  await waitForHttpOk(`${webUrl}/`, 'frontend root');
  await waitForHttpOk(healthUrl, 'backend health');
  await waitForHttpOk(frontendSessionUrl, 'frontend API proxy');
}

async function waitForHttpOk(url: string, label: string): Promise<void> {
  const startedAt = Date.now();
  const timeoutMs = 60_000;
  let lastError = 'not attempted';

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.ok) {
        return;
      }

      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await delay(500);
  }

  throw new Error(`${label} did not become ready: ${lastError}`);
}

async function delay(durationMs: number): Promise<void> {
  await new Promise((resolveDelay) => {
    setTimeout(resolveDelay, durationMs);
  });
}

async function waitForChildExit(child: ManagedChild): Promise<number | null> {
  return await new Promise((resolveExit) => {
    child.process.once('exit', (code) => {
      resolveExit(code);
    });
  });
}

async function writeLauncherState(children: ManagedChild[]): Promise<void> {
  await mkdir(stateDir, { recursive: true });

  const state: LauncherState = {
    rootDir,
    startedAt: new Date().toISOString(),
    processes: children
      .map((child) =>
        child.process.pid
          ? {
              name: child.name,
              pid: child.process.pid,
            }
          : null,
      )
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
  };

  await writeFile(stateFilePath, JSON.stringify(state, null, 2));
}

async function removeLauncherState(): Promise<void> {
  await rm(stateFilePath, { force: true });
}

async function cleanupStaleProcesses(): Promise<void> {
  let state: LauncherState | null = null;

  try {
    const raw = await readFile(stateFilePath, 'utf8');
    state = JSON.parse(raw) as LauncherState;
  } catch {
    return;
  }

  if (state.rootDir !== rootDir) {
    await removeLauncherState();
    return;
  }

  for (const entry of state.processes) {
    if (await isManagedPid(entry.pid)) {
      await killProcessTree(entry.pid);
    }
  }

  await removeLauncherState();
}

async function terminateManagedChild(child: ManagedChild): Promise<void> {
  const pid = child.process.pid;
  if (!pid) {
    return;
  }

  await killProcessTree(pid);
}

async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/pid', String(pid), '/t', '/f']);
    } catch {
      // Ignore cases where the process has already exited.
    }
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return;
  }

  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (!(await isPidRunning(pid))) {
      return;
    }

    await delay(100);
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Ignore cases where the process exits during shutdown.
  }
}

async function isManagedPid(pid: number): Promise<boolean> {
  const commandLine = await getCommandLine(pid);
  return commandLine.includes(rootDir);
}

async function getCommandLine(pid: number): Promise<string> {
  if (!(await isPidRunning(pid))) {
    return '';
  }

  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty CommandLine`,
      ]);
      return stdout.trim();
    } catch {
      return '';
    }
  }

  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command=']);
    return stdout.trim();
  } catch {
    return '';
  }
}

async function isPidRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') {
      return true;
    }

    return false;
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to launch dev environment: ${message}`);
  process.exit(1);
});
