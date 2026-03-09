import { useEffect, useRef, useState } from 'react';

import { getDefaultShell } from '../../shared/platform';
import type {
  AgentType,
  CreateTerminalNodeInput,
} from '../../shared/workspace';
import { getSemanticZoomMode } from '../../shared/workspace';
import { cancelViewportAnimation, focusTerminalWithTransition } from '../canvas/focus';
import { WorkspaceCanvas } from '../canvas/WorkspaceCanvas';
import { useTerminalSessions } from '../state/useTerminalSessions';
import { useWorkspace } from '../state/useWorkspace';

export function App() {
  const {
    workspace,
    persistence,
    updateWorkspace,
    addTerminal,
    addMarkdown,
    updateTerminal,
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
  const [healthError, setHealthError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [terminalShell, setTerminalShell] = useState(getDefaultShell());
  const [terminalAgentType, setTerminalAgentType] =
    useState<AgentType>('shell');
  const [focusAutoFocusAtMs, setFocusAutoFocusAtMs] = useState<number | null>(
    null,
  );
  const viewportAnimationFrameRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      cancelViewportAnimation(viewportAnimationFrameRef);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadHealth() {
      try {
        const response = await fetch('/api/health');

        if (!response.ok) {
          throw new Error(`Health check failed with ${response.status}`);
        }

        await response.json();
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

  useEffect(() => {
    if (!workspace || selectedNodeId) {
      return;
    }

    if (
      getSemanticZoomMode(workspace.currentViewport.zoom) === 'focus' &&
      workspace.terminals.length === 1
    ) {
      const terminal = workspace.terminals[0];

      if (!terminal) {
        return;
      }
      focusTerminalWithTransition({
        terminal,
        startViewport: workspace.currentViewport,
        updateWorkspace,
        onSelectTerminal: setSelectedNodeId,
        onAutoFocusAtChange: setFocusAutoFocusAtMs,
        onViewportChange: setViewport,
        animationFrameRef: viewportAnimationFrameRef,
      });
    }
  }, [selectedNodeId, setViewport, updateWorkspace, workspace]);

  if (!workspace) {
    return (
      <div className="app-shell app-shell-loading">
        <section className="workspace-panel-loading">
          <p className="eyebrow">Workspace</p>
          <h2>Loading persisted workspace...</h2>
          <p>
            {persistence.error ??
              'Fetching the saved layout from the local server.'}
          </p>
        </section>
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

    focusTerminalWithTransition({
      terminal,
      startViewport: currentViewport,
      updateWorkspace,
      onSelectTerminal: setSelectedNodeId,
      onAutoFocusAtChange: setFocusAutoFocusAtMs,
      onViewportChange: setViewport,
      animationFrameRef: viewportAnimationFrameRef,
    });
  }

  function launchTerminal(input: CreateTerminalNodeInput) {
    const createdTerminal = addTerminal(input, { persistImmediately: true });

    if (!createdTerminal) {
      return;
    }

    focusTerminalWithTransition({
      terminal: createdTerminal,
      startViewport: currentViewport,
      updateWorkspace,
      onSelectTerminal: setSelectedNodeId,
      onAutoFocusAtChange: setFocusAutoFocusAtMs,
      onViewportChange: setViewport,
      animationFrameRef: viewportAnimationFrameRef,
    });
  }

  function handleSelectedNodeChange(nodeId: string | null) {
    if (
      nodeId === null &&
      semanticMode === 'focus' &&
      terminals.length === 1 &&
      terminals[0]
    ) {
      setSelectedNodeId(terminals[0].id);
      return;
    }

    setSelectedNodeId(nodeId);
  }

  return (
    <div className="app-shell">
      <WorkspaceCanvas
        workspace={workspace}
        selectedNodeId={selectedNodeId}
        sessions={sessions}
        socketState={socketState}
        onTerminalInput={sendInput}
        onTerminalResize={resizeSession}
        onTerminalRestart={restartSession}
        onTerminalChange={updateTerminal}
        onMarkTerminalRead={markSessionRead}
        onSelectedNodeChange={handleSelectedNodeChange}
        onTerminalFocusRequest={focusTerminal}
        onWorkspaceChange={updateWorkspace}
        onViewportChange={setViewport}
        focusAutoFocusAtMs={focusAutoFocusAtMs}
      />

      <header className="workspace-toolbar">
        <div className="workspace-toolbar-row">
          <div className="toolbar-cluster toolbar-cluster-primary">
            <button
              type="button"
              onClick={() => {
                launchTerminal({
                  label: getDefaultTerminalLabel(
                    terminalAgentType,
                    workspace.terminals.length + 1,
                  ),
                  shell: terminalShell,
                  cwd: '.',
                  agentType: terminalAgentType,
                });
              }}
            >
              Add Terminal
            </button>
            <label className="toolbar-select-field">
              <span className="meta-label">Shell</span>
              <select
                className="toolbar-select"
                value={terminalShell}
                onChange={(event) => {
                  setTerminalShell(event.target.value);
                }}
              >
                <option value={getDefaultShell()}>
                  {getDefaultShell() === 'powershell.exe'
                    ? 'PowerShell'
                    : getDefaultShell()}
                </option>
              </select>
            </label>
            <label className="toolbar-select-field">
              <span className="meta-label">Agent</span>
              <select
                className="toolbar-select"
                value={terminalAgentType}
                onChange={(event) => {
                  setTerminalAgentType(event.target.value as AgentType);
                }}
              >
                <option value="shell">Shell</option>
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            <button type="button" onClick={addMarkdown}>
              Add Markdown
            </button>
          </div>

          <div className="preset-strip toolbar-center-strip">
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

          <div className="toolbar-cluster toolbar-cluster-actions">
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
        </div>
      </header>

      <footer className="workspace-footer">
        <span>WORKSPACE {workspace.name}</span>
        <span>ZOOM MODE {currentViewport.zoom.toFixed(2)}x</span>
        <span>PERSISTENCE {persistence.phase}</span>
        <span>SEMANTIC ZOOM {semanticMode}</span>
        <span>
          TERMINAL SOCKET {healthError ? 'backend degraded' : socketState}
        </span>
      </footer>
    </div>
  );
}

function getDefaultTerminalLabel(
  agentType: AgentType,
  terminalNumber: number,
): string {
  if (agentType === 'claude') {
    return `Claude ${terminalNumber}`;
  }

  if (agentType === 'codex') {
    return `Codex ${terminalNumber}`;
  }

  return `Shell ${terminalNumber}`;
}
