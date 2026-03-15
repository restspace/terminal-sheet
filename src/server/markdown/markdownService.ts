import { promises as fs } from 'node:fs';
import { unwatchFile, watchFile } from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';

import type {
  MarkdownConflictChoice,
  MarkdownDocumentState,
  MarkdownLinkState,
} from '../../shared/markdown';
import type { MarkdownNode, Workspace } from '../../shared/workspace';

interface MarkdownRecord {
  node: MarkdownNode;
  absolutePath: string;
  state: MarkdownDocumentState;
  watcher: ((current: import('node:fs').Stats, previous: import('node:fs').Stats) => void) | null;
}

type DocumentListener = (document: MarkdownDocumentState) => void;
type LinkListener = (links: MarkdownLinkState[]) => void;

export class MarkdownService {
  private readonly records = new Map<string, MarkdownRecord>();

  private readonly linksByTerminalId = new Map<string, MarkdownLinkState>();

  private readonly documentListeners = new Set<DocumentListener>();

  private readonly linkListeners = new Set<LinkListener>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly legacyWorkspaceRoot?: string,
  ) {}

  async syncWithWorkspace(workspace: Workspace): Promise<void> {
    const activeNodeIds = new Set(workspace.markdown.map((node) => node.id));

    for (const node of workspace.markdown) {
      await this.syncNode(node);
    }

    for (const [nodeId, record] of this.records) {
      if (activeNodeIds.has(nodeId)) {
        continue;
      }

      this.disposeRecord(record);
      this.records.delete(nodeId);
    }

    let linksChanged = false;
    for (const [terminalId, link] of this.linksByTerminalId) {
      if (activeNodeIds.has(link.markdownNodeId)) {
        continue;
      }

      this.linksByTerminalId.delete(terminalId);
      linksChanged = true;
    }

    if (linksChanged) {
      this.emitLinks();
    }
  }

  close(): void {
    for (const record of this.records.values()) {
      this.disposeRecord(record);
    }

    this.records.clear();
    this.linksByTerminalId.clear();
    this.documentListeners.clear();
    this.linkListeners.clear();
  }

  getDocuments(): MarkdownDocumentState[] {
    return [...this.records.values()].map((record) => record.state);
  }

  getDocument(nodeId: string): MarkdownDocumentState | null {
    return this.records.get(nodeId)?.state ?? null;
  }

  getLinks(): MarkdownLinkState[] {
    return [...this.linksByTerminalId.values()];
  }

  subscribeDocuments(listener: DocumentListener): () => void {
    this.documentListeners.add(listener);

    return () => {
      this.documentListeners.delete(listener);
    };
  }

  subscribeLinks(listener: LinkListener): () => void {
    this.linkListeners.add(listener);

    return () => {
      this.linkListeners.delete(listener);
    };
  }

  async saveDocument(
    nodeId: string,
    content: string,
    externalVersion: string,
  ): Promise<MarkdownDocumentState> {
    const record = this.getRequiredRecord(nodeId);
    const diskState = await this.readFromDisk(record.absolutePath);

    if (record.node.readOnly) {
      const state = {
        ...record.state,
        status: 'error' as const,
        error: 'Document is read-only.',
      };
      this.updateRecordState(record, state);
      return state;
    }

    if (
      (diskState?.externalVersion ?? record.state.externalVersion) !== externalVersion
    ) {
      return this.raiseConflict(record);
    }

    this.updateRecordState(record, {
      ...record.state,
      status: 'saving',
      content,
      dirty: content !== record.state.savedContent,
      error: null,
    });

    await fs.mkdir(dirname(record.absolutePath), { recursive: true });
    await fs.writeFile(record.absolutePath, content, 'utf8');

    return this.reloadRecord(record, {
      nextContent: content,
      nextSavedContent: content,
      forceStatus: 'ready',
    });
  }

  async resolveConflict(
    nodeId: string,
    choice: MarkdownConflictChoice,
    content: string | undefined,
    externalVersion: string,
  ): Promise<MarkdownDocumentState> {
    const record = this.getRequiredRecord(nodeId);

    switch (choice) {
      case 'reload-disk':
        return this.reloadRecord(record, {
          nextContent: null,
          nextSavedContent: null,
          forceStatus: 'ready',
        });
      case 'overwrite-disk':
        return this.saveDocument(nodeId, content ?? record.state.content, externalVersion);
      case 'keep-buffer':
        return record.state;
    }
  }

  queueLink(markdownNodeId: string, terminalId: string): MarkdownLinkState | null {
    if (!this.records.has(markdownNodeId)) {
      return null;
    }

    const nextLink: MarkdownLinkState = {
      markdownNodeId,
      terminalId,
      phase: 'queued',
    };
    this.linksByTerminalId.set(terminalId, nextLink);
    this.emitLinks();
    return nextLink;
  }

  activateQueuedLink(terminalId: string): MarkdownLinkState | null {
    const existing = this.linksByTerminalId.get(terminalId);

    if (!existing || existing.phase === 'active') {
      return existing ?? null;
    }

    const next = {
      ...existing,
      phase: 'active' as const,
    };
    this.linksByTerminalId.set(terminalId, next);
    this.emitLinks();
    return next;
  }

  clearTerminalLink(terminalId: string): boolean {
    const deleted = this.linksByTerminalId.delete(terminalId);

    if (deleted) {
      this.emitLinks();
    }

    return deleted;
  }

  resolvePath(inputPath: string): string {
    return isAbsolute(inputPath)
      ? resolve(inputPath)
      : resolve(this.workspaceRoot, inputPath);
  }

  toWorkspacePath(absolutePath: string): string {
    const relativePath = relative(this.workspaceRoot, absolutePath);

    if (
      relativePath &&
      !relativePath.startsWith('..') &&
      !isAbsolute(relativePath)
    ) {
      return relativePath.startsWith('.')
        ? relativePath
        : `./${relativePath.replaceAll('\\', '/')}`;
    }

    return absolutePath;
  }

  async createEmptyFile(filePath: string): Promise<void> {
    const absolutePath = this.resolvePath(filePath);
    await fs.mkdir(dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, '', {
      encoding: 'utf8',
      flag: 'wx',
    }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    });
  }

  async hasLegacyDocument(filePath: string): Promise<boolean> {
    if (!this.legacyWorkspaceRoot || isAbsolute(filePath)) {
      return false;
    }

    const primaryPath = this.resolvePath(filePath);

    if (await pathExists(primaryPath)) {
      return false;
    }

    const legacyPath = resolve(this.legacyWorkspaceRoot, filePath);
    return pathExists(legacyPath);
  }

  createDefaultFilePath(workspace: Workspace): string {
    const existingPaths = new Set(workspace.markdown.map((node) => node.filePath));

    for (let index = 1; index <= workspace.markdown.length + 2; index += 1) {
      const candidate = `./notes-${index}.md`;

      if (!existingPaths.has(candidate)) {
        return candidate;
      }
    }

    return `./notes-${Date.now()}.md`;
  }

  private async syncNode(node: MarkdownNode): Promise<void> {
    const absolutePath = await this.resolveDocumentPath(node.filePath);
    const existing = this.records.get(node.id);

    if (existing && existing.absolutePath === absolutePath) {
      existing.node = node;

      if (existing.state.readOnly !== node.readOnly) {
        this.updateRecordState(existing, {
          ...existing.state,
          readOnly: node.readOnly,
        });
      }

      if (existing.state.status === 'loading') {
        await this.reloadRecord(existing, {
          nextContent: null,
          nextSavedContent: null,
          forceStatus: 'ready',
        });
      }
      return;
    }

    if (existing) {
      this.disposeRecord(existing);
    }

    const record: MarkdownRecord = {
      node,
      absolutePath,
      state: {
        nodeId: node.id,
        filePath: node.filePath,
        content: '',
        savedContent: '',
        status: 'loading',
        readOnly: node.readOnly,
        externalVersion: '',
        dirty: false,
        error: null,
        conflict: null,
      },
      watcher: null,
    };

    this.records.set(node.id, record);
    this.startWatching(record);
    await this.reloadRecord(record, {
      nextContent: null,
      nextSavedContent: null,
      forceStatus: 'ready',
    });
  }

  private startWatching(record: MarkdownRecord): void {
    const watcher = async () => {
      try {
        await this.handleExternalChange(record);
      } catch {
        // Ignore watcher races; the next explicit reload/save will reconcile state.
      }
    };

    record.watcher = watcher;
    watchFile(record.absolutePath, { interval: 500 }, watcher);
  }

  private disposeRecord(record: MarkdownRecord): void {
    if (record.watcher) {
      unwatchFile(record.absolutePath, record.watcher);
      record.watcher = null;
    }
  }

  private async handleExternalChange(record: MarkdownRecord): Promise<void> {
    const nextContent = await this.readFromDisk(record.absolutePath);

    if (nextContent === null) {
      this.updateRecordState(record, {
        ...record.state,
        status: 'error',
        error: 'Markdown file is unavailable on disk.',
      });
      return;
    }

    const { content, externalVersion } = nextContent;

    if (content === record.state.savedContent) {
      if (record.state.externalVersion !== externalVersion) {
        this.updateRecordState(record, {
          ...record.state,
          externalVersion,
          error: null,
        });
      }
      return;
    }

    if (!record.state.dirty) {
      this.updateRecordState(record, {
        ...record.state,
        content,
        savedContent: content,
        externalVersion,
        status: 'ready',
        dirty: false,
        error: null,
        conflict: null,
      });
      return;
    }

    this.updateRecordState(record, {
      ...record.state,
      status: 'conflict',
      externalVersion,
      error: null,
      conflict: {
        diskContent: content,
        diskVersion: externalVersion,
        detectedAt: new Date().toISOString(),
        message: 'Markdown file changed on disk while you had unsaved edits.',
      },
    });
  }

  private async reloadRecord(
    record: MarkdownRecord,
    options: {
      nextContent: string | null;
      nextSavedContent: string | null;
      forceStatus: 'ready';
    },
  ): Promise<MarkdownDocumentState> {
    const diskState = await this.readFromDisk(record.absolutePath);

    if (diskState === null) {
      const state = {
        ...record.state,
        status: 'error' as const,
        error: 'Markdown file is unavailable on disk.',
        conflict: null,
      };
      this.updateRecordState(record, state);
      return state;
    }

    const state: MarkdownDocumentState = {
      ...record.state,
      filePath: record.node.filePath,
      content: options.nextContent ?? diskState.content,
      savedContent: options.nextSavedContent ?? diskState.content,
      status: options.forceStatus,
      readOnly: record.node.readOnly,
      externalVersion: diskState.externalVersion,
      dirty:
        (options.nextContent ?? diskState.content) !==
        (options.nextSavedContent ?? diskState.content),
      error: null,
      conflict: null,
    };
    this.updateRecordState(record, state);
    return state;
  }

  private async raiseConflict(record: MarkdownRecord): Promise<MarkdownDocumentState> {
    const diskState = await this.readFromDisk(record.absolutePath);
    const conflict = {
      diskContent: diskState?.content ?? '',
      diskVersion: diskState?.externalVersion ?? record.state.externalVersion,
      detectedAt: new Date().toISOString(),
      message: 'Markdown file changed on disk before the save completed.',
    };
    const state: MarkdownDocumentState = {
      ...record.state,
      status: 'conflict',
      externalVersion: conflict.diskVersion,
      error: null,
      conflict,
    };
    this.updateRecordState(record, state);
    return state;
  }

  private async readFromDisk(
    absolutePath: string,
  ): Promise<{ content: string; externalVersion: string } | null> {
    try {
      const [content, stats] = await Promise.all([
        fs.readFile(absolutePath, 'utf8'),
        fs.stat(absolutePath),
      ]);

      return {
        content,
        externalVersion: buildExternalVersion(stats),
      };
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        ((error as NodeJS.ErrnoException).code === 'ENOENT' ||
          (error as NodeJS.ErrnoException).code === 'ENOTDIR')
      ) {
        return null;
      }

      throw error;
    }
  }

  private async resolveDocumentPath(filePath: string): Promise<string> {
    const primaryPath = this.resolvePath(filePath);

    if (!this.legacyWorkspaceRoot || isAbsolute(filePath)) {
      return primaryPath;
    }

    if (await pathExists(primaryPath)) {
      return primaryPath;
    }

    const legacyPath = resolve(this.legacyWorkspaceRoot, filePath);

    if (await pathExists(legacyPath)) {
      return legacyPath;
    }

    return primaryPath;
  }

  private getRequiredRecord(nodeId: string): MarkdownRecord {
    const record = this.records.get(nodeId);

    if (!record) {
      throw new Error(`Markdown node ${nodeId} is not available.`);
    }

    return record;
  }

  private updateRecordState(
    record: MarkdownRecord,
    state: MarkdownDocumentState,
  ): void {
    record.state = state;

    for (const listener of this.documentListeners) {
      listener(state);
    }
  }

  private emitLinks(): void {
    const links = this.getLinks();

    for (const listener of this.linkListeners) {
      listener(links);
    }
  }
}

function buildExternalVersion(stats: import('node:fs').Stats): string {
  return `${stats.mtimeMs}:${stats.size}`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (((error as NodeJS.ErrnoException).code === 'ENOENT') ||
        ((error as NodeJS.ErrnoException).code === 'ENOTDIR'))
    ) {
      return false;
    }

    throw error;
  }
}

export function getMarkdownLabel(filePath: string): string {
  const filename = basename(filePath);
  const stem = extname(filename) ? filename.slice(0, -extname(filename).length) : filename;

  return stem || 'Notes';
}
