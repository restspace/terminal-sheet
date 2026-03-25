import { parseArgs } from 'node:util';

export async function runSpawnCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      command: {
        type: 'string',
        short: 'c',
      },
      label: {
        type: 'string',
        short: 'l',
      },
      cwd: {
        type: 'string',
      },
      'agent-type': {
        type: 'string',
      },
      wait: {
        type: 'boolean',
        default: false,
      },
      timeout: {
        type: 'string',
        default: '300',
      },
    },
  });

  const spawnUrl = process.env.TERMINAL_CANVAS_SPAWN_URL;
  const token = process.env.TERMINAL_CANVAS_ATTENTION_TOKEN;
  const sessionId = process.env.TERMINAL_CANVAS_SESSION_ID;

  if (!spawnUrl || !token) {
    throw new Error(
      'Not running inside a tsheet terminal. ' +
        'TERMINAL_CANVAS_SPAWN_URL and TERMINAL_CANVAS_ATTENTION_TOKEN must be set.',
    );
  }

  if (!values.command) {
    throw new Error(
      'Usage: tsheet spawn --command "..." [--label "..."] [--cwd "."] [--agent-type shell] [--wait] [--timeout 300]',
    );
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-terminal-canvas-token': token,
  };

  if (sessionId) {
    headers['x-terminal-canvas-session-id'] = sessionId;
  }

  const body: Record<string, unknown> = {
    command: values.command,
  };

  if (values.label) {
    body.label = values.label;
  }

  if (values.cwd) {
    body.cwd = values.cwd;
  }

  if (values['agent-type']) {
    body.agentType = values['agent-type'];
  }

  const spawnResponse = await fetch(spawnUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!spawnResponse.ok) {
    const text = await spawnResponse.text();
    throw new Error(`Spawn failed (${spawnResponse.status}): ${text}`);
  }

  const result = (await spawnResponse.json()) as {
    ok: boolean;
    terminalId: string;
    sessionId: string;
  };

  console.log(result.terminalId);

  if (!values.wait) {
    return;
  }

  const timeout = Number(values.timeout) || 300;
  const waitUrl = `${spawnUrl}/${encodeURIComponent(result.terminalId)}/wait?timeout=${timeout}`;

  const waitResponse = await fetch(waitUrl, {
    headers: {
      'x-terminal-canvas-token': token,
    },
  });

  if (!waitResponse.ok) {
    const text = await waitResponse.text();
    throw new Error(`Wait failed (${waitResponse.status}): ${text}`);
  }

  const waitResult = (await waitResponse.json()) as {
    terminalId: string;
    exitCode: number | null;
    timedOut: boolean;
  };

  if (waitResult.timedOut) {
    console.error('Timed out waiting for terminal to exit.');
    process.exit(124);
  }

  process.exit(waitResult.exitCode ?? 1);
}
