import { describe, expect, it } from 'vitest';

import { LOCAL_BACKEND_ID } from '../../shared/backends';
import {
  createDefaultWorkspace,
  createTerminalNode,
} from '../../shared/workspace';
import { buildSessionBackendIndex } from './backendRuntimeManager';

describe('buildSessionBackendIndex', () => {
  it('maps workspace terminal IDs to backend IDs with local fallback', () => {
    const workspace = createDefaultWorkspace();
    const localTerminal = createTerminalNode(
      {
        label: 'Local',
        shell: 'powershell.exe',
        cwd: '.',
        agentType: 'shell',
      },
      0,
    );
    const remoteTerminal = createTerminalNode(
      {
        label: 'Remote',
        shell: 'powershell.exe',
        cwd: '.',
        agentType: 'codex',
        backendId: 'backend-remote',
      },
      1,
    );
    workspace.terminals = [localTerminal, remoteTerminal];

    const index = buildSessionBackendIndex(workspace, LOCAL_BACKEND_ID);

    expect(index.get(localTerminal.id)).toBe(LOCAL_BACKEND_ID);
    expect(index.get(remoteTerminal.id)).toBe('backend-remote');
    expect(index.size).toBe(2);
  });
});
