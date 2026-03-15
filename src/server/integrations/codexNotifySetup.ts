import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';

export type CodexNotifySetupPhase =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'conflict'
  | 'error';

export interface CodexNotifySetupResult {
  phase: CodexNotifySetupPhase;
  message: string;
  configPath: string;
  projectRoot: string;
}

type CodexNotifyShell = 'bash' | 'powershell';

interface CodexNotifyAssignment {
  command: string[] | null;
}

const CODEX_CONFIG_DIRECTORY = '.codex';
const CODEX_CONFIG_FILE = 'config.toml';
const SESSION_HEADER = 'x-terminal-canvas-session-id';
const TOKEN_HEADER = 'x-terminal-canvas-token';
const SHELL_PLACEHOLDER_ARG = 'terminal-canvas-notify';

export async function prepareCodexNotifySetup(options: {
  projectRoot: string;
  platform?: NodeJS.Platform;
}): Promise<CodexNotifySetupResult> {
  const configPath = join(
    options.projectRoot,
    CODEX_CONFIG_DIRECTORY,
    CODEX_CONFIG_FILE,
  );
  const managedCommand = createManagedCodexNotifyCommand({
    shell: selectCodexNotifyShell(options.platform ?? process.platform),
  });

  try {
    const existing = await readCodexConfigIfPresent(configPath);

    if (existing === null) {
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        `${renderNotifyAssignment(managedCommand, '\n')}\n`,
        'utf8',
      );

      return {
        phase: 'created',
        message: `Codex notify command created in ${configPath}.`,
        configPath,
        projectRoot: options.projectRoot,
      };
    }

    const mergeResult = mergeManagedCodexNotify(existing, managedCommand);

    if (mergeResult.phase === 'conflict') {
      return {
        phase: 'conflict',
        message: `Codex notify setup skipped because ${configPath} already defines an incompatible notify command.`,
        configPath,
        projectRoot: options.projectRoot,
      };
    }

    if (mergeResult.phase === 'unchanged') {
      return {
        phase: 'unchanged',
        message: `Codex notify command already configured in ${configPath}.`,
        configPath,
        projectRoot: options.projectRoot,
      };
    }

    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, mergeResult.raw, 'utf8');

    return {
      phase: 'updated',
      message: `Codex notify command updated in ${configPath}.`,
      configPath,
      projectRoot: options.projectRoot,
    };
  } catch (error) {
    return {
      phase: 'error',
      message:
        error instanceof Error
          ? `Codex notify setup failed: ${error.message}`
          : 'Codex notify setup failed.',
      configPath,
      projectRoot: options.projectRoot,
    };
  }
}

export function renderCodexNotifyTomlSnippet(options: {
  shell: CodexNotifyShell;
}): string {
  return renderNotifyAssignment(
    createManagedCodexNotifyCommand(options),
    '\n',
  );
}

export function createManagedCodexNotifyCommand(options: {
  shell: CodexNotifyShell;
}): string[] {
  if (options.shell === 'powershell') {
    return [
      'powershell.exe',
      '-NoProfile',
      '-Command',
      `$body = $args[0]; Invoke-RestMethod -Method Post -Uri "$env:TERMINAL_CANVAS_ATTENTION_URL/codex" -Headers @{ '${TOKEN_HEADER}' = $env:TERMINAL_CANVAS_ATTENTION_TOKEN; '${SESSION_HEADER}' = $env:TERMINAL_CANVAS_SESSION_ID } -ContentType 'application/json' -Body $body | Out-Null`,
    ];
  }

  return [
    'sh',
    '-lc',
    `curl -fsS -X POST "$TERMINAL_CANVAS_ATTENTION_URL/codex" -H "Content-Type: application/json" -H "${TOKEN_HEADER}: $TERMINAL_CANVAS_ATTENTION_TOKEN" -H "${SESSION_HEADER}: $TERMINAL_CANVAS_SESSION_ID" --data-binary "$1" >/dev/null`,
    SHELL_PLACEHOLDER_ARG,
  ];
}

export function mergeManagedCodexNotify(
  raw: string,
  managedCommand: string[],
): {
  phase: 'updated' | 'unchanged' | 'conflict';
  raw: string;
} {
  const existingNotify = findTopLevelNotifyAssignment(raw);

  if (!existingNotify) {
    return {
      phase: 'updated',
      raw: insertTopLevelNotifyAssignment(raw, managedCommand),
    };
  }

  if (
    !existingNotify.command ||
    !areStringArraysEqual(existingNotify.command, managedCommand)
  ) {
    return {
      phase: 'conflict',
      raw,
    };
  }

  return {
    phase: 'unchanged',
    raw,
  };
}

async function readCodexConfigIfPresent(configPath: string): Promise<string | null> {
  try {
    await access(configPath, constants.F_OK);
  } catch {
    return null;
  }

  return readFile(configPath, 'utf8');
}

