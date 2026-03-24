import {
  FRONTEND_ID_HEADER,
  FRONTEND_ID_QUERY_PARAM,
  FRONTEND_LEASE_TOKEN_HEADER,
  FRONTEND_LEASE_TOKEN_QUERY_PARAM,
} from '../../shared/frontendSessionTransport';

export interface FrontendLeaseAuth {
  frontendId: string | null;
  leaseToken: string | null;
}

export function readFrontendLeaseAuth(request: {
  headers: Record<string, unknown>;
  query?: unknown;
}): FrontendLeaseAuth {
  const frontendId = readStringValue(
    request.headers[FRONTEND_ID_HEADER],
    request.query,
    FRONTEND_ID_QUERY_PARAM,
  );
  const leaseToken = readStringValue(
    request.headers[FRONTEND_LEASE_TOKEN_HEADER],
    request.query,
    FRONTEND_LEASE_TOKEN_QUERY_PARAM,
  );

  return {
    frontendId,
    leaseToken,
  };
}

function readStringValue(
  headerValue: unknown,
  query: unknown,
  queryParam: string,
): string | null {
  if (typeof headerValue === 'string' && headerValue.trim()) {
    return headerValue.trim();
  }

  if (
    Array.isArray(headerValue) &&
    typeof headerValue[0] === 'string' &&
    headerValue[0].trim()
  ) {
    return headerValue[0].trim();
  }

  if (
    query &&
    typeof query === 'object' &&
    queryParam in query &&
    typeof (query as Record<string, unknown>)[queryParam] === 'string'
  ) {
    const queryValue = String((query as Record<string, unknown>)[queryParam]).trim();
    return queryValue || null;
  }

  return null;
}
