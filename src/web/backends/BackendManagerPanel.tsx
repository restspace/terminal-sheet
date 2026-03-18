import { useState } from 'react';

import type { ServerRole } from '../../shared/backends';
import type { BackendEntry } from '../state/useBackends';
import { useBackends } from '../state/useBackends';

interface BackendManagerPanelProps {
  asideId: string;
  serverRole: ServerRole | null;
}

export function BackendManagerPanel({
  asideId,
  serverRole,
}: BackendManagerPanelProps) {
  const {
    backends,
    tokenInfo,
    isLoading,
    error,
    addBackend,
    removeBackend,
    rotateBackendToken,
    rotateLocalToken,
  } = useBackends(true);

  const [addLabel, setAddLabel] = useState('');
  const [addUrl, setAddUrl] = useState('');
  const [addToken, setAddToken] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [showInstallScript, setShowInstallScript] = useState(false);
  const [rotatingIds, setRotatingIds] = useState<Set<string>>(new Set());
  const [isRotatingLocal, setIsRotatingLocal] = useState(false);

  const canAddRemote = serverRole === 'home';

  const handleAdd = async () => {
    const label = addLabel.trim();
    const url = addUrl.trim();
    const token = addToken.trim();

    if (!label || !url || !token) {
      setAddError('Label, URL, and token are required.');
      return;
    }

    setIsAdding(true);
    setAddError(null);

    try {
      await addBackend(label, url, token);
      setAddLabel('');
      setAddUrl('');
      setAddToken('');
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to add backend');
    } finally {
      setIsAdding(false);
    }
  };

  const handleRemove = async (backendId: string) => {
    await removeBackend(backendId);
  };

  const handleRotateBackendToken = async (backendId: string) => {
    setRotatingIds((current) => new Set([...current, backendId]));

    try {
      await rotateBackendToken(backendId);
    } finally {
      setRotatingIds((current) => {
        const next = new Set(current);
        next.delete(backendId);
        return next;
      });
    }
  };

  const handleRotateLocalToken = async () => {
    setIsRotatingLocal(true);

    try {
      await rotateLocalToken();
    } finally {
      setIsRotatingLocal(false);
    }
  };

  const installScriptUrl = `${window.location.origin}/install.sh`;
  const installCommand = `curl -fsSL ${installScriptUrl} | bash`;

  return (
    <aside id={asideId} className="backend-manager-panel">
      <div className="backend-manager-header">
        <div>
          <p className="eyebrow">Backend Manager</p>
          <h2>Remote machines</h2>
        </div>
      </div>

      {isLoading && backends.length === 0 ? (
        <div className="backend-manager-loading">Loading...</div>
      ) : error ? (
        <div className="backend-manager-error">{error}</div>
      ) : null}

      <div className="backend-manager-section">
        <h3>Remote backends</h3>
        {backends.length === 0 ? (
          <p className="backend-manager-empty">No remote backends configured.</p>
        ) : (
          <div className="backend-list">
            {backends.map((backend) => (
              <BackendRow
                key={backend.id}
                backend={backend}
                isRotating={rotatingIds.has(backend.id)}
                onRemove={handleRemove}
                onRotateToken={handleRotateBackendToken}
              />
            ))}
          </div>
        )}
      </div>

      {!canAddRemote && serverRole !== null ? (
        <div className="backend-manager-section">
          <h3>Add remote backend</h3>
          <p className="backend-manager-meta">
            Start the server with <code>--role home</code> to manage remote backends.
          </p>
        </div>
      ) : canAddRemote ? (
        <div className="backend-manager-section">
          <h3>Add remote backend</h3>

          <div className="backend-add-mode-toggle">
            <button
              type="button"
              className={showInstallScript ? 'backend-mode-tab' : 'backend-mode-tab is-active'}
              onClick={() => { setShowInstallScript(false); }}
            >
              Manual
            </button>
            <button
              type="button"
              className={showInstallScript ? 'backend-mode-tab is-active' : 'backend-mode-tab'}
              onClick={() => { setShowInstallScript(true); }}
            >
              Install script
            </button>
          </div>

          {showInstallScript ? (
            <div className="backend-install-script">
              <p>Run this on the remote machine:</p>
              <div className="backend-script-block">
                <code>{installCommand}</code>
                <button
                  type="button"
                  className="backend-copy-button"
                  onClick={() => { void navigator.clipboard.writeText(installCommand); }}
                >
                  Copy
                </button>
              </div>
              <p className="backend-script-note">
                The install script sets up Terminal Sheet as a service and prints{' '}
                <code>TSHEET_TOKEN=...</code>. Paste that token below.
              </p>
              <p className="backend-script-note">
                Home URL used in script: <code>{window.location.origin}</code>
              </p>
            </div>
          ) : null}

          <div className="backend-add-form">
            <label className="backend-form-field">
              <span>Label</span>
              <input
                value={addLabel}
                onChange={(event) => { setAddLabel(event.target.value); setAddError(null); }}
                placeholder="My Server"
              />
            </label>
            <label className="backend-form-field">
              <span>URL</span>
              <input
                value={addUrl}
                onChange={(event) => { setAddUrl(event.target.value); setAddError(null); }}
                placeholder="http://192.168.1.100:4312"
              />
            </label>
            <label className="backend-form-field">
              <span>{showInstallScript ? 'Paste TSHEET_TOKEN' : 'Token'}</span>
              <input
                value={addToken}
                onChange={(event) => { setAddToken(event.target.value); setAddError(null); }}
                placeholder="Machine token from remote server"
              />
            </label>
            {addError ? (
              <p className="backend-form-error">{addError}</p>
            ) : null}
            <button
              type="button"
              disabled={isAdding}
              onClick={() => { void handleAdd(); }}
            >
              {isAdding ? 'Adding...' : 'Add backend'}
            </button>
          </div>
        </div>
      ) : null}

      <div className="backend-manager-section">
        <h3>Local server token</h3>
        <p className="backend-manager-meta">
          Other machines need this token to connect to this server.
        </p>
        {tokenInfo ? (
          <div className="backend-token-row">
            <code className="backend-token-preview">
              {tokenInfo.tokenPreview}...
            </code>
            <span className="backend-token-server-id">
              ID: {tokenInfo.serverId.slice(0, 8)}
            </span>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(tokenInfo.tokenPreview);
              }}
            >
              Copy preview
            </button>
            <button
              type="button"
              disabled={isRotatingLocal}
              onClick={() => { void handleRotateLocalToken(); }}
            >
              {isRotatingLocal ? 'Rotating...' : 'Rotate'}
            </button>
          </div>
        ) : (
          <p className="backend-manager-meta">
            Use <code>tsheet token show</code> to view the full token.
          </p>
        )}
      </div>
    </aside>
  );
}

interface BackendRowProps {
  backend: BackendEntry;
  isRotating: boolean;
  onRemove: (backendId: string) => void;
  onRotateToken: (backendId: string) => void;
}

function BackendRow({ backend, isRotating, onRemove, onRotateToken }: BackendRowProps) {
  const state = backend.status?.state ?? (backend.enabled ? 'connecting' : 'disabled');

  return (
    <div className="backend-row">
      <span
        className={`backend-status-dot is-${state}`}
        title={state}
        aria-hidden="true"
      />
      <div className="backend-row-info">
        <strong>{backend.label}</strong>
        <span className="backend-row-url">{backend.baseUrl}</span>
        {backend.status?.lastError ? (
          <span className="backend-row-error">{backend.status.lastError}</span>
        ) : null}
      </div>
      <div className="backend-row-actions">
        <button
          type="button"
          disabled={isRotating || state !== 'connected'}
          title={state !== 'connected' ? 'Connect first to rotate token' : 'Rotate token'}
          onClick={() => { onRotateToken(backend.id); }}
        >
          {isRotating ? 'Rotating...' : 'Rotate token'}
        </button>
        <button
          type="button"
          onClick={() => { onRemove(backend.id); }}
        >
          Remove
        </button>
      </div>
    </div>
  );
}
