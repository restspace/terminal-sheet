import { randomUUID } from 'node:crypto';

import {
  type FrontendSessionAcquireRequest,
  type FrontendSessionLease,
  type FrontendSessionLockedResponse,
  type FrontendSessionOwner,
  type FrontendSessionReleaseRequest,
  type FrontendSessionRenewRequest,
  type FrontendSessionStatusResponse,
} from '../../shared/frontendSessionTransport';
import { serializeJsonMessage } from '../../shared/jsonTransport';

interface FrontendLeaseManagerLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
}

interface FrontendLeaseManagerOptions {
  timeoutMs?: number;
  sweepIntervalMs?: number;
  log?: FrontendLeaseManagerLogger;
}

interface LeaseSocket {
  send(data: string): void;
  close(code?: number, data?: string): void;
}

interface InternalLease {
  frontendId: string;
  ownerLabel: string;
  leaseToken: string;
  leaseEpoch: number;
  acquiredAtMs: number;
  lastSeenAtMs: number;
  socket: LeaseSocket | null;
}

interface FrontendLeaseAuth {
  frontendId: string | null;
  leaseToken: string | null;
  leaseEpoch?: number | null;
}

type LeaseSuccessResult = {
  ok: true;
  lease: FrontendSessionLease;
};

type LeaseFailureResult = {
  ok: false;
  locked: FrontendSessionLockedResponse;
};

export class FrontendLeaseManager {
  private readonly timeoutMs: number;
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private readonly log?: FrontendLeaseManagerLogger;
  private activeLease: InternalLease | null = null;
  private nextLeaseEpoch = 0;

