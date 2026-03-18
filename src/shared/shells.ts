import { getDefaultShell, getRuntimePlatform, type RuntimePlatform } from './platform';

export interface ShellPreset {
  value: string;
  label: string;
}

const BASE_SHELL_PRESETS: readonly ShellPreset[] = [
  { value: 'powershell.exe', label: 'PowerShell' },
  { value: 'bash', label: 'Bash' },
];

export function getShellPresets(
  platform: RuntimePlatform = getRuntimePlatform(),
): ShellPreset[] {
  const defaultShell = getDefaultShell(platform);
  const defaultPreset = BASE_SHELL_PRESETS.find(
    (preset) => preset.value === defaultShell,
  );

  if (!defaultPreset) {
    return [...BASE_SHELL_PRESETS];
  }

  return [
    defaultPreset,
    ...BASE_SHELL_PRESETS.filter((preset) => preset.value !== defaultShell),
  ];
}

export function isPowerShellShell(shell: string): boolean {
  const normalized = normalizeShell(shell);
  const executable = normalizeShellExecutable(shell);

  return (
    isPowerShellIdentifier(executable) || isPowerShellIdentifier(normalized)
  );
}

export function isCmdShell(shell: string): boolean {
  const normalized = normalizeShell(shell);
  const executable = normalizeShellExecutable(shell);

  return isCmdIdentifier(executable) || isCmdIdentifier(normalized);
}

export function isBashShell(shell: string): boolean {
  const normalized = normalizeShell(shell);
  const executable = normalizeShellExecutable(shell);

  return isBashIdentifier(executable) || isBashIdentifier(normalized);
}

export function buildCwdSwitchCommand(shell: string, directoryPath: string): string {
  if (isPowerShellShell(shell)) {
    return `Set-Location -LiteralPath '${escapePowerShellLiteral(directoryPath)}'\r`;
  }

  if (isCmdShell(shell)) {
    return `cd /d "${escapeCmdQuoted(directoryPath)}"\r`;
  }

  return `cd -- '${escapePosixSingleQuoted(directoryPath)}'\n`;
}

function normalizeShellExecutable(shell: string): string {
  const firstToken = tokenizeCommandLine(shell.trim())[0] ?? shell.trim();

  return firstToken.toLowerCase();
}

function normalizeShell(shell: string): string {
  return shell.trim().toLowerCase();
}

function isPowerShellIdentifier(shell: string): boolean {
  return shell.includes('powershell') || shell.includes('pwsh');
}

function isCmdIdentifier(shell: string): boolean {
  return (
    shell === 'cmd' ||
    shell.endsWith('/cmd') ||
    shell.endsWith('\\cmd') ||
    shell.endsWith('cmd.exe')
  );
}

function isBashIdentifier(shell: string): boolean {
  return (
    shell === 'bash' ||
    shell.endsWith('/bash') ||
    shell.endsWith('\\bash') ||
    shell.endsWith('bash.exe')
  );
}

function tokenizeCommandLine(commandLine: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (const character of commandLine) {
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }

      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        parts.push(current);
        current = '';
      }

      continue;
    }

    current += character;
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

function escapePowerShellLiteral(input: string): string {
  return input.replaceAll("'", "''");
}

function escapeCmdQuoted(input: string): string {
  return input.replaceAll('"', '""');
}

function escapePosixSingleQuoted(input: string): string {
  return input.replaceAll("'", "'\"'\"'");
}
