import type { FastifyInstance } from 'fastify';

export async function registerInstallRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get('/install.sh', async (request, reply) => {
    const homeUrl = getHomeUrl(request);
    const script = buildBashInstallScript(homeUrl);
    return reply.type('text/x-sh').send(script);
  });

  app.get('/install.ps1', async (request, reply) => {
    const homeUrl = getHomeUrl(request);
    const script = buildPowerShellInstallScript(homeUrl);
    return reply.type('text/plain').send(script);
  });
}

function getHomeUrl(request: { headers: Record<string, unknown>; hostname: string; protocol?: string }): string {
  const host = request.headers['x-forwarded-host'] ?? request.headers.host ?? request.hostname;
  const proto = request.headers['x-forwarded-proto'] ?? 'http';
  return `${String(proto)}://${String(host)}`;
}

function buildBashInstallScript(homeUrl: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

HOME_URL="${homeUrl}"
TSHEET_PORT=4312
TSHEET_PACKAGE=tsheet

echo "=== Terminal Sheet Remote Install ==="
echo "Home server: $HOME_URL"

# Detect or install Node.js >= 20
ensure_node() {
  if command -v node &>/dev/null; then
    NODE_MAJOR=$(node --version | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_MAJOR" -ge 20 ]; then
      echo "Node.js $(node --version) found."
      return 0
    fi
    echo "Node.js $(node --version) is too old. Need v20+."
  fi

  echo "Installing Node.js via NodeSource..."
  if command -v curl &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
  elif command -v wget &>/dev/null; then
    wget -qO- https://deb.nodesource.com/setup_lts.x | bash -
  else
    echo "ERROR: curl or wget required to install Node.js"
    exit 1
  fi

  if command -v apt-get &>/dev/null; then
    apt-get install -y nodejs
  elif command -v yum &>/dev/null; then
    yum install -y nodejs
  else
    echo "ERROR: Cannot install Node.js automatically. Please install Node.js v20+ manually."
    exit 1
  fi
}

ensure_node

echo "Installing Terminal Sheet globally..."
if npm install -g "$TSHEET_PACKAGE"; then
  echo "Global npm install succeeded."
else
  echo "Global npm install failed. Retrying with user prefix at $HOME/.local..."
  mkdir -p "$HOME/.local"
  npm install -g --prefix "$HOME/.local" "$TSHEET_PACKAGE"
  export PATH="$HOME/.local/bin:$PATH"
fi

TSHEET_CMD_PATH=""
if command -v tsheet &>/dev/null; then
  TSHEET_CMD_PATH="$(command -v tsheet)"
else
  NPM_GLOBAL_PREFIX="$(npm config get prefix 2>/dev/null || true)"
  if [ -n "$NPM_GLOBAL_PREFIX" ] && [ "$NPM_GLOBAL_PREFIX" != "undefined" ]; then
    if [ -x "$NPM_GLOBAL_PREFIX/bin/tsheet" ]; then
      TSHEET_CMD_PATH="$NPM_GLOBAL_PREFIX/bin/tsheet"
    elif [ -x "$NPM_GLOBAL_PREFIX/tsheet" ]; then
      TSHEET_CMD_PATH="$NPM_GLOBAL_PREFIX/tsheet"
    fi
  fi
  if [ -z "$TSHEET_CMD_PATH" ] && [ -x "$HOME/.local/bin/tsheet" ]; then
    TSHEET_CMD_PATH="$HOME/.local/bin/tsheet"
  fi
fi

if [ -z "$TSHEET_CMD_PATH" ] && ! command -v npx &>/dev/null; then
  echo "ERROR: tsheet CLI not found and npx is unavailable."
  exit 1
fi

run_tsheet() {
  if [ -n "$TSHEET_CMD_PATH" ]; then
    "$TSHEET_CMD_PATH" "$@"
  else
    npx --yes tsheet "$@"
  fi
}

resolve_tsheet_invoke() {
  if [ -n "$TSHEET_CMD_PATH" ]; then
    echo "$TSHEET_CMD_PATH"
  else
    echo "npx --yes tsheet"
  fi
}

TSHEET_INVOKE="$(resolve_tsheet_invoke)"

echo "Starting Terminal Sheet as remote backend..."
TSHEET_TOKEN="$(run_tsheet token show --workspace ~/.terminal-canvas/workspace.json | grep '^machineToken=' | cut -d= -f2)"

if [ -z "$TSHEET_TOKEN" ]; then
  echo "ERROR: unable to read machineToken from workspace."
  exit 1
fi

# Create and enable systemd service (root only)
if command -v systemctl &>/dev/null && [ -d /etc/systemd/system ] && [ "$(id -u)" -eq 0 ]; then
  SERVICE_USER="$SUDO_USER"
  if [ -z "$SERVICE_USER" ]; then
    SERVICE_USER="$(id -un)"
  fi
  cat > /etc/systemd/system/terminal-sheet.service <<EOF
[Unit]
Description=Terminal Sheet Remote Backend
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
ExecStart=$TSHEET_INVOKE serve --role remote --no-open
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable terminal-sheet
  systemctl restart terminal-sheet
  echo "Terminal Sheet service started."
else
  # Fallback: run in background for non-root users
  mkdir -p "$HOME/.terminal-canvas"
  if [ -n "$TSHEET_CMD_PATH" ]; then
    nohup "$TSHEET_CMD_PATH" serve --role remote --no-open > "$HOME/.terminal-canvas/terminal-sheet.log" 2>&1 &
  else
    nohup npx --yes tsheet serve --role remote --no-open > "$HOME/.terminal-canvas/terminal-sheet.log" 2>&1 &
  fi
  sleep 2
  echo "Terminal Sheet started in background (user mode)."
fi

BACKEND_HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [ -z "$BACKEND_HOST" ]; then
  BACKEND_HOST="127.0.0.1"
fi

echo ""
echo "=== Installation complete ==="
echo "TSHEET_TOKEN=$TSHEET_TOKEN"
echo ""
echo "Add to your home server with:"
echo "  tsheet backend add --label 'Remote' --url http://$BACKEND_HOST:$TSHEET_PORT --token $TSHEET_TOKEN"
`;
}

function buildPowerShellInstallScript(homeUrl: string): string {
  return `#Requires -RunAsAdministrator
$ErrorActionPreference = "Stop"
$HomeUrl = "${homeUrl}"
$TsheetPort = 4312

Write-Host "=== Terminal Sheet Remote Install ===" -ForegroundColor Cyan
Write-Host "Home server: $HomeUrl"

# Install Node.js via winget
Write-Host "Installing Node.js LTS..."
winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent

# Refresh PATH
$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")

# Install Terminal Sheet
Write-Host "Installing Terminal Sheet globally..."
npm install -g tsheet

# Resolve CLI command path
$TsheetCommand = Get-Command tsheet -ErrorAction SilentlyContinue
if (-not $TsheetCommand) {
  $TsheetCommand = Get-Command terminal-canvas -ErrorAction SilentlyContinue
}

if (-not $TsheetCommand) {
  throw "tsheet command was not found after npm install -g tsheet."
}

$TsheetPath = $TsheetCommand.Source

# Get or create server identity
$WorkspaceDir = "$env:USERPROFILE\\.terminal-canvas"
$null = New-Item -ItemType Directory -Force -Path $WorkspaceDir
$TokenLine = (& $TsheetPath token show --workspace "$WorkspaceDir\\workspace.json") | Where-Object { $_ -match "^machineToken=" }
$TokenLine = $TokenLine | Select-Object -First 1
if (-not $TokenLine) {
  throw "machineToken was not found in workspace output."
}
$TsheetToken = $TokenLine -replace "^machineToken=", ""

# Register as a Windows service using sc.exe
Write-Host "Registering Terminal Sheet as a Windows service..."
$ServiceName = "TerminalSheet"

$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingService) {
  Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  sc.exe delete $ServiceName | Out-Null
}

sc.exe create $ServiceName binPath= "\`"$TsheetPath\`" serve --role remote --no-open" start= auto
sc.exe start $ServiceName

Write-Host ""
Write-Host "=== Installation complete ===" -ForegroundColor Green
Write-Host "TSHEET_TOKEN=$TsheetToken"
Write-Host ""
Write-Host "Add to your home server with:"
Write-Host "  tsheet backend add --label 'Remote' --url http://localhost:$TsheetPort --token $TsheetToken"
`;
}
