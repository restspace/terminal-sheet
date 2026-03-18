import { spawn } from 'node:child_process';

import type { FastifyBaseLogger } from 'fastify';

import type {
  BackendConnection,
  BackendSshTunnelConfig,
  BackendTunnelStatus,
} from '../../shared/backends';
import type { Workspace } from '../../shared/workspace';

const RECONNECT_DELAY_MS = 2_000;

export class SshTunnelManager {
  private readonly tunnels = new Map<string, SshTunnelRuntime>();

  constructor(private readonly logger: FastifyBaseLogger) {}

  async syncWithWorkspace(workspace: Workspace): Promise<void> {
    const activeIds = new Set<string>();

    for (const backend of workspace.backends) {
      if (!shouldManageTunnel(backend)) {
        continue;
      }

      activeIds.add(backend.id);
      this.ensureTunnel(backend);
    }

    for (const [backendId, runtime] of this.tunnels) {
      if (activeIds.has(backendId)) {
        continue;
      }

      runtime.close();
      this.tunnels.delete(backendId);
    }
  }

  ensureTunnel(connection: BackendConnection): void {
    if (!shouldManageTunnel(connection)) {
      this.removeTunnel(connection.id);
      return;
    }

    const existing = this.tunnels.get(connection.id);

    if (existing) {
      existing.updateConnection(connection);
      return;
    }

    const runtime = new SshTunnelRuntime(
      this.logger.child({ component: 'ssh-tunnel', backendId: connection.id }),
      connection,
    );
    this.tunnels.set(connection.id, runtime);
    runtime.start();
  }

  removeTunnel(backendId: string): void {
    const runtime = this.tunnels.get(backendId);

    if (!runtime) {
      return;
    }

    runtime.close();
    this.tunnels.delete(backendId);
  }

  getTunnelStatuses(): BackendTunnelStatus[] {
    return [...this.tunnels.values()].map((runtime) => runtime.getStatus());
  }

  async close(): Promise<void> {
    for (const runtime of this.tunnels.values()) {
      runtime.close();
    }

    this.tunnels.clear();
  }
}

class SshTunnelRuntime {
  private connection: BackendConnection;

  private status: BackendTunnelStatus;

  private process: ReturnType<typeof spawn> | null = null;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private shouldRun = true;

  constructor(
    private readonly logger: FastifyBaseLogger,
    connection: BackendConnection,
  ) {
    this.connection = connection;
    this.status = createTunnelStatus(connection, 'starting', null);
  }

  start(): void {
    void this.spawnTunnel();
  }

  updateConnection(connection: BackendConnection): void {
    const nextSsh = connection.ssh;
    const currentSsh = this.connection.ssh;
    const shouldRestart =
      !nextSsh ||
      !currentSsh ||
      nextSsh.target !== currentSsh.target ||
      nextSsh.port !== currentSsh.port ||
      nextSsh.identityFile !== currentSsh.identityFile ||
      nextSsh.localHost !== currentSsh.localHost ||
      nextSsh.localPort !== currentSsh.localPort ||
      nextSsh.remoteHost !== currentSsh.remoteHost ||
      nextSsh.remotePort !== currentSsh.remotePort;
    this.connection = connection;

    if (!nextSsh) {
      this.close();
      return;
    }

    if (shouldRestart) {
      this.status = createTunnelStatus(this.connection, 'starting', null);
      this.restartProcess();
      return;
    }

    this.status = {
      ...this.status,
      localUrl: getLocalUrl(nextSsh),
      updatedAt: new Date().toISOString(),
    };
  }

  getStatus(): BackendTunnelStatus {
    return this.status;
  }

  close(): void {
    this.shouldRun = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopProcess();
  }

  private restartProcess(): void {
    this.stopProcess();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.shouldRun) {
      void this.spawnTunnel();
    }
  }

  private async spawnTunnel(): Promise<void> {
    if (!this.shouldRun || this.process) {
      return;
    }

    const sshConfig = this.connection.ssh;

    if (!sshConfig) {
      return;
    }

    this.status = createTunnelStatus(this.connection, 'starting', null);
    const forwardSpec = `${sshConfig.localHost}:${sshConfig.localPort}:${sshConfig.remoteHost}:${sshConfig.remotePort}`;
    const args = [
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ConnectTimeout=15',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
    ];

    if (sshConfig.port) {
      args.push('-p', String(sshConfig.port));
    }

    if (sshConfig.identityFile?.trim()) {
      args.push('-i', sshConfig.identityFile.trim());
    }

    args.push(
      '-N',
      '-L',
      forwardSpec,
      sshConfig.target,
    );
    const child = spawn('ssh', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.process = child;

    let stderrBuffer = '';

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuffer = `${stderrBuffer}${text}`.slice(-2_048);
      const trimmed = text.trim();

      if (trimmed) {
        this.status = {
          ...this.status,
          lastError: trimmed.slice(-512),
          updatedAt: new Date().toISOString(),
        };
        this.logger.warn({ message: trimmed }, 'SSH tunnel stderr');
      }
    });

    child.on('spawn', () => {
      this.status = createTunnelStatus(this.connection, 'connected', null);
      this.logger.info(
        { localUrl: this.status.localUrl, sshTarget: sshConfig.target },
        'SSH tunnel connected',
      );
    });

    child.on('error', (error) => {
      this.process = null;
      this.status = createTunnelStatus(this.connection, 'error', error.message);
      this.logger.error(
        { error: error.message, localUrl: this.status.localUrl },
        'SSH tunnel failed to start',
      );
      this.scheduleReconnect();
    });

    child.on('exit', (code, signal) => {
      this.process = null;

      if (!this.shouldRun) {
        return;
      }

      const trimmedError = stderrBuffer.trim();
      const reason =
        trimmedError ||
        (signal
          ? `SSH tunnel exited with signal ${signal}.`
          : `SSH tunnel exited with code ${String(code)}.`);
      this.status = createTunnelStatus(this.connection, 'disconnected', reason);
      this.logger.warn(
        { code, signal, reason, localUrl: this.status.localUrl },
        'SSH tunnel disconnected',
      );
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (!this.shouldRun || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.spawnTunnel();
    }, RECONNECT_DELAY_MS);
  }

  private stopProcess(): void {
    const activeProcess = this.process;

    if (!activeProcess) {
      return;
    }

    this.process = null;

    try {
      activeProcess.kill();
    } catch {
      // Ignore termination races.
    }
  }
}

function shouldManageTunnel(connection: BackendConnection): boolean {
  return (
    connection.enabled &&
    connection.transport === 'ssh-tunnel' &&
    Boolean(connection.ssh)
  );
}

function createTunnelStatus(
  connection: BackendConnection,
  state: BackendTunnelStatus['state'],
  lastError: string | null,
): BackendTunnelStatus {
  const sshConfig = connection.ssh;
  return {
    backendId: connection.id,
    state,
    localUrl: sshConfig ? getLocalUrl(sshConfig) : connection.baseUrl,
    lastError,
    updatedAt: new Date().toISOString(),
  };
}

function getLocalUrl(config: BackendSshTunnelConfig): string {
  return `http://${config.localHost}:${config.localPort}`;
}
