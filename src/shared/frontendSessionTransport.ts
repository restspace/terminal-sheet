import { z } from 'zod';

export const FRONTEND_ID_HEADER = 'x-tsheet-frontend-id';
export const FRONTEND_LEASE_TOKEN_HEADER = 'x-tsheet-frontend-lease-token';
export const FRONTEND_ID_QUERY_PARAM = 'frontendId';
export const FRONTEND_LEASE_TOKEN_QUERY_PARAM = 'leaseToken';

export const frontendSessionOwnerSchema = z.object({
  frontendId: z.string(),
  ownerLabel: z.string(),
  leaseEpoch: z.number().int().positive(),
  acquiredAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

export const frontendSessionLeaseSchema = frontendSessionOwnerSchema.extend({
  leaseToken: z.string(),
});

export const frontendSessionLockedResponseSchema = z.object({
  message: z.string(),
  owner: frontendSessionOwnerSchema.nullable(),
  canTakeOver: z.boolean(),
});

export const frontendSessionStatusResponseSchema = z.object({
  state: z.enum(['available', 'owned', 'locked']),
  owner: frontendSessionOwnerSchema.nullable(),
});

export const frontendSessionAcquireRequestSchema = z.object({
  frontendId: z.string().trim().min(1),
  ownerLabel: z.string().trim().min(1).max(120),
  leaseToken: z.string().trim().min(1).optional(),
  takeover: z.boolean().optional(),
});

export const frontendSessionRenewRequestSchema = z.object({
  frontendId: z.string().trim().min(1),
  leaseToken: z.string().trim().min(1),
});

export const frontendSessionReleaseRequestSchema = z.object({
  frontendId: z.string().trim().min(1),
  leaseToken: z.string().trim().min(1),
});

export const frontendSessionReleaseResponseSchema = z.object({
  released: z.boolean(),
});

export type FrontendSessionOwner = z.infer<typeof frontendSessionOwnerSchema>;
export type FrontendSessionLease = z.infer<typeof frontendSessionLeaseSchema>;
export type FrontendSessionLockedResponse = z.infer<
  typeof frontendSessionLockedResponseSchema
>;
export type FrontendSessionStatusResponse = z.infer<
  typeof frontendSessionStatusResponseSchema
>;
export type FrontendSessionAcquireRequest = z.infer<
  typeof frontendSessionAcquireRequestSchema
>;
export type FrontendSessionRenewRequest = z.infer<
  typeof frontendSessionRenewRequestSchema
>;
export type FrontendSessionReleaseRequest = z.infer<
  typeof frontendSessionReleaseRequestSchema
>;
