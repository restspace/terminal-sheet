import { LOCAL_BACKEND_ID, type BackendConnection } from '../../shared/backends';

export interface BackendAccent {
  label: string;
  color: string;
}

const MACHINE_ACCENT_COLORS = [
  'rgba(99, 149, 210, 0.88)',
  'rgba(80, 178, 140, 0.88)',
  'rgba(210, 145, 70, 0.88)',
  'rgba(178, 95, 165, 0.88)',
  'rgba(70, 178, 178, 0.88)',
  'rgba(200, 170, 60, 0.88)',
  'rgba(165, 100, 70, 0.88)',
  'rgba(120, 165, 75, 0.88)',
] as const;

export function buildBackendAccentsMap(
  backends: readonly BackendConnection[],
): ReadonlyMap<string, BackendAccent> {
  const map = new Map<string, BackendAccent>();

  for (let index = 0; index < backends.length; index += 1) {
    const backend = backends[index];

    if (!backend || backend.id === LOCAL_BACKEND_ID) {
      continue;
    }

    const color = MACHINE_ACCENT_COLORS[
      index % MACHINE_ACCENT_COLORS.length
    ] as string;
    map.set(backend.id, { label: backend.label, color });
  }

  return map;
}
