import type {
  CameraViewport,
  WorkspaceLayoutMode,
} from '../../../shared/workspace';

export interface NodeBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasLayoutNode {
  id: string;
  bounds: NodeBounds;
  order: number;
}

export interface LayoutViewportSize {
  width: number;
  height: number;
}

export interface LayoutSafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface LayoutInteractionPolicy {
  nodesDraggable: boolean;
  nodesResizable: boolean;
}

export interface LayoutAnimation {
  key: string;
  durationMs: number;
}

export interface LayoutStrategyInput {
  mode: WorkspaceLayoutMode;
  nodes: readonly CanvasLayoutNode[];
  selectedNodeId: string | null;
  interactionAtByNodeId: Readonly<Record<string, number>>;
  viewport: CameraViewport;
  viewportSize: LayoutViewportSize;
  safeAreaInsets: LayoutSafeAreaInsets;
  previousState: unknown;
  previousMode: WorkspaceLayoutMode | null;
}

export interface LayoutStrategyOutput {
  boundsByNodeId: Map<string, NodeBounds>;
  interactionPolicy: LayoutInteractionPolicy;
  nextState: unknown;
  animation: LayoutAnimation | null;
}

export interface LayoutStrategy {
  mode: WorkspaceLayoutMode;
  compute: (input: LayoutStrategyInput) => LayoutStrategyOutput;
}
