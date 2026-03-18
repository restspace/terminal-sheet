import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { FileSystemListResponse } from '../../shared/filesystem';
import { fetchFileSystemDirectory } from '../state/fileSystemClient';

const EMPTY_EXTENSIONS: string[] = [];

interface FileSystemPickerModalProps {
  title: string;
  subtitle?: string;
  server: string;
  mode: 'directory' | 'file';
  initialDirectoryPath?: string;
  extensions?: string[];
  confirmLabel: string;
  onConfirm: (selectedPath: string) => Promise<void> | void;
  onClose: () => void;
}

export function FileSystemPickerModal({
  title,
  subtitle,
  server,
  mode,
  initialDirectoryPath,
  extensions = EMPTY_EXTENSIONS,
  confirmLabel,
  onConfirm,
  onClose,
}: FileSystemPickerModalProps) {
  const [columns, setColumns] = useState<FileSystemListResponse[]>([]);
  const [activeColumnIndex, setActiveColumnIndex] = useState(0);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedKind, setSelectedKind] = useState<'directory' | 'file' | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const nextRequestId = requestIdRef.current + 1;
    requestIdRef.current = nextRequestId;
    setIsLoading(true);
    setErrorMessage(null);
    setColumns([]);
    setSelectedPath(null);
    setSelectedKind(null);
    setActiveColumnIndex(0);

    void loadDirectory({
      server,
      directoryPath: initialDirectoryPath,
      mode,
      extensions,
    })
      .then((column) => {
        if (requestIdRef.current !== nextRequestId) {
          return;
        }

        setColumns([column]);
        setActiveColumnIndex(0);

        if (mode === 'directory') {
          setSelectedPath(column.directoryPath);
          setSelectedKind('directory');
        }
      })
      .catch((error) => {
        if (requestIdRef.current !== nextRequestId) {
          return;
        }

        setErrorMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (requestIdRef.current === nextRequestId) {
          setIsLoading(false);
        }
      });
  }, [extensions, initialDirectoryPath, mode, server]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    }

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  async function openDirectoryFromEntry(
    columnIndex: number,
    directoryPath: string,
  ): Promise<void> {
    const nextRequestId = requestIdRef.current + 1;
    requestIdRef.current = nextRequestId;
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const column = await loadDirectory({
        server,
        directoryPath,
        mode,
        extensions,
      });

      if (requestIdRef.current !== nextRequestId) {
        return;
      }

      setColumns((current) => [...current.slice(0, columnIndex + 1), column]);
      setActiveColumnIndex(columnIndex + 1);

      if (mode === 'directory') {
        setSelectedPath(column.directoryPath);
        setSelectedKind('directory');
      } else {
        setSelectedPath(null);
        setSelectedKind(null);
      }
    } catch (error) {
      if (requestIdRef.current !== nextRequestId) {
        return;
      }

      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestIdRef.current === nextRequestId) {
        setIsLoading(false);
      }
    }
  }

  async function openParentDirectory(columnIndex: number): Promise<void> {
    const column = columns[columnIndex];
    const parentDirectoryPath = column?.parentDirectoryPath;

    if (!column || !parentDirectoryPath) {
      return;
    }

    if (columnIndex > 0 && columns[columnIndex - 1]?.directoryPath === parentDirectoryPath) {
      setActiveColumnIndex(columnIndex - 1);

      if (mode === 'directory') {
        setSelectedPath(parentDirectoryPath);
        setSelectedKind('directory');
      }

      return;
    }

    const nextRequestId = requestIdRef.current + 1;
    requestIdRef.current = nextRequestId;
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const parentColumn = await loadDirectory({
        server,
        directoryPath: parentDirectoryPath,
        mode,
        extensions,
      });

      if (requestIdRef.current !== nextRequestId) {
        return;
      }

      setColumns((current) => {
        const next = [...current];
        next.splice(columnIndex, 0, parentColumn);
        return next;
      });
      setActiveColumnIndex(columnIndex);

      if (mode === 'directory') {
        setSelectedPath(parentColumn.directoryPath);
        setSelectedKind('directory');
      }
    } catch (error) {
      if (requestIdRef.current !== nextRequestId) {
        return;
      }

      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestIdRef.current === nextRequestId) {
        setIsLoading(false);
      }
    }
  }

  function handleEntryClick(
    columnIndex: number,
    entry: FileSystemListResponse['entries'][number],
  ): void {
    if (entry.kind === 'directory') {
      void openDirectoryFromEntry(columnIndex, entry.path);
      return;
    }

    setActiveColumnIndex(columnIndex);
    setSelectedPath(entry.path);
    setSelectedKind('file');
    setErrorMessage(null);
  }

  async function submitSelection(): Promise<void> {
    if (!canConfirmSelection || !selectedPath) {
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      await onConfirm(selectedPath);
      onClose();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  const canConfirmSelection =
    !isLoading &&
    !isSubmitting &&
    ((mode === 'directory' && selectedKind === 'directory' && Boolean(selectedPath)) ||
      (mode === 'file' && selectedKind === 'file' && Boolean(selectedPath)));

  const filterSummary =
    mode === 'file' && extensions.length
      ? `Showing ${extensions.join(', ')} files`
      : mode === 'file'
        ? 'Showing all files'
        : 'Showing directories';

  const modal = (
    <div
      className="workspace-modal-backdrop"
      onClick={() => {
        onClose();
      }}
    >
      <section
        className="workspace-modal workspace-modal-file-picker"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="workspace-modal-header">
          <div>
            {subtitle ? <p className="eyebrow">{subtitle}</p> : null}
            <h2>{title}</h2>
          </div>
          <button
            type="button"
            onClick={() => {
              onClose();
            }}
          >
            Cancel
          </button>
        </div>

        <div className="file-picker-meta">
          <span>Server {server}</span>
          <span>{filterSummary}</span>
          <span>{isLoading ? 'Loading...' : 'Ready'}</span>
        </div>

        {errorMessage ? <p className="workspace-modal-error">{errorMessage}</p> : null}

        <div className="file-picker-columns" role="list">
          {columns.map((column, columnIndex) => (
            <section
              key={`${column.directoryPath}:${columnIndex}`}
              className={
                columnIndex === activeColumnIndex
                  ? 'file-picker-column is-active'
                  : 'file-picker-column'
              }
              role="listitem"
              onClick={() => {
                setActiveColumnIndex(columnIndex);

                if (mode === 'directory') {
                  setSelectedPath(column.directoryPath);
                  setSelectedKind('directory');
                }
              }}
            >
              <div className="file-picker-column-header">
                <button
                  type="button"
                  className="file-picker-up-button"
                  onClick={() => {
                    void openParentDirectory(columnIndex);
                  }}
                  disabled={!column.parentDirectoryPath || isLoading || isSubmitting}
                  title={
                    column.parentDirectoryPath
                      ? `Open parent: ${column.parentDirectoryPath}`
                      : 'No parent directory'
                  }
                >
                  ↑
                </button>
                <span title={column.directoryPath}>{column.directoryPath}</span>
              </div>

              <ul className="file-picker-entry-list">
                {column.entries.length ? (
                  column.entries.map((entry) => {
                    const isSelected = selectedPath === entry.path;

                    return (
                      <li key={entry.path}>
                        <button
                          type="button"
                          className={
                            isSelected
                              ? `file-picker-entry is-${entry.kind} is-selected`
                              : `file-picker-entry is-${entry.kind}`
                          }
                          disabled={isLoading || isSubmitting}
                          onClick={() => {
                            handleEntryClick(columnIndex, entry);
                          }}
                          title={entry.path}
                        >
                          <span className="file-picker-entry-kind">{entry.kind}</span>
                          <span className="file-picker-entry-name">{entry.name}</span>
                        </button>
                      </li>
                    );
                  })
                ) : (
                  <li className="file-picker-empty">No entries in this directory.</li>
                )}
              </ul>
            </section>
          ))}
        </div>

        <div className="workspace-modal-actions">
          <p className="file-picker-selection" title={selectedPath ?? undefined}>
            {selectedPath ?? 'No selection'}
          </p>
          <button
            type="button"
            onClick={() => {
              void submitSelection();
            }}
            disabled={!canConfirmSelection}
          >
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );

  if (typeof document === 'undefined') {
    return modal;
  }

  return createPortal(modal, document.body);
}

async function loadDirectory(input: {
  server: string;
  directoryPath: string | undefined;
  mode: 'directory' | 'file';
  extensions: string[];
}): Promise<FileSystemListResponse> {
  const { server, directoryPath, mode, extensions } = input;

  return fetchFileSystemDirectory({
    server,
    directoryPath,
    includeFiles: mode === 'file',
    extensions: mode === 'file' ? extensions : undefined,
  });
}