  constructor(options: FrontendLeaseManagerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.log = options.log;
    const sweepIntervalMs = options.sweepIntervalMs ?? 1_000;

    this.sweepTimer = setInterval(() => {
      this.expireLeaseIfNeeded();
    }, sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  close(): void {
    clearInterval(this.sweepTimer);

    if (this.activeLease?.socket) {
      this.closeSocket(this.activeLease.socket, 1001, 'Server shutting down.');
    }

    this.activeLease = null;
  }

  getStatus(auth: FrontendLeaseAuth): FrontendSessionStatusResponse {
    const activeLease = this.getActiveLease();

    if (!activeLease) {
      return {
        state: 'available',
        owner: null,
      };
    }

    if (this.isMatchingLease(activeLease, auth)) {
      return {
        state: 'owned',
        owner: this.toOwner(activeLease),
      };
    }

    return {
      state: 'locked',
      owner: this.toOwner(activeLease),
    };
  }

  acquire(
    request: FrontendSessionAcquireRequest,
  ): LeaseSuccessResult | LeaseFailureResult {
    const activeLease = this.getActiveLease();

    if (!activeLease) {
      const lease = this.createLease(request.frontendId, request.ownerLabel);
      this.logInfo('Frontend lease granted', lease, {
        event: 'acquireGranted',
        takeover: false,
      });
      return {
        ok: true,
        lease,
      };
    }

    if (
      activeLease.frontendId === request.frontendId &&
      request.leaseToken === activeLease.leaseToken
    ) {
      activeLease.ownerLabel = request.ownerLabel;
      const lease = this.touchLease(activeLease);
      this.logInfo('Frontend lease refreshed', lease, {
        event: 'acquireRefreshed',
        takeover: false,
      });
      return {
        ok: true,
        lease,
      };
    }

    if (request.takeover) {
      const lease = this.replaceLease(request.frontendId, request.ownerLabel);
      this.logInfo('Frontend lease taken over', lease, {
        event: 'takeoverGranted',
        takeover: true,
      });
      return {
        ok: true,
        lease,
      };
    }

    this.logWarn('Frontend lease acquire rejected', activeLease, {
      event: 'acquireRejected',
      requestedFrontendId: request.frontendId,
      requestedOwnerLabel: request.ownerLabel,
    });
    return {
      ok: false,
      locked: this.buildLockedResponse(activeLease),
    };
  }

  renew(
    request: FrontendSessionRenewRequest | FrontendLeaseAuth,
  ): LeaseSuccessResult | LeaseFailureResult {
    return this.refreshLease(request, 'renew');
  }

  validate(auth: FrontendLeaseAuth): LeaseSuccessResult | LeaseFailureResult {
    return this.refreshLease(auth, 'validate');
  }

  release(
    request: FrontendSessionReleaseRequest | FrontendLeaseAuth,
  ): boolean {
    const activeLease = this.getActiveLease();

    if (!activeLease || !this.isMatchingLease(activeLease, request)) {
      this.logWarn('Frontend lease release rejected', activeLease, {
        event: 'releaseRejected',
        requestedFrontendId: request.frontendId,
        requestedLeaseEpoch: readRequestedLeaseEpoch(request),
      });
      return false;
    }

    if (activeLease.socket) {
      this.closeSocket(activeLease.socket, 1000, 'Frontend lease released.');
    }

    this.logInfo('Frontend lease released', activeLease, {
      event: 'releaseGranted',
    });
    this.activeLease = null;
    return true;
  }

  attachWorkspaceSocket(
    auth: FrontendLeaseAuth,
    socket: LeaseSocket,
  ): LeaseSuccessResult | LeaseFailureResult {
    const validation = this.validate(auth);

    if (!validation.ok) {
      this.logWarn('Workspace socket attach rejected', this.activeLease, {
        event: 'socketAttachRejected',
        requestedFrontendId: auth.frontendId,
        requestedLeaseEpoch: auth.leaseEpoch ?? null,
      });
      return validation;
    }

    const activeLease = this.activeLease;

    if (!activeLease) {
      return {
        ok: false,
        locked: this.buildLockedResponse(null),
      };
    }

    const previousSocket = activeLease.socket;
    activeLease.socket = socket;

    if (previousSocket && previousSocket !== socket) {
      this.logInfo(
        'Workspace socket replaced by a newer connection',
        activeLease,
        {
          event: 'socketReplaced',
        },
      );
      this.closeSocket(
        previousSocket,
        4000,
        'Workspace socket replaced by a newer connection.',
      );
    }

    return {
      ok: true,
      lease: this.toLease(activeLease),
    };
  }

  detachWorkspaceSocket(socket: LeaseSocket): void {
    const activeLease = this.getActiveLease();

    if (!activeLease || activeLease.socket !== socket) {
      return;
    }

    activeLease.socket = null;
  }

  private getActiveLease(): InternalLease | null {
    this.expireLeaseIfNeeded();
    return this.activeLease;
  }

  private expireLeaseIfNeeded(): void {
    const activeLease = this.activeLease;

    if (!activeLease) {
      return;
    }

    if (Date.now() - activeLease.lastSeenAtMs < this.timeoutMs) {
      return;
    }

    if (activeLease.socket) {
      this.closeSocket(activeLease.socket, 4001, 'Frontend lease expired.');
    }

    this.logInfo('Frontend lease expired', activeLease, {
      event: 'expired',
    });
    this.activeLease = null;
  }

  private createLease(
    frontendId: string,
    ownerLabel: string,
  ): FrontendSessionLease {
    const lease: InternalLease = {
      frontendId,
      ownerLabel,
      leaseToken: randomUUID(),
      leaseEpoch: this.nextLeaseEpoch + 1,
      acquiredAtMs: Date.now(),
      lastSeenAtMs: Date.now(),
      socket: null,
    };

    this.nextLeaseEpoch = lease.leaseEpoch;
    this.activeLease = lease;
    return this.toLease(lease);
  }

  private replaceLease(
    frontendId: string,
    ownerLabel: string,
  ): FrontendSessionLease {
    const previousLease = this.activeLease;
    const nextLease = this.createLease(frontendId, ownerLabel);

    if (previousLease?.socket) {
      this.sendSocketMessage(previousLease.socket, {
        type: 'frontend.locked',
        lock: this.buildLockedResponse(this.activeLease),
      });
      this.closeSocket(
        previousLease.socket,
        4002,
        'Frontend lease taken over by another browser.',
      );
    }

    return nextLease;
  }

  private touchLease(lease: InternalLease): FrontendSessionLease {
    lease.lastSeenAtMs = Date.now();
    return this.toLease(lease);
  }

  private isMatchingLease(
    lease: InternalLease,
    auth: FrontendLeaseAuth,
  ): boolean {
    return (
      typeof auth.frontendId === 'string' &&
      typeof auth.leaseToken === 'string' &&
      auth.frontendId === lease.frontendId &&
      auth.leaseToken === lease.leaseToken &&
      (auth.leaseEpoch === undefined ||
        auth.leaseEpoch === null ||
        auth.leaseEpoch === lease.leaseEpoch)
    );
  }

  private toLease(lease: InternalLease): FrontendSessionLease {
    return {
      ...this.toOwner(lease),
      leaseToken: lease.leaseToken,
    };
  }

  private toOwner(lease: InternalLease): FrontendSessionOwner {
    return {
      frontendId: lease.frontendId,
      ownerLabel: lease.ownerLabel,
      leaseEpoch: lease.leaseEpoch,
      acquiredAt: new Date(lease.acquiredAtMs).toISOString(),
      lastSeenAt: new Date(lease.lastSeenAtMs).toISOString(),
      expiresAt: new Date(lease.lastSeenAtMs + this.timeoutMs).toISOString(),
    };
  }

  private buildLockedResponse(
    lease: InternalLease | null,
  ): FrontendSessionLockedResponse {
    return {
      message: lease
        ? 'Frontend lease is currently held by another browser.'
        : 'Workspace control is no longer active. Refresh or retry to reacquire it.',
      owner: lease ? this.toOwner(lease) : null,
      canTakeOver: lease !== null,
    };
  }

  private refreshLease(
    request: FrontendSessionRenewRequest | FrontendLeaseAuth,
    mode: 'renew' | 'validate',
  ): LeaseSuccessResult | LeaseFailureResult {
    const activeLease = this.getActiveLease();

    if (!activeLease) {
      this.logWarn('Frontend lease validation rejected', null, {
        event: `${mode}Rejected`,
        requestedFrontendId: request.frontendId,
        requestedLeaseEpoch: readRequestedLeaseEpoch(request),
      });
      return {
        ok: false,
        locked: this.buildLockedResponse(null),
      };
    }

    if (!this.isMatchingLease(activeLease, request)) {
      this.logWarn('Frontend lease validation rejected', activeLease, {
        event: `${mode}Rejected`,
        requestedFrontendId: request.frontendId,
        requestedLeaseEpoch: readRequestedLeaseEpoch(request),
      });
      return {
        ok: false,
        locked: this.buildLockedResponse(activeLease),
      };
    }

    const lease = this.touchLease(activeLease);

    if (mode === 'renew') {
      this.logInfo('Frontend lease renewed', lease, {
        event: 'renewGranted',
      });
    }

    return {
      ok: true,
      lease,
    };
  }

  private sendSocketMessage(socket: LeaseSocket, payload: unknown): void {
    try {
      socket.send(serializeJsonMessage(payload));
    } catch {
      // Ignore shutdown races while notifying the previous socket.
    }
  }

  private closeSocket(
    socket: LeaseSocket,
    code: number,
    reason: string,
  ): void {
    try {
      socket.close(code, reason);
    } catch {
      // Ignore shutdown races while closing sockets.
    }
  }

  private logInfo(
    message: string,
    lease: Pick<InternalLease, 'frontendId' | 'ownerLabel' | 'leaseEpoch'> | null,
    extra: Record<string, unknown>,
  ): void {
    this.log?.info(this.toLogBindings(lease, extra), message);
  }

  private logWarn(
    message: string,
    lease: Pick<InternalLease, 'frontendId' | 'ownerLabel' | 'leaseEpoch'> | null,
    extra: Record<string, unknown>,
  ): void {
    this.log?.warn(this.toLogBindings(lease, extra), message);
  }

  private toLogBindings(
    lease: Pick<InternalLease, 'frontendId' | 'ownerLabel' | 'leaseEpoch'> | null,
    extra: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      frontendId: lease?.frontendId ?? null,
      ownerLabel: lease?.ownerLabel ?? null,
      leaseEpoch: lease?.leaseEpoch ?? null,
      ...extra,
    };
  }
}

function readRequestedLeaseEpoch(
  request:
    | FrontendSessionReleaseRequest
    | FrontendSessionRenewRequest
    | FrontendLeaseAuth,
): number | null {
  return 'leaseEpoch' in request && typeof request.leaseEpoch === 'number'
    ? request.leaseEpoch
    : null;
}
