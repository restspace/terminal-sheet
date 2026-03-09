import { useState } from 'react';

import type { TerminalSessionSnapshot } from '../../shared/terminalSessions';
import type { AgentType, CreateTerminalNodeInput } from '../../shared/workspace';
import { getSemanticZoomMode, type Workspace } from '../../shared/workspace';
import type { WorkspacePersistenceState } from '../state/useWorkspace';

interface HealthState {
  status: string;
  port: number;
  workspacePath: string;
  devMode: boolean;
  liveSessions: number;
  timestamp: string;
}

interface EventFeedProps {
  health: HealthState | null;
  healthError: string | null;
  persistence: WorkspacePersistenceState;
  workspace: Workspace;
  sessions: Record<string, TerminalSessionSnapshot>;
  socketState: 'connecting' | 'open' | 'closed' | 'error';
  activePresetId: string | null;
  selectedNodeId: string | null;
  onLaunchTerminal: (input: CreateTerminalNodeInput) => void;
}

export function EventFeed({
  health,
  healthError,
  persistence,
  workspace,
  sessions,
  socketState,
  activePresetId,
  selectedNodeId,
  onLaunchTerminal,
}: EventFeedProps) {
  const [draft, setDraft] = useState<CreateTerminalNodeInput>({
    label: `Shell ${workspace.terminals.length + 1}`,
    shell: defaultShell(),
    cwd: '.',
    agentType: 'shell',
    repoLabel: 'local workspace',
    taskLabel: 'live terminal session',
    tags: [],
  });
  const currentMode = getSemanticZoomMode(workspace.currentViewport.zoom);
  const activePreset =
    workspace.cameraPresets.find((preset) => preset.id === activePresetId) ??
    null;
  const liveSessionCount = Object.values(sessions).filter(
    (session) => session.connected,
  ).length;
  const sessionEntries = workspace.terminals
    .map((terminal) => ({
      terminal,
      session: sessions[terminal.id] ?? null,
    }))
    .slice(0, 6);

  return (
    <aside className="event-feed">
      <div className="event-feed-header">
        <p className="eyebrow">Event Feed</p>
        <h2>Workspace state</h2>
      </div>

      <div className="event-card launch-card">
        <strong>Launch terminal</strong>
        <label className="launch-field">
          <span>Label</span>
          <input
            value={draft.label}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                label: event.target.value,
              }))
            }
          />
        </label>
        <label className="launch-field">
          <span>Shell</span>
          <input
            value={draft.shell}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                shell: event.target.value,
              }))
            }
          />
        </label>
        <label className="launch-field">
          <span>Cwd</span>
          <input
            value={draft.cwd}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                cwd: event.target.value,
              }))
            }
          />
        </label>
        <label className="launch-field">
          <span>Agent</span>
          <select
            value={draft.agentType}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                agentType: event.target.value as AgentType,
              }))
            }
          >
            <option value="shell">Shell</option>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            onLaunchTerminal(draft);
            setDraft((current) => ({
              ...current,
              label: `Shell ${workspace.terminals.length + 2}`,
            }));
          }}
        >
          Launch
        </button>
      </div>

      <div className="event-card">
        <strong>Persistence</strong>
        <p>
          {persistence.phase === 'saved'
            ? `Saved locally at ${persistence.lastSavedAt ?? 'unknown time'}`
            : persistence.phase === 'saving'
              ? 'Saving workspace changes...'
              : persistence.error ?? 'Workspace load failed.'}
        </p>
      </div>

      <div className="event-card">
        <strong>Canvas mode</strong>
        <p>
          {currentMode} view, {workspace.terminals.length} terminals,{' '}
          {workspace.markdown.length} Markdown nodes
        </p>
      </div>

      <div className="event-card">
        <strong>Selected preset</strong>
        <p>{activePreset?.name ?? 'No preset selected'}</p>
      </div>

      <div className="event-card">
        <strong>Selected node</strong>
        <p>{selectedNodeId ?? 'No node selected'}</p>
      </div>

      <div className="event-card">
        <strong>Local server</strong>
        <p>
          {healthError
            ? `Unable to reach /api/health: ${healthError}`
            : health
              ? `Listening on port ${health.port} with ${liveSessionCount} live sessions`
              : 'Waiting for health check...'}
        </p>
      </div>

      <div className="event-card">
        <strong>Terminal socket</strong>
        <p>{socketState}</p>
      </div>

      {sessionEntries.map(({ terminal, session }) => (
        <div key={terminal.id} className="event-card">
          <strong>{terminal.label}</strong>
          <p>
            {session
              ? `${session.status} - ${session.summary}`
              : 'Waiting for PTY session snapshot...'}
          </p>
        </div>
      ))}
    </aside>
  );
}

function defaultShell(): string {
  if (typeof navigator !== 'undefined' && navigator.userAgent.includes('Win')) {
    return 'powershell.exe';
  }

  return 'bash';
}
