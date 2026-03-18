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
npm install -g terminal-canvas

echo "Starting Terminal Sheet as remote backend..."
TSHEET_TOKEN=$(tsheet token show --workspace ~/.terminal-canvas/workspace.json | grep machineToken | cut -d= -f2)

# Create and enable systemd service
if command -v systemctl &>/dev/null && [ -d /etc/systemd/system ]; then
  cat > /etc/systemd/system/terminal-sheet.service <<EOF
[Unit]
Description=Terminal Sheet Remote Backend
After=network.target

[Service]
Type=simple
User=$USER
ExecStart=$(which tsheet) serve --role remote --no-open
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
  # Fallback: run in background
  nohup tsheet serve --role remote --no-open &>/var/log/terminal-sheet.log &
  sleep 2
  echo "Terminal Sheet started in background."
fi

echo ""
echo "=== Installation complete ==="
echo "TSHEET_TOKEN=$TSHEET_TOKEN"
echo ""
echo "Add to your home server with:"
echo "  tsheet backend add --label 'Remote' --url http://$(hostname -I | awk '{print $1}'):$TSHEET_PORT --token $TSHEET_TOKEN"
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
npm install -g terminal-canvas

# Get or create server identity
$WorkspaceDir = "$env:USERPROFILE\\.terminal-canvas"
$null = New-Item -ItemType Directory -Force -Path $WorkspaceDir
tsheet token show --workspace "$WorkspaceDir\\workspace.json" 2>$null | Out-Null
$TokenLine = tsheet token show --workspace "$WorkspaceDir\\workspace.json" | Where-Object { $_ -match "^machineToken=" }
$TsheetToken = $TokenLine -replace "^machineToken=", ""

# Register as a Windows service using sc.exe
Write-Host "Registering Terminal Sheet as a Windows service..."
$TsheetPath = (Get-Command tsheet).Source
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
