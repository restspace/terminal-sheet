import type { WorkspaceLayoutMode } from '../../../shared/workspace';
import { focusTilesLayoutStrategy } from './focusTilesLayoutStrategy';
import { freeLayoutStrategy } from './freeLayoutStrategy';
import type { LayoutStrategy } from './types';

const strategyByMode: Record<WorkspaceLayoutMode, LayoutStrategy> = {
  free: freeLayoutStrategy,
  'focus-tiles': focusTilesLayoutStrategy,
};

export function getLayoutStrategy(mode: WorkspaceLayoutMode): LayoutStrategy {
  return strategyByMode[mode];
}
