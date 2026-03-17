import { z } from 'zod';

import { LOCAL_BACKEND_ID } from './backends';

export const filesystemEntryKindSchema = z.enum(['directory', 'file']);

export const filesystemEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: filesystemEntryKindSchema,
});

export const filesystemListRequestSchema = z.object({
  server: z.string().trim().min(1).default(LOCAL_BACKEND_ID),
  directoryPath: z.string().trim().min(1).optional(),
  includeFiles: z.boolean().default(true),
  extensions: z.array(z.string().trim().min(1)).max(64).optional(),
});

export const filesystemListResponseSchema = z.object({
  server: z.string().trim().min(1),
  directoryPath: z.string(),
  parentDirectoryPath: z.string().nullable(),
  entries: z.array(filesystemEntrySchema),
});

export type FileSystemEntryKind = z.infer<typeof filesystemEntryKindSchema>;
export type FileSystemEntry = z.infer<typeof filesystemEntrySchema>;
export type FileSystemListRequest = z.infer<typeof filesystemListRequestSchema>;
export type FileSystemListResponse = z.infer<typeof filesystemListResponseSchema>;
