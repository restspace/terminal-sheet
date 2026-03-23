import { z } from 'zod';

export const markdownDocumentStatusSchema = z.enum([
  'loading',
  'ready',
  'saving',
  'error',
  'conflict',
]);

export const markdownConflictChoiceSchema = z.enum([
  'reload-disk',
  'overwrite-disk',
  'keep-buffer',
]);

export const markdownLinkPhaseSchema = z.enum(['queued', 'active']);

export const markdownConflictSchema = z.object({
  diskContent: z.string(),
  diskVersion: z.string(),
  detectedAt: z.iso.datetime(),
  message: z.string(),
});

export const markdownDocumentStateSchema = z.object({
  nodeId: z.string(),
  filePath: z.string(),
  content: z.string(),
  savedContent: z.string(),
  status: markdownDocumentStatusSchema,
  readOnly: z.boolean(),
  externalVersion: z.string(),
  dirty: z.boolean(),
  error: z.string().nullable(),
  conflict: markdownConflictSchema.nullable(),
});

export const markdownLinkStateSchema = z.object({
  markdownNodeId: z.string(),
  terminalId: z.string(),
  phase: markdownLinkPhaseSchema,
});

export const markdownCreateRequestSchema = z.object({
  label: z.string().trim().min(1).optional(),
  filePath: z.string().trim().min(1).optional(),
});

export const markdownOpenRequestSchema = z.object({
  filePath: z.string().trim().min(1),
  createIfMissing: z.boolean().optional(),
});

export const markdownSaveRequestSchema = z.object({
  content: z.string(),
  externalVersion: z.string(),
});

export const markdownResolveConflictRequestSchema = z.object({
  choice: markdownConflictChoiceSchema,
  content: z.string().optional(),
  externalVersion: z.string(),
});

export const markdownLinkRequestSchema = z.object({
  markdownNodeId: z.string(),
  terminalId: z.string(),
});

export const markdownDocumentInitMessageSchema = z.object({
  type: z.literal('markdown.init'),
  documents: z.array(markdownDocumentStateSchema),
});

export const markdownDocumentMessageSchema = z.object({
  type: z.literal('markdown.document'),
  document: markdownDocumentStateSchema,
});

export const markdownLinkInitMessageSchema = z.object({
  type: z.literal('markdown.link.init'),
  links: z.array(markdownLinkStateSchema),
});

export const markdownLinkMessageSchema = z.object({
  type: z.literal('markdown.link'),
  links: z.array(markdownLinkStateSchema),
});

export type MarkdownDocumentStatus = z.infer<typeof markdownDocumentStatusSchema>;
export type MarkdownConflictChoice = z.infer<typeof markdownConflictChoiceSchema>;
export type MarkdownConflict = z.infer<typeof markdownConflictSchema>;
export type MarkdownDocumentState = z.infer<typeof markdownDocumentStateSchema>;
export type MarkdownLinkPhase = z.infer<typeof markdownLinkPhaseSchema>;
export type MarkdownLinkState = z.infer<typeof markdownLinkStateSchema>;
export type MarkdownCreateRequest = z.infer<typeof markdownCreateRequestSchema>;
export type MarkdownOpenRequest = z.infer<typeof markdownOpenRequestSchema>;
export type MarkdownSaveRequest = z.infer<typeof markdownSaveRequestSchema>;
export type MarkdownResolveConflictRequest = z.infer<
  typeof markdownResolveConflictRequestSchema
>;
export type MarkdownLinkRequest = z.infer<typeof markdownLinkRequestSchema>;
