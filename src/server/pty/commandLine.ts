import { getDefaultShell } from '../../shared/platform';

export function parseCommand(
  commandLine: string,
): {
  file: string;
  args: string[];
} {
  const parts = tokenizeCommandLine(commandLine.trim());

  if (!parts.length) {
    return {
      file: getDefaultShell(),
      args: [],
    };
  }

  return {
    file: normalizeExecutable(parts[0] ?? commandLine),
    args: parts.slice(1),
  };
}

function normalizeExecutable(file: string): string {
  if (process.platform !== 'win32') {
    return file;
  }

  const normalized = file.toLowerCase();

  if (normalized === 'powershell') {
    return 'powershell.exe';
  }

  if (normalized === 'pwsh') {
    return 'pwsh.exe';
  }

  if (normalized === 'cmd') {
    return 'cmd.exe';
  }

  if (/^[^\\/]+\.[a-z0-9]+$/i.test(file)) {
    return file;
  }

  if (!file.includes('\\') && !file.includes('/')) {
    return `${file}.exe`;
  }

  return file;
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
