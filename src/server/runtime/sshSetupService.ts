import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import type { FastifyBaseLogger } from 'fastify';

import type { BackendSshSetupRequest } from '../../shared/backends';

interface SshSetupServiceOptions {
  contentRoot: string;
}

interface SshInstallResult {
  detectedOs: 'linux' | 'windows';
  capturedToken: string | null;
  availableNodeVersion: string | null;
}

interface SshCommandOptions {
  sshPort?: number;
  sshIdentityFile?: string;
}

const SSH_COMMAND_TIMEOUT_MS = 60_000;
const SSH_OUTPUT_LIMIT_BYTES = 256 * 1024;

export class SshSetupService {
  constructor(
    private readonly logger: FastifyBaseLogger,
    private readonly options: SshSetupServiceOptions,
  ) {}

  async resolveToken(request: BackendSshSetupRequest): Promise<string | null> {
    if (request.tokenMode === 'install-output') {
      return null;
    }

    if (request.tokenMode === 'manual') {
      return request.token?.trim() ?? null;
    }

    const tokenPath = request.tokenPath?.trim();

    if (!tokenPath) {
      return null;
    }

    const resolvedPath = isAbsolute(tokenPath)
      ? resolve(tokenPath)
      : resolve(this.options.contentRoot, tokenPath);
    const contents = await readFile(resolvedPath, 'utf8');
    const parsed = parseTokenFromText(contents);

    if (!parsed) {
      throw new Error(`No token found in ${resolvedPath}`);
    }

    return parsed;
  }

  async runInstall(
    sshTarget: string,
    sshOptions: SshCommandOptions,
    homeUrl: string,
    remotePort: number,
    runInstall: boolean,
  ): Promise<SshInstallResult> {
    const detectedOs = await this.detectRemoteOs(sshTarget, sshOptions);
    const availableNodeVersion = await this.detectAvailableNodeVersion(
      sshTarget,
      sshOptions,
      detectedOs,
    );

    if (!runInstall) {
      return {
        detectedOs,
        capturedToken: null,
        availableNodeVersion,
      };
    }

    const installCommand =
      detectedOs === 'windows'
        ? buildWindowsInstallCommand(homeUrl)
        : buildLinuxInstallCommand(homeUrl, remotePort);
    const result = await this.runSshCommand(sshTarget, installCommand, sshOptions);
    const capturedToken = parseTokenFromText(`${result.stdout}\n${result.stderr}`);

    if (result.code !== 0) {
      if (capturedToken) {
        this.logger.warn(
          { sshTarget, exitCode: result.code, availableNodeVersion },
          'SSH install exited non-zero after emitting TSHEET_TOKEN; continuing with captured token.',
        );

        return {
          detectedOs,
          capturedToken,
          availableNodeVersion,
        };
      }

      throw new Error(
        `${summarizeInstallFailure(result)}${formatAvailableNodeVersionHint(availableNodeVersion)}`,
      );
    }

    return {
      detectedOs,
      capturedToken,
      availableNodeVersion,
    };
  }

  private async detectRemoteOs(
    sshTarget: string,
    sshOptions: SshCommandOptions,
  ): Promise<'linux' | 'windows'> {
    const linuxProbe = await this.runSshCommand(sshTarget, 'uname -s', sshOptions);

    if (linuxProbe.code === 0) {
      return 'linux';
    }

    const windowsProbe = await this.runSshCommand(
      sshTarget,
      'powershell -NoProfile -Command "[System.Environment]::OSVersion.Platform"',
      sshOptions,
    );
    const windowsOutput = `${windowsProbe.stdout}\n${windowsProbe.stderr}`.toLowerCase();

    if (windowsProbe.code === 0 && windowsOutput.includes('win')) {
      return 'windows';
    }

    const linuxReason = summarizeProbeFailure(linuxProbe);
    const windowsReason = summarizeProbeFailure(windowsProbe);

    throw new Error(
      `Unable to detect remote OS over SSH for ${sshTarget}. ` +
        `Linux probe: ${linuxReason}. Windows probe: ${windowsReason}.`,
    );
  }

