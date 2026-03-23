import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Workspace } from '../../shared/workspace';

interface CanvasUiState {
  selectedNodeId: string | null;
  setSelectedNodeId: (nodeId: string | null) => void;
  focusAutoFocusAtMs: number | null;
  setFocusAutoFocusAtMs: (value: number | null) => void;
  nodeInteractionAtMs: Readonly<Record<string, number>>;
  bumpNodeInteraction: (nodeId: string, throttleMs?: number) => void;
  clearNodeInteraction: (nodeId: string) => void;
  isSelectionHydrated: boolean;
}

export function useCanvasUiState(workspace: Workspace | null): CanvasUiState {
  const [selectedNodeId, setSelectedNodeIdState] = useState<string | null>(null);
  const [focusAutoFocusAtMs, setFocusAutoFocusAtMs] = useState<number | null>(
    null,
  );
  const [nodeInteractionAtMs, setNodeInteractionAtMs] = useState<
    Record<string, number>
  >({});
  const [isSelectionHydrated, setIsSelectionHydrated] = useState(false);
  const hydratedWorkspaceIdentityRef = useRef<string | null>(null);
  const validNodeIds = useMemo(() => {
    if (!workspace) {
      return new Set<string>();
    }

    return new Set(
      [...workspace.terminals, ...workspace.markdown].map((node) => node.id),
    );
  }, [workspace]);

  useEffect(() => {
    if (!workspace) {
      hydratedWorkspaceIdentityRef.current = null;
      setSelectedNodeIdState(null);
      setFocusAutoFocusAtMs(null);
      setNodeInteractionAtMs({});
      setIsSelectionHydrated(false);
      return;
    }

    const workspaceIdentity = `${workspace.id}:${workspace.createdAt}`;
    const isFirstHydration =
      hydratedWorkspaceIdentityRef.current !== workspaceIdentity;

    if (isFirstHydration) {
      hydratedWorkspaceIdentityRef.current = workspaceIdentity;
      setSelectedNodeIdState(null);
      setFocusAutoFocusAtMs(null);
      setNodeInteractionAtMs({});
      setIsSelectionHydrated(true);
      return;
    }

    setSelectedNodeIdState((current) =>
      normalizeSelectedNodeId(current, validNodeIds),
    );
    setNodeInteractionAtMs((current) => pruneInteractionState(current, validNodeIds));
    setIsSelectionHydrated(true);
  }, [validNodeIds, workspace]);

  const setSelectedNodeId = useCallback(
    (nodeId: string | null) => {
      setSelectedNodeIdState(normalizeSelectedNodeId(nodeId, validNodeIds));
    },
    [validNodeIds],
  );

  const bumpNodeInteraction = useCallback((nodeId: string, throttleMs = 0) => {
    const now = Date.now();

    setNodeInteractionAtMs((current) => {
      const previous = current[nodeId] ?? Number.NEGATIVE_INFINITY;

      if (now - previous < throttleMs) {
        return current;
      }

      return {
        ...current,
        [nodeId]: now,
      };
    });
  }, []);

  const clearNodeInteraction = useCallback((nodeId: string) => {
    setNodeInteractionAtMs((current) => {
      if (!(nodeId in current)) {
        return current;
      }

      const next = { ...current };
      delete next[nodeId];
      return next;
    });
  }, []);

  return {
    selectedNodeId,
    setSelectedNodeId,
    focusAutoFocusAtMs,
    setFocusAutoFocusAtMs,
    nodeInteractionAtMs,
    bumpNodeInteraction,
    clearNodeInteraction,
    isSelectionHydrated,
  };
}

function normalizeSelectedNodeId(
  selectedNodeId: string | null | undefined,
  validNodeIds: ReadonlySet<string>,
): string | null {
  return selectedNodeId && validNodeIds.has(selectedNodeId)
    ? selectedNodeId
    : null;
}

function pruneInteractionState(
  interactionAtByNodeId: Record<string, number>,
  validNodeIds: ReadonlySet<string>,
): Record<string, number> {
  let changed = false;
  const next: Record<string, number> = {};

  for (const [nodeId, interactionAtMs] of Object.entries(interactionAtByNodeId)) {
    if (!validNodeIds.has(nodeId)) {
      changed = true;
      continue;
    }

    next[nodeId] = interactionAtMs;
  }

  return changed ? next : interactionAtByNodeId;
}
