import { z } from 'zod';

import { workspaceSchema } from './workspace';

export const WORKSPACE_BASE_UPDATED_AT_HEADER =
  'x-tsheet-workspace-base-updated-at';

export const workspaceConflictResponseSchema = z.object({
  message: z.string(),
  workspace: workspaceSchema,
});

export type WorkspaceConflictResponse = z.infer<
  typeof workspaceConflictResponseSchema
>;