function insertTopLevelNotifyAssignment(raw: string, command: string[]): string {
  const newline = detectNewline(raw);
  const assignment = renderNotifyAssignment(command, newline);
  const firstTableOffset = findFirstTopLevelTableOffset(raw);

  if (firstTableOffset === -1) {
    const trimmed = raw.trimEnd();

    if (!trimmed.length) {
      return `${assignment}${newline}`;
    }

    return `${trimmed}${newline}${newline}${assignment}${newline}`;
  }

  const prefix = raw.slice(0, firstTableOffset).trimEnd();
  const suffix = raw.slice(firstTableOffset);
  const separator = prefix.length ? `${newline}${newline}` : '';

  return `${prefix}${separator}${assignment}${newline}${newline}${suffix}`;
}

function findTopLevelNotifyAssignment(raw: string): CodexNotifyAssignment | null {
  const lines = raw.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? '';
    const trimmed = line.trim();

    if (trimmed.startsWith('[')) {
      return null;
    }

    if (!/^notify\s*=/.test(trimmed)) {
      continue;
    }

    const equalsIndex = line.indexOf('=');

    if (equalsIndex === -1) {
      return null;
    }

    let expression = line.slice(equalsIndex + 1);

    for (let nextLineIndex = lineIndex + 1; nextLineIndex < lines.length; nextLineIndex += 1) {
      if (hasBalancedSquareBrackets(expression)) {
        break;
      }

      const nextLine = lines[nextLineIndex] ?? '';
      expression += `\n${nextLine}`;
    }

    const command = parseTomlStringArray(expression);

    return {
      command,
    };
  }

  return null;
}

function parseTomlStringArray(expression: string): string[] | null {
  const source = stripTomlComments(expression).trim();

  if (!source.startsWith('[') || !source.endsWith(']')) {
    return null;
  }

  const items: string[] = [];
  let index = 1;

  while (index < source.length - 1) {
    index = skipWhitespaceAndCommas(source, index);

    if (index >= source.length - 1) {
      break;
    }

    const character = source[index];

    if (character !== '"') {
      return null;
    }

    const parsed = parseTomlBasicString(source, index);

    if (!parsed) {
      return null;
    }

    items.push(parsed.value);
    index = skipWhitespaceAndCommas(source, parsed.nextIndex);
  }

  return items;
}

function parseTomlBasicString(
  source: string,
  startIndex: number,
): {
  value: string;
  nextIndex: number;
} | null {
  let index = startIndex + 1;
  let value = '';

  while (index < source.length) {
    const character = source[index];

    if (character === undefined) {
      return null;
    }

    if (character === '"') {
      return {
        value,
        nextIndex: index + 1,
      };
    }

    if (character === '\\') {
      const nextCharacter = source[index + 1];

      if (nextCharacter === undefined) {
        return null;
      }

      switch (nextCharacter) {
        case '"':
        case '\\':
          value += nextCharacter;
          index += 2;
          continue;
        case 'n':
          value += '\n';
          index += 2;
          continue;
        case 'r':
          value += '\r';
          index += 2;
          continue;
        case 't':
          value += '\t';
          index += 2;
          continue;
        default:
          return null;
      }
    }

    value += character;
    index += 1;
  }

  return null;
}

function stripTomlComments(source: string): string {
  let result = '';
  let inString = false;
  let escaping = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (character === undefined) {
      break;
    }

    if (!inString && character === '#') {
      while (index < source.length && source[index] !== '\n') {
        index += 1;
      }

      if (index < source.length && source[index] === '\n') {
        result += '\n';
      }

      continue;
    }

    result += character;

    if (!inString) {
      if (character === '"') {
        inString = true;
      }

      continue;
    }

    if (escaping) {
      escaping = false;
      continue;
    }

    if (character === '\\') {
      escaping = true;
      continue;
    }

    if (character === '"') {
      inString = false;
    }
  }

  return result;
}

function hasBalancedSquareBrackets(source: string): boolean {
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (character === undefined) {
      break;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }

      if (character === '\\') {
        escaping = true;
        continue;
      }

      if (character === '"') {
        inString = false;
      }

      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === '[') {
      depth += 1;
      continue;
    }

    if (character === ']') {
      depth -= 1;
    }
  }

  return depth === 0;
}

function skipWhitespaceAndCommas(source: string, startIndex: number): number {
  let index = startIndex;

  while (index < source.length) {
    const character = source[index];

    if (
      character !== undefined &&
      (character === ' ' ||
        character === '\t' ||
        character === '\r' ||
        character === '\n' ||
        character === ',')
    ) {
      index += 1;
      continue;
    }

    break;
  }

  return index;
}

function findFirstTopLevelTableOffset(raw: string): number {
  const lines = raw.split(/\r?\n/);
  const newlineLength = detectNewline(raw).length;
  let offset = 0;

  for (const line of lines) {
    if (line.trim().startsWith('[')) {
      return offset;
    }

    offset += line.length + newlineLength;
  }

  return -1;
}

function renderNotifyAssignment(command: string[], newline: string): string {
  const items = command.map((part) => `  ${JSON.stringify(part)},`).join(newline);

  return `notify = [${newline}${items}${newline}]`;
}

function selectCodexNotifyShell(platform: NodeJS.Platform): CodexNotifyShell {
  return platform === 'win32' ? 'powershell' : 'bash';
}

function detectNewline(source: string): string {
  return source.includes('\r\n') ? '\r\n' : '\n';
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}
