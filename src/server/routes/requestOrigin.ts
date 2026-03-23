export function getHomeUrl(request: {
  headers: Record<string, unknown>;
  hostname: string;
}): string {
  const host =
    request.headers['x-forwarded-host'] ?? request.headers.host ?? request.hostname;
  const proto = request.headers['x-forwarded-proto'] ?? 'http';
  return `${String(proto)}://${String(host)}`;
}
