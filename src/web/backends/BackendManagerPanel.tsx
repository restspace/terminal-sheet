import { useEffect, useRef, useState } from 'react';

import { LOCAL_BACKEND_ID } from '../../shared/backends';
import type { ServerRole } from '../../shared/backends';
import { FileSystemPickerModal } from '../app/FileSystemPickerModal';
import type { BackendEntry } from '../state/useBackends';
import { useBackends } from '../state/useBackends';

interface BackendManagerPanelProps {
  asideId: string;
  serverRole: ServerRole | null;
  onBackendsChanged?: () => void | Promise<unknown>;
}

export function BackendManagerPanel({
  asideId,
  serverRole,
  onBackendsChanged,
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
    setupSshBackend,
  } = useBackends(true);

  const [addLabel, setAddLabel] = useState('');
  const [addUrl, setAddUrl] = useState('');
  const [addToken, setAddToken] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [addMode, setAddMode] = useState<'manual' | 'install-script' | 'ssh-setup'>('manual');
  const [rotatingIds, setRotatingIds] = useState<Set<string>>(new Set());
  const [isRotatingLocal, setIsRotatingLocal] = useState(false);
  const [sshLabel, setSshLabel] = useState('');
  const [sshTarget, setSshTarget] = useState('');
  const [sshPort, setSshPort] = useState('22');
  const [sshIdentityFile, setSshIdentityFile] = useState('');
  const [sshRemotePort, setSshRemotePort] = useState('4312');
  const [sshTokenMode, setSshTokenMode] = useState<'install-output' | 'manual' | 'file'>(
    'install-output',
  );
  const [sshToken, setSshToken] = useState('');
  const [sshTokenPath, setSshTokenPath] = useState('');
  const [sshRunInstall, setSshRunInstall] = useState(true);
  const [sshError, setSshError] = useState<string | null>(null);
  const [isSshSettingUp, setIsSshSettingUp] = useState(false);
  const [isTokenPathPickerOpen, setIsTokenPathPickerOpen] = useState(false);
  const [isSshKeyPathPickerOpen, setIsSshKeyPathPickerOpen] = useState(false);
  const [pendingHighlightBackendId, setPendingHighlightBackendId] = useState<string | null>(null);
  const [highlightedBackendId, setHighlightedBackendId] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);

  const canAddRemote = serverRole === 'home';

  const notifyBackendsChanged = () => {
    if (!onBackendsChanged) {
      return;
    }

    void onBackendsChanged();
  };

  useEffect(() => {
    if (!pendingHighlightBackendId) {
      return;
    }

    if (!backends.some((backend) => backend.id === pendingHighlightBackendId)) {
      return;
    }

    setHighlightedBackendId(pendingHighlightBackendId);
    setPendingHighlightBackendId(null);
    panelRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [backends, pendingHighlightBackendId]);

  useEffect(() => {
    if (!highlightedBackendId) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setHighlightedBackendId((current) =>
        current === highlightedBackendId ? null : current,
      );
    }, 3_500);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [highlightedBackendId]);

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
      notifyBackendsChanged();
      setAddLabel('');
      setAddUrl('');
      setAddToken('');
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to add backend');
    } finally {
      setIsAdding(false);
    }
  };

  const handleSshSetup = async () => {
    const label = sshLabel.trim();
    const target = sshTarget.trim();
    const sshPortRaw = sshPort.trim();
    const parsedSshPort = sshPortRaw ? Number.parseInt(sshPortRaw, 10) : 22;
    const normalizedSshPort = Number.isFinite(parsedSshPort) ? parsedSshPort : NaN;
    const remotePort = Number.parseInt(sshRemotePort, 10);
    const token = sshToken.trim();
    const tokenPath = sshTokenPath.trim();
    const identityFile = sshIdentityFile.trim();

    if (!label || !target) {
      setSshError('Label and SSH target are required.');
      return;
    }

    if (!Number.isFinite(remotePort) || remotePort < 1 || remotePort > 65_535) {
      setSshError('Remote port must be between 1 and 65535.');
      return;
    }

    if (!Number.isFinite(normalizedSshPort) || normalizedSshPort < 1 || normalizedSshPort > 65_535) {
      setSshError('SSH port must be between 1 and 65535.');
      return;
    }

    if (sshTokenMode === 'manual' && !token) {
      setSshError('Manual token is required.');
      return;
    }

    if (sshTokenMode === 'file' && !tokenPath) {
      setSshError('Token file path is required.');
      return;
    }

    if (sshTokenMode === 'install-output' && !sshRunInstall) {
      setSshError('Install-output token mode requires remote install to be enabled.');
      return;
    }

    setIsSshSettingUp(true);
    setSshError(null);

    try {
      const createdBackendId = await setupSshBackend({
        label,
        sshTarget: target,
        sshPort: normalizedSshPort,
        sshIdentityFile: identityFile || undefined,
        remotePort,
        tokenMode: sshTokenMode,
        token: sshTokenMode === 'manual' ? token : undefined,
        tokenPath: sshTokenMode === 'file' ? tokenPath : undefined,
        runInstall: sshRunInstall,
      });
      setPendingHighlightBackendId(createdBackendId);
      panelRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      notifyBackendsChanged();
      setSshLabel('');
      setSshTarget('');
      setSshPort('22');
      setSshIdentityFile('');
      setSshRemotePort('4312');
      setSshTokenMode('install-output');
      setSshToken('');
      setSshTokenPath('');
    } catch (error) {
      setSshError(error instanceof Error ? error.message : 'SSH setup failed');
    } finally {
      setIsSshSettingUp(false);
    }
  };

  const handleRemove = async (backendId: string) => {
    await removeBackend(backendId);
    notifyBackendsChanged();
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
    <aside
      id={asideId}
      className="backend-manager-panel"
      ref={panelRef}
    >
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
                isHighlighted={backend.id === highlightedBackendId}
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
              className={addMode === 'manual' ? 'backend-mode-tab is-active' : 'backend-mode-tab'}
              onClick={() => { setAddMode('manual'); setAddError(null); setSshError(null); }}
            >
              Manual
            </button>
            <button
              type="button"
              className={
                addMode === 'install-script'
                  ? 'backend-mode-tab is-active'
                  : 'backend-mode-tab'
              }
              onClick={() => { setAddMode('install-script'); setAddError(null); setSshError(null); }}
            >
              Install script
            </button>
            <button
              type="button"
              className={addMode === 'ssh-setup' ? 'backend-mode-tab is-active' : 'backend-mode-tab'}
              onClick={() => { setAddMode('ssh-setup'); setAddError(null); setSshError(null); }}
            >
              SSH setup
            </button>
          </div>

          {addMode === 'install-script' ? (
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

          {addMode === 'manual' || addMode === 'install-script' ? (
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
                <span>{addMode === 'install-script' ? 'Paste TSHEET_TOKEN' : 'Token'}</span>
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
          ) : null}

          {addMode === 'ssh-setup' ? (
            <div className="backend-add-form">
              <label className="backend-form-field">
                <span>Label</span>
                <input
                  value={sshLabel}
                  onChange={(event) => { setSshLabel(event.target.value); setSshError(null); }}
                  placeholder="Remote SSH Machine"
                />
              </label>
              <label className="backend-form-field">
                <span>SSH target</span>
                <input
                  value={sshTarget}
                  onChange={(event) => { setSshTarget(event.target.value); setSshError(null); }}
                  placeholder="user@hostname"
                />
              </label>
              <label className="backend-form-field">
                <span>SSH port</span>
                <input
                  value={sshPort}
                  onChange={(event) => { setSshPort(event.target.value); setSshError(null); }}
                  placeholder="22"
                />
              </label>
              <label className="backend-form-field">
                <span>SSH key path (optional)</span>
                <div className="backend-inline-row">
                  <input
                    value={sshIdentityFile}
                    onChange={(event) => { setSshIdentityFile(event.target.value); setSshError(null); }}
                    placeholder="~/.ssh/my-key.pem"
                  />
                  <button
                    type="button"
                    className="backend-inline-button"
                    onClick={() => { setIsSshKeyPathPickerOpen(true); }}
                  >
                    Browse
                  </button>
                </div>
              </label>
              <label className="backend-form-field">
                <span>Remote backend port</span>
                <input
                  value={sshRemotePort}
                  onChange={(event) => { setSshRemotePort(event.target.value); setSshError(null); }}
                  placeholder="4312"
                />
              </label>
              <label className="backend-form-field">
                <span>Token source</span>
                <select
                  value={sshTokenMode}
                  onChange={(event) => {
                    setSshTokenMode(
                      event.target.value as 'install-output' | 'manual' | 'file',
                    );
                    setSshError(null);
                  }}
                >
                  <option value="install-output">From install output</option>
                  <option value="manual">Manual token</option>
                  <option value="file">Token file path</option>
                </select>
              </label>
              {sshTokenMode === 'install-output' ? (
                <p className="backend-manager-meta">
                  Token will be captured from <code>TSHEET_TOKEN=...</code> in the installer output.
                </p>
              ) : null}
              {sshTokenMode === 'manual' ? (
                <label className="backend-form-field">
                  <span>Token</span>
                  <input
                    value={sshToken}
                    onChange={(event) => { setSshToken(event.target.value); setSshError(null); }}
                    placeholder="Machine token from remote server"
                  />
                </label>
              ) : null}
              {sshTokenMode === 'file' ? (
                <label className="backend-form-field">
                  <span>Token file path (home server)</span>
                  <div className="backend-inline-row">
                    <input
                      value={sshTokenPath}
                      onChange={(event) => { setSshTokenPath(event.target.value); setSshError(null); }}
                      placeholder="./tokens/remote-token.txt"
                    />
                    <button
                      type="button"
                      className="backend-inline-button"
                      onClick={() => { setIsTokenPathPickerOpen(true); }}
                    >
                      Browse
                    </button>
                  </div>
                </label>
              ) : null}
              <label className="backend-checkbox-field">
                <input
                  type="checkbox"
                  checked={sshRunInstall}
                  onChange={(event) => {
                    setSshRunInstall(event.target.checked);
                    if (!event.target.checked && sshTokenMode === 'install-output') {
                      setSshTokenMode('manual');
                    }
                    setSshError(null);
                  }}
                />
                <span>Run remote install script before connecting</span>
              </label>
              {sshError ? (
                <p className="backend-form-error">{sshError}</p>
              ) : null}
              <button
                type="button"
                disabled={isSshSettingUp}
                onClick={() => { void handleSshSetup(); }}
              >
                {isSshSettingUp ? 'Setting up...' : 'Set up SSH backend'}
              </button>
            </div>
          ) : null}
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

      {isTokenPathPickerOpen ? (
        <FileSystemPickerModal
          title="Select token file"
          subtitle="Home server filesystem"
          server={LOCAL_BACKEND_ID}
          mode="file"
          initialDirectoryPath="."
          confirmLabel="Use file"
          onConfirm={(selectedPath) => {
            setSshTokenPath(selectedPath);
            setSshError(null);
          }}
          onClose={() => {
            setIsTokenPathPickerOpen(false);
          }}
        />
      ) : null}

      {isSshKeyPathPickerOpen ? (
        <FileSystemPickerModal
          title="Select SSH private key"
          subtitle="Home server filesystem"
          server={LOCAL_BACKEND_ID}
          mode="file"
          initialDirectoryPath="."
          confirmLabel="Use key"
          onConfirm={(selectedPath) => {
            setSshIdentityFile(selectedPath);
            setSshError(null);
          }}
          onClose={() => {
            setIsSshKeyPathPickerOpen(false);
          }}
        />
      ) : null}
    </aside>
  );
}

interface BackendRowProps {
  backend: BackendEntry;
  isRotating: boolean;
  isHighlighted: boolean;
  onRemove: (backendId: string) => void;
  onRotateToken: (backendId: string) => void;
}

function BackendRow({
  backend,
  isRotating,
  isHighlighted,
  onRemove,
  onRotateToken,
}: BackendRowProps) {
  const state = backend.status?.state ?? (backend.enabled ? 'connecting' : 'disabled');
  const tunnel = backend.status?.tunnel ?? null;

  return (
    <div className={isHighlighted ? 'backend-row is-newly-added' : 'backend-row'}>
      <span
        className={`backend-status-dot is-${state}`}
        title={state}
        aria-hidden="true"
      />
      <div className="backend-row-info">
        <strong>{backend.label}</strong>
        {isHighlighted ? (
          <span className="backend-row-new-badge">New</span>
        ) : null}
        <span className="backend-row-url">{backend.baseUrl}</span>
        {tunnel ? (
          <span className="backend-row-url">
            Tunnel {tunnel.state} at {tunnel.localUrl}
          </span>
        ) : null}
        {backend.status?.lastError ? (
          <span className="backend-row-error">{backend.status.lastError}</span>
        ) : null}
        {!backend.status?.lastError && tunnel?.lastError ? (
          <span className="backend-row-error">{tunnel.lastError}</span>
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
