const POWERSHELL_MARKER_PREFIX = '\u001b]633;TerminalCanvasCwd=';
const PROMPT_MARKER_PREFIX = '\u001b]633;TerminalCanvasPrompt=';
const OSC_TERMINATORS = ['\u0007', '\u001b\\'] as const;

export interface CwdTrackingParseResult {
  output: string;
  liveCwd: string | null;
  promptReturned: boolean;
  pending: string;
}

export function supportsPowerShellCwdTracking(commandFile: string): boolean {
  const normalized = commandFile.toLowerCase();
  return normalized.endsWith('powershell.exe') || normalized.endsWith('pwsh.exe');
}

export function supportsBashPromptTracking(commandFile: string): boolean {
  const normalized = commandFile.toLowerCase();
  return (
    normalized === 'bash' ||
    normalized.endsWith('/bash') ||
    normalized.endsWith('\\bash') ||
    normalized.endsWith('bash.exe')
  );
}

export function augmentPowerShellArgsForCwdTracking(args: string[]): string[] {
  if (containsPowerShellLaunchDirective(args)) {
    return args;
  }

  return [...args, '-NoExit', '-Command', buildPowerShellPromptBootstrap()];
}

export function augmentShellEnvironmentForTracking(
  commandFile: string,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!supportsBashPromptTracking(commandFile)) {
    return env;
  }

  return {
    ...env,
    PROMPT_COMMAND: buildBashPromptCommand(env.PROMPT_COMMAND),
  };
}

export function parseCwdTrackingOutput(
  chunk: string,
  pending: string,
): CwdTrackingParseResult {
  const input = `${pending}${chunk}`;
  let cursor = 0;
  let output = '';
  let liveCwd: string | null = null;
  let promptReturned = false;

  while (cursor < input.length) {
    const cwdMarkerIndex = input.indexOf(POWERSHELL_MARKER_PREFIX, cursor);
    const promptMarkerIndex = input.indexOf(PROMPT_MARKER_PREFIX, cursor);
    const markerIndex = getNextMarkerIndex(cwdMarkerIndex, promptMarkerIndex);

    if (markerIndex === -1) {
      output += input.slice(cursor);
      return {
        output,
        liveCwd,
        promptReturned,
        pending: '',
      };
    }

    output += input.slice(cursor, markerIndex);
    const markerPrefix =
      markerIndex === promptMarkerIndex
        ? PROMPT_MARKER_PREFIX
        : POWERSHELL_MARKER_PREFIX;
    const terminator = findOscTerminator(
      input,
      markerIndex + markerPrefix.length,
    );

    if (!terminator) {
      return {
        output,
        liveCwd,
        promptReturned,
        pending: input.slice(markerIndex),
      };
    }

    if (markerPrefix === PROMPT_MARKER_PREFIX) {
      promptReturned = true;
    } else {
      const encoded = input.slice(
        markerIndex + POWERSHELL_MARKER_PREFIX.length,
        terminator.index,
      );
      const decoded = decodeBase64(encoded);

      if (decoded !== null) {
        liveCwd = decoded;
      }
    }

    cursor = terminator.nextIndex;
  }

  return {
    output,
    liveCwd,
    promptReturned,
    pending: '',
  };
}

function buildPowerShellPromptBootstrap(): string {
  return [
    '$global:__terminalCanvasOriginalPrompt = $function:prompt',
    'function global:prompt {',
    '  $cwd = (Get-Location).Path',
    '  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($cwd))',
    "  [Console]::Out.Write([string]::Concat([char]27, ']633;TerminalCanvasCwd=', $encoded, [char]7))",
    "  [Console]::Out.Write([string]::Concat([char]27, ']633;TerminalCanvasPrompt=1', [char]7))",
    '  if ($global:__terminalCanvasOriginalPrompt) {',
    '    & $global:__terminalCanvasOriginalPrompt',
    '  } else {',
    '    "PS $($executionContext.SessionState.Path.CurrentLocation)$(\'>\' * ($nestedPromptLevel + 1)) "',
    '  }',
    '}',
  ].join('; ');
}

function containsPowerShellLaunchDirective(args: readonly string[]): boolean {
  const launchDirectives = new Set([
    '-command',
    '-c',
    '-file',
    '-f',
    '-encodedcommand',
    '-ec',
  ]);

  return args.some((arg) => launchDirectives.has(arg.toLowerCase()));
}

function buildBashPromptCommand(existingCommand: string | undefined): string {
  const promptCommand = "printf '\\033]633;TerminalCanvasPrompt=1\\007'";

  if (!existingCommand?.trim()) {
    return promptCommand;
  }

  return `${existingCommand}; ${promptCommand}`;
}

function findOscTerminator(
  input: string,
  searchFrom: number,
): {
  index: number;
  nextIndex: number;
} | null {
  const matches = OSC_TERMINATORS.map((terminator) => ({
    terminator,
    index: input.indexOf(terminator, searchFrom),
  })).filter((candidate) => candidate.index >= 0);

  if (!matches.length) {
    return null;
  }

  matches.sort((left, right) => left.index - right.index);
  const next = matches[0];

  if (!next) {
    return null;
  }

  return {
    index: next.index,
    nextIndex: next.index + next.terminator.length,
  };
}

function decodeBase64(value: string): string | null {
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function getNextMarkerIndex(...candidates: number[]): number {
  const matches = candidates.filter((candidate) => candidate >= 0);

  if (!matches.length) {
    return -1;
  }

  return Math.min(...matches);
}