  private async detectAvailableNodeVersion(
    sshTarget: string,
    sshOptions: SshCommandOptions,
    detectedOs: 'linux' | 'windows',
  ): Promise<string | null> {
    const probeCommand =
      detectedOs === 'windows'
        ? 'powershell -NoProfile -Command "node --version"'
        : 'node --version 2>/dev/null || true';
    const result = await this.runSshCommand(sshTarget, probeCommand, sshOptions);
    return parseNodeVersionFromText(`${result.stdout}\n${result.stderr}`);
  }

  private async runSshCommand(
    sshTarget: string,
    remoteCommand: string,
    sshOptions: SshCommandOptions,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    if (!sshTarget.trim()) {
      throw new Error('SSH target is required.');
    }

    if (/\s/.test(sshTarget)) {
      throw new Error('SSH target must not include spaces. Use user@host style values.');
    }

    const sshArgs = [
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ConnectTimeout=15',
    ];

    if (sshOptions.sshPort) {
      sshArgs.push('-p', String(sshOptions.sshPort));
    }

    if (sshOptions.sshIdentityFile?.trim()) {
      sshArgs.push('-i', sshOptions.sshIdentityFile.trim());
    }

    sshArgs.push(sshTarget, remoteCommand);

    return new Promise((resolve, reject) => {
      const child = spawn(
        'ssh',
        sshArgs,
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, SSH_COMMAND_TIMEOUT_MS);

      child.stdout.on('data', (chunk: Buffer) => {
        const next = appendBoundedOutput(stdout, chunk, SSH_OUTPUT_LIMIT_BYTES);
        stdout = next.value;
        stdoutTruncated ||= next.truncated;
      });
      child.stderr.on('data', (chunk: Buffer) => {
        const next = appendBoundedOutput(stderr, chunk, SSH_OUTPUT_LIMIT_BYTES);
        stderr = next.value;
        stderrTruncated ||= next.truncated;
      });
      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `SSH command failed to start: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        if (timedOut) {
          stderr = appendInfoLine(
            stderr,
            `SSH command timed out after ${Math.floor(SSH_COMMAND_TIMEOUT_MS / 1000)}s.`,
            SSH_OUTPUT_LIMIT_BYTES,
          );
        }
        if (stdoutTruncated) {
          stdout = appendInfoLine(
            stdout,
            '[stdout truncated]',
            SSH_OUTPUT_LIMIT_BYTES,
          );
        }
        if (stderrTruncated) {
          stderr = appendInfoLine(
            stderr,
            '[stderr truncated]',
            SSH_OUTPUT_LIMIT_BYTES,
          );
        }
        resolve({ code, stdout, stderr });
      });
    });
  }
}

function appendBoundedOutput(
  current: string,
  chunk: Buffer,
  limitBytes: number,
): { value: string; truncated: boolean } {
  if (Buffer.byteLength(current, 'utf8') >= limitBytes) {
    return { value: current, truncated: true };
  }

  const remainingBytes = limitBytes - Buffer.byteLength(current, 'utf8');
  const chunkText = chunk.toString('utf8');
  const chunkBytes = Buffer.byteLength(chunkText, 'utf8');

  if (chunkBytes <= remainingBytes) {
    return { value: `${current}${chunkText}`, truncated: false };
  }

  const truncatedChunk = chunk.subarray(0, remainingBytes).toString('utf8');
  return {
    value: `${current}${truncatedChunk}`,
    truncated: true,
  };
}

function appendInfoLine(value: string, line: string, maxBytes: number): string {
  const suffix = value.endsWith('\n') ? `${line}\n` : `\n${line}\n`;
  const next = `${value}${suffix}`;

  if (Buffer.byteLength(next, 'utf8') <= maxBytes) {
    return next;
  }

  return value;
}

export function parseTokenFromText(input: string): string | null {
  const trimmed = input.trim();

  if (!trimmed) {
    return null;
  }

  const tokenMatch = trimmed.match(/(?:TSHEET_TOKEN|machineToken)\s*=\s*([^\s]+)/i);

  if (tokenMatch?.[1]) {
    return tokenMatch[1];
  }

  const jsonMatch = trimmed.match(/"machineToken"\s*:\s*"([^"]+)"/);

  if (jsonMatch?.[1]) {
    return jsonMatch[1];
  }

  const plainTokenLine = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => isPlainTokenCandidate(line));

  return plainTokenLine ?? null;
}

function buildLinuxInstallCommand(_homeUrl: string, remotePort: number): string {
  return [
    "bash -se <<'TSHEET_SSH_INSTALL'",
    'set -euo pipefail',
    '',
    `TSHEET_PORT=${remotePort}`,
    'TSHEET_PACKAGE=tsheet',
    'TSHEET_WORKSPACE="$HOME/.terminal-canvas/workspace.json"',
    'TSHEET_LOG="$HOME/.terminal-canvas/terminal-sheet.log"',
    'TSHEET_RUNNER="$HOME/.terminal-canvas/run-remote.sh"',
    'TSHEET_SERVICE_NAME=terminal-sheet.service',
    'TSHEET_SYSTEMD_USER_MODE="${TSHEET_SYSTEMD_USER_MODE:-auto}"',
    '',
    'mkdir -p "$HOME/.terminal-canvas"',
    '',
    'has_command() {',
    '  command -v "$1" >/dev/null 2>&1',
    '}',
    '',
    'run_privileged() {',
    '  if [ "$(id -u)" -eq 0 ]; then',
    '    "$@"',
    '    return $?',
    '  fi',
    '  if has_command sudo && sudo -n true >/dev/null 2>&1; then',
    '    sudo -n "$@"',
    '    return $?',
    '  fi',
    '  return 1',
    '}',
    '',
    'node_major() {',
    '  node --version 2>/dev/null | sed "s/^v//" | cut -d. -f1',
    '}',
    '',
    'install_node_via_nvm() {',
    '  local nvm_dir="$HOME/.nvm"',
    '  if [ ! -s "$nvm_dir/nvm.sh" ]; then',
    '    if has_command curl; then',
    '      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash',
    '    elif has_command wget; then',
    '      wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash',
    '    else',
    '      return 1',
    '    fi',
    '  fi',
    '',
    '  if [ ! -s "$nvm_dir/nvm.sh" ]; then',
    '    return 1',
    '  fi',
    '',
    '  # shellcheck disable=SC1090',
    '  . "$nvm_dir/nvm.sh"',
    '  nvm install --lts >/dev/null',
    '  nvm alias default "lts/*" >/dev/null 2>&1 || true',
    '  return 0',
    '}',
    '',
    'install_node_via_packages() {',
    '  if has_command apt-get; then',
    '    if has_command curl; then',
    '      run_privileged bash -lc "curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -" || return 1',
    '    elif has_command wget; then',
    '      run_privileged bash -lc "wget -qO- https://deb.nodesource.com/setup_lts.x | bash -" || return 1',
    '    else',
    '      return 1',
    '    fi',
    '    run_privileged apt-get install -y nodejs || return 1',
    '    return 0',
    '  fi',
    '',
    '  if has_command dnf; then',
    '    run_privileged dnf install -y nodejs npm || return 1',
    '    return 0',
    '  fi',
    '',
    '  if has_command yum; then',
    '    run_privileged yum install -y nodejs npm || return 1',
    '    return 0',
    '  fi',
    '',
    '  return 1',
    '}',
    '',
    'ensure_node() {',
    '  local current_major=0',
    '  if has_command node; then',
    '    current_major="$(node_major || echo 0)"',
    '    if [ "${current_major:-0}" -ge 20 ]; then',
    '      return 0',
    '    fi',
    '  fi',
    '',
    '  install_node_via_nvm || true',
    '',
    '  if has_command node; then',
    '    current_major="$(node_major || echo 0)"',
    '    if [ "${current_major:-0}" -ge 20 ]; then',
    '      return 0',
    '    fi',
    '  fi',
    '',
    '  install_node_via_packages || true',
    '',
    '  if ! has_command node; then',
    '    echo "ERROR: Node.js is required but could not be installed automatically."',
    '    exit 1',
    '  fi',
    '',
    '  current_major="$(node_major || echo 0)"',
    '  if [ "${current_major:-0}" -lt 20 ]; then',
    '    echo "ERROR: Node.js v20+ is required. Detected $(node --version)."',
    '    exit 1',
    '  fi',
    '',
    '  if ! has_command npm; then',
    '    echo "ERROR: npm is required but not available after Node.js installation."',
    '    exit 1',
    '  fi',
    '}',
    '',
    'install_tsheet_cli() {',
    '  if npm install -g "$TSHEET_PACKAGE"; then',
    '    return 0',
    '  fi',
    '  mkdir -p "$HOME/.local"',
    '  npm install -g --prefix "$HOME/.local" "$TSHEET_PACKAGE"',
    '  export PATH="$HOME/.local/bin:$PATH"',
    '}',
    '',
    'resolve_tsheet_cmd_path() {',
    '  if has_command tsheet; then',
    '    command -v tsheet',
    '    return 0',
    '  fi',
    '',
    '  local npm_prefix',
    '  npm_prefix="$(npm config get prefix 2>/dev/null || true)"',
    '  if [ -n "$npm_prefix" ] && [ "$npm_prefix" != "undefined" ]; then',
    '    if [ -x "$npm_prefix/bin/tsheet" ]; then',
    '      echo "$npm_prefix/bin/tsheet"',
    '      return 0',
    '    fi',
    '    if [ -x "$npm_prefix/tsheet" ]; then',
    '      echo "$npm_prefix/tsheet"',
    '      return 0',
    '    fi',
    '  fi',
    '',
    '  if [ -x "$HOME/.local/bin/tsheet" ]; then',
    '    echo "$HOME/.local/bin/tsheet"',
    '    return 0',
    '  fi',
    '',
    '  return 1',
    '}',
    '',
    'run_tsheet() {',
    '  if [ -n "${TSHEET_CMD_PATH:-}" ]; then',
    '    "$TSHEET_CMD_PATH" "$@"',
    '  else',
    '    npx --yes tsheet "$@"',
    '  fi',
    '}',
    '',
    'write_runner_script() {',
    "  cat > \"$TSHEET_RUNNER\" <<'EOF'",
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    'if [ -s "$HOME/.nvm/nvm.sh" ]; then',
    '  # shellcheck disable=SC1090',
    '  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true',
    'fi',
    '',
    `TSHEET_PORT=${remotePort}`,
    'TSHEET_WORKSPACE="$HOME/.terminal-canvas/workspace.json"',
    '',
    'if command -v tsheet >/dev/null 2>&1; then',
    '  exec "$(command -v tsheet)" serve --role remote --port "$TSHEET_PORT" --workspace "$TSHEET_WORKSPACE" --no-open',
    'fi',
    '',
    'if command -v npm >/dev/null 2>&1; then',
    '  NPM_PREFIX="$(npm config get prefix 2>/dev/null || true)"',
    '  if [ -n "$NPM_PREFIX" ] && [ "$NPM_PREFIX" != "undefined" ]; then',
    '    if [ -x "$NPM_PREFIX/bin/tsheet" ]; then',
    '      exec "$NPM_PREFIX/bin/tsheet" serve --role remote --port "$TSHEET_PORT" --workspace "$TSHEET_WORKSPACE" --no-open',
    '    fi',
    '    if [ -x "$NPM_PREFIX/tsheet" ]; then',
    '      exec "$NPM_PREFIX/tsheet" serve --role remote --port "$TSHEET_PORT" --workspace "$TSHEET_WORKSPACE" --no-open',
    '    fi',
    '  fi',
    'fi',
    '',
    'if [ -x "$HOME/.local/bin/tsheet" ]; then',
    '  exec "$HOME/.local/bin/tsheet" serve --role remote --port "$TSHEET_PORT" --workspace "$TSHEET_WORKSPACE" --no-open',
    'fi',
    '',
    'exec npx --yes tsheet serve --role remote --port "$TSHEET_PORT" --workspace "$TSHEET_WORKSPACE" --no-open',
    'EOF',
    '  chmod +x "$TSHEET_RUNNER"',
    '}',
    '',
    'prepare_systemd_user_env() {',
    '  if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then',
    '    export XDG_RUNTIME_DIR="/run/user/$(id -u)"',
    '  fi',
    '  if [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "$XDG_RUNTIME_DIR/bus" ]; then',
    '    export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"',
    '  fi',
    '}',
    '',
    'can_use_systemd_user() {',
    '  has_command systemctl || return 1',
    '  prepare_systemd_user_env',
    '  systemctl --user show-environment >/dev/null 2>&1',
    '}',
    '',
    'stop_existing_remote_backend() {',
    '  if has_command systemctl; then',
    '    systemctl --user stop "$TSHEET_SERVICE_NAME" >/dev/null 2>&1 || true',
    '  fi',
    '',
    '  if has_command pkill; then',
    '    pkill -f "tsheet serve --role remote" >/dev/null 2>&1 || true',
    '    pkill -f "terminal-canvas serve --role remote" >/dev/null 2>&1 || true',
    '    return 0',
    '  fi',
    '',
    "  ps -eo pid=,args= | awk '/((tsheet|terminal-canvas).*)serve --role remote/ {print $1}' | while read -r pid; do",
    '    if [ -n "$pid" ]; then',
    '      kill "$pid" >/dev/null 2>&1 || true',
    '    fi',
    '  done',
    '}',
    '',
    'start_with_systemd_user() {',
    '  mkdir -p "$HOME/.config/systemd/user"',
    '  cat > "$HOME/.config/systemd/user/$TSHEET_SERVICE_NAME" <<EOF',
    '[Unit]',
    'Description=Terminal Sheet Remote Backend',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    'ExecStart=$HOME/.terminal-canvas/run-remote.sh',
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    'EOF',
    '',
    '  if ! systemctl --user daemon-reload >/dev/null 2>&1; then',
    '    return 1',
    '  fi',
    '  if ! systemctl --user enable --now "$TSHEET_SERVICE_NAME" >/dev/null 2>&1; then',
    '    return 1',
    '  fi',
    '  if ! systemctl --user restart "$TSHEET_SERVICE_NAME" >/dev/null 2>&1; then',
    '    return 1',
    '  fi',
    '',
    '  if has_command loginctl; then',
    '    run_privileged loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true',
    '  fi',
    '',
    '  return 0',
    '}',
    '',
    'start_with_nohup() {',
    '  nohup "$TSHEET_RUNNER" > "$TSHEET_LOG" 2>&1 &',
    '  disown || true',
    '}',
    '',
    'wait_for_backend_health() {',
    '  if ! has_command curl; then',
    '    return 0',
    '  fi',
    '',
    '  local attempt=0',
    '  while [ "$attempt" -lt 20 ]; do',
    '    if curl -fsS -H "x-terminal-canvas-token: $TSHEET_TOKEN" "http://127.0.0.1:$TSHEET_PORT/api/backend/health" >/dev/null 2>&1; then',
    '      return 0',
    '    fi',
    '    attempt=$((attempt + 1))',
    '    sleep 1',
    '  done',
    '',
    '  return 1',
    '}',
    '',
    'ensure_node',
    'install_tsheet_cli',
    '',
    'TSHEET_CMD_PATH="$(resolve_tsheet_cmd_path || true)"',
    'if [ -z "$TSHEET_CMD_PATH" ] && ! has_command npx; then',
    '  echo "ERROR: tsheet CLI not found and npx is unavailable."',
    '  exit 1',
    'fi',
    '',
    'write_runner_script',
    '',
    'TSHEET_TOKEN="$(run_tsheet token show --workspace "$TSHEET_WORKSPACE" | grep "^machineToken=" | head -n1 | cut -d= -f2-)"',
    'if [ -z "$TSHEET_TOKEN" ]; then',
    '  echo "ERROR: unable to read machineToken from workspace."',
    '  exit 1',
    'fi',
    '',
    'stop_existing_remote_backend',
    '',
    'START_MODE="nohup"',
    'case "$TSHEET_SYSTEMD_USER_MODE" in',
    '  auto)',
    '    if can_use_systemd_user; then',
    '      if start_with_systemd_user; then',
    '        START_MODE="systemd-user"',
    '      else',
    '        echo "WARN: systemd --user start failed, falling back to nohup."',
    '      fi',
    '    fi',
    '    ;;',
    '  always|on|true|1)',
    '    if can_use_systemd_user; then',
    '      start_with_systemd_user',
    '      START_MODE="systemd-user"',
    '    else',
    '      echo "ERROR: TSHEET_SYSTEMD_USER_MODE requires systemd --user, but it is unavailable in this SSH session."',
    '      exit 1',
    '    fi',
    '    ;;',
    '  never|off|false|0)',
    '    ;;',
    '  *)',
    '    echo "ERROR: invalid TSHEET_SYSTEMD_USER_MODE value: $TSHEET_SYSTEMD_USER_MODE"',
    '    exit 1',
    '    ;;',
    'esac',
    '',
    'if [ "$START_MODE" = "nohup" ]; then',
    '  start_with_nohup',
    'fi',
    '',
    'if ! wait_for_backend_health; then',
    '  echo "ERROR: remote backend started but failed health check on port $TSHEET_PORT."',
    '  if [ "$START_MODE" = "systemd-user" ] && has_command systemctl; then',
    '    systemctl --user status "$TSHEET_SERVICE_NAME" --no-pager || true',
    '  else',
    '    tail -n 60 "$TSHEET_LOG" || true',
    '  fi',
    '  exit 1',
    'fi',
    '',
    'echo "TSHEET_START_MODE=$START_MODE"',
    'echo "TSHEET_TOKEN=$TSHEET_TOKEN"',
    'TSHEET_SSH_INSTALL',
  ].join('\n');
}

function buildWindowsInstallCommand(homeUrl: string): string {
  return `powershell -NoProfile -ExecutionPolicy Bypass -Command "(Invoke-WebRequest -UseBasicParsing '${homeUrl}/install.ps1').Content | Invoke-Expression"`;
}

function summarizeProbeFailure(result: {
  code: number | null;
  stdout: string;
  stderr: string;
}): string {
  const output = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (output) {
    return output;
  }

  if (typeof result.code === 'number') {
    return `exit code ${result.code}`;
  }

  return 'unknown failure';
}

function isPlainTokenCandidate(line: string): boolean {
  if (!line) {
    return false;
  }

  return /^[A-Za-z0-9._-]+$/.test(line);
}

function summarizeInstallFailure(result: {
  code: number | null;
  stdout: string;
  stderr: string;
}): string {
  const lines = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const usefulLines = lines.filter((line) =>
    !/^created symlink\b/i.test(line) &&
    !/^TSHEET_TOKEN\s*=/i.test(line) &&
    !/^TSHEET_START_MODE\s*=/i.test(line),
  );
  const preferredLine =
    usefulLines.find((line) => /^error[:\s]/i.test(line)) ??
    usefulLines.find((line) =>
      /failed|denied|not found|unable|timed out|refused|invalid|permission|cannot|no such/i.test(
        line,
      ),
    ) ??
    usefulLines[usefulLines.length - 1];

  if (preferredLine) {
    if (typeof result.code === 'number') {
      return `Remote install failed (exit code ${result.code}): ${preferredLine}`;
    }

    return `Remote install failed: ${preferredLine}`;
  }

  if (typeof result.code === 'number') {
    return `Remote install failed (exit code ${result.code}).`;
  }

  return 'Remote install failed.';
}

function parseNodeVersionFromText(input: string): string | null {
  const match = input.match(/(?:^|\s)(v?\d+\.\d+\.\d+)(?:\s|$)/m);

  if (!match?.[1]) {
    return null;
  }

  return match[1].startsWith('v') ? match[1] : `v${match[1]}`;
}

export function formatAvailableNodeVersionHint(availableNodeVersion: string | null): string {
  if (!availableNodeVersion) {
    return '';
  }

  const requirementHint = isSupportedNodeVersion(availableNodeVersion)
    ? ''
    : ' Terminal Sheet requires Node.js v20+ in the SSH session.';

  return ` Available Node.js in SSH session: ${availableNodeVersion}.${requirementHint}`;
}

function isSupportedNodeVersion(version: string): boolean {
  const match = version.match(/^v?(\d+)\./);

  if (!match?.[1]) {
    return false;
  }

  const major = Number.parseInt(match[1], 10);
  return Number.isFinite(major) && major >= 20;
}
