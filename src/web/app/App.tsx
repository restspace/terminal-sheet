import { useEffect, useState } from 'react';

import type {
  CameraViewport,
  CreateTerminalNodeInput,
  TerminalNode,
} from '../../shared/workspace';
import { getSemanticZoomMode } from '../../shared/workspace';
import { WorkspaceCanvas } from '../canvas/WorkspaceCanvas';
import { EventFeed } from '../event-feed/EventFeed';
import { useTerminalSessions } from '../state/useTerminalSessions';
import { useWorkspace } from '../state/useWorkspace';

interface HealthState {
  status: string;
  port: number;
  workspacePath: string;
  devMode: boolean;
  liveSessions: number;
  timestamp: string;
}

export function App() {
  const {
    workspace,
    persistence,
    updateWorkspace,
    addTerminal,
    addMarkdown,
    setViewport,
    applyCameraPreset,
    saveViewportToPreset,
  } = useWorkspace();
  const {
    sessions,
    socketState,
    sendInput,
    resizeSession,
    restartSession,
    markSessionRead,
  } = useTerminalSessions();
  const [health, setHealth] = useState<HealthState | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadHealth() {
      try {
        const response = await fetch('/api/health');

        if (!response.ok) {
          throw new Error(`Health check failed with ${response.status}`);
        }

        const nextHealth = (await response.json()) as HealthState;

        if (!cancelled) {
          setHealth(nextHealth);
        }
      } catch (error) {
        if (!cancelled) {
          const message =
            error instanceof Error ? error.message : 'Unknown error';
          setHealthError(message);
        }
      }
    }

    void loadHealth();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!workspace || activePresetId) {
      return;
    }

    setActivePresetId(workspace.cameraPresets[0]?.id ?? null);
  }, [activePresetId, workspace]);

  if (!workspace) {
    return (
      <div className="app-shell">
        <header className="topbar">
          <div>
            <p className="eyebrow">Milestone 2</p>
            <h1>Terminal Canvas</h1>
          </div>
        </header>

        <main className="workspace-layout">
          <section className="workspace-panel workspace-panel-loading">
            <p className="eyebrow">Workspace</p>
            <h2>Loading persisted workspace...</h2>
            <p>
              {persistence.error ??
                'Fetching the saved layout from the local server.'}
            </p>
          </section>
        </main>
      </div>
    );
  }

  const terminals = workspace.terminals;
  const currentViewport = workspace.currentViewport;
  const semanticMode = getSemanticZoomMode(currentViewport.zoom);

  function focusTerminal(terminalId: string) {
    const terminal = terminals.find((candidate) => candidate.id === terminalId);

    if (!terminal) {
      return;
    }

    setSelectedNodeId(terminal.id);
    setViewport(createFocusViewport(terminal, currentViewport));
  }

  function launchTerminal(input: CreateTerminalNodeInput) {
    const createdTerminal = addTerminal(input, { persistImmediately: true });

    if (!createdTerminal) {
      return;
    }

    focusTerminal(createdTerminal.id);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Milestone 2</p>
          <h1>Terminal Canvas</h1>
        </div>
        <div className="topbar-actions">
          <button type="button" onClick={addMarkdown}>
            Add Markdown
          </button>
          <button
            type="button"
            onClick={() => {
              if (!activePresetId) {
                return;
              }

              saveViewportToPreset(activePresetId);
            }}
            disabled={!activePresetId}
          >
            Save current view
          </button>
        </div>
      </header>

      <main className="workspace-layout">
        <section className="workspace-panel">
          <div className="panel-meta">
            <div>
              <span className="meta-label">Workspace</span>
              <strong>{workspace.name}</strong>
            </div>
            <div>
              <span className="meta-label">Zoom mode</span>
              <strong>{semanticMode}</strong>
            </div>
            <div>
              <span className="meta-label">Persistence</span>
              <strong>{persistence.phase}</strong>
            </div>
          </div>

          <div className="preset-strip">
            {workspace.cameraPresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={
                  preset.id === activePresetId
                    ? 'preset-button is-active'
                    : 'preset-button'
                }
                onClick={() => {
                  setActivePresetId(preset.id);
                  applyCameraPreset(preset.id);
                }}
              >
                {preset.name}
              </button>
            ))}
          </div>

          <WorkspaceCanvas
            workspace={workspace}
            healthError={healthError}
            selectedNodeId={selectedNodeId}
            sessions={sessions}
            socketState={socketState}
            onTerminalInput={sendInput}
            onTerminalResize={resizeSession}
            onTerminalRestart={restartSession}
            onMarkTerminalRead={markSessionRead}
            onSelectedNodeChange={setSelectedNodeId}
            onTerminalFocusRequest={focusTerminal}
            onWorkspaceChange={updateWorkspace}
            onViewportChange={setViewport}
          />
        </section>

        <EventFeed
          health={health}
          healthError={healthError}
          persistence={persistence}
          workspace={workspace}
          sessions={sessions}
          socketState={socketState}
          activePresetId={activePresetId}
          selectedNodeId={selectedNodeId}
          onLaunchTerminal={launchTerminal}
        />
      </main>
    </div>
  );
}

function createFocusViewport(
  terminal: TerminalNode,
  currentViewport: CameraViewport,
): CameraViewport {
  const zoom = Math.max(currentViewport.zoom, 1.18);
  const estimatedCanvasWidth = 920;
  const estimatedCanvasHeight = 560;
  const centerX = terminal.bounds.x + terminal.bounds.width / 2;
  const centerY = terminal.bounds.y + terminal.bounds.height / 2;

  return {
    x: estimatedCanvasWidth / 2 - centerX * zoom,
    y: estimatedCanvasHeight / 2 - centerY * zoom,
    zoom,
  };
}
