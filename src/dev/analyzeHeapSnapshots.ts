import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

interface HeapSnapshotMeta {
  node_fields: string[];
  node_types: Array<Array<string> | string>;
}

interface HeapSnapshotFile {
  snapshot: {
    meta: HeapSnapshotMeta;
    node_count: number;
    edge_count: number;
    extra_native_bytes?: number;
  };
  nodes: number[];
  strings: string[];
}

interface AggregateStat {
  count: number;
  selfSize: number;
}

interface SnapshotSummary {
  filePath: string;
  nodeCount: number;
  edgeCount: number;
  extraNativeBytes: number;
  totalSelfSize: number;
  byType: Map<string, AggregateStat>;
  byTypeAndName: Map<string, AggregateStat>;
}

interface DiffEntry {
  key: string;
  type: string;
  name: string;
  countDelta: number;
  selfSizeDelta: number;
  nextCount: number;
  nextSelfSize: number;
}

async function main(): Promise<void> {
  const inputPaths = process.argv.slice(2);

  if (inputPaths.length < 2) {
    console.error(
      'Usage: npx tsx src/dev/analyzeHeapSnapshots.ts <older.heapsnapshot> <newer.heapsnapshot>',
    );
    process.exitCode = 1;
    return;
  }

  const resolvedPaths = inputPaths.map((filePath) => resolve(filePath));
  const olderPath = resolvedPaths[0];
  const newerPath = resolvedPaths[1];

  if (!olderPath || !newerPath) {
    console.error(
      'Usage: npx tsx src/dev/analyzeHeapSnapshots.ts <older.heapsnapshot> <newer.heapsnapshot>',
    );
    process.exitCode = 1;
    return;
  }

  const olderSummary = await summarizeSnapshot(olderPath);
  const newerSummary = await summarizeSnapshot(newerPath);

  printSnapshotSummary(olderSummary);
  console.log('');
  printSnapshotSummary(newerSummary);
  console.log('');
  printDiffSummary(olderSummary, newerSummary);
}

async function summarizeSnapshot(filePath: string): Promise<SnapshotSummary> {
  const raw = await readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw) as HeapSnapshotFile;
  const nodeFields = parsed.snapshot.meta.node_fields;
  const nodeFieldCount = nodeFields.length;
  const typeFieldIndex = nodeFields.indexOf('type');
  const nameFieldIndex = nodeFields.indexOf('name');
  const selfSizeFieldIndex = nodeFields.indexOf('self_size');

  if (typeFieldIndex === -1 || nameFieldIndex === -1 || selfSizeFieldIndex === -1) {
    throw new Error(`Unsupported heap snapshot schema in ${filePath}`);
  }

  const nodeTypes = parsed.snapshot.meta.node_types[typeFieldIndex];

  if (!Array.isArray(nodeTypes)) {
    throw new Error(`Unexpected node type table in ${filePath}`);
  }

  const byType = new Map<string, AggregateStat>();
  const byTypeAndName = new Map<string, AggregateStat>();
  let totalSelfSize = 0;

  for (let index = 0; index < parsed.nodes.length; index += nodeFieldCount) {
    const typeId = parsed.nodes[index + typeFieldIndex] ?? 0;
    const nameId = parsed.nodes[index + nameFieldIndex] ?? 0;
    const selfSize = parsed.nodes[index + selfSizeFieldIndex] ?? 0;
    const type = nodeTypes[typeId] ?? `unknown:${typeId}`;
    const name = parsed.strings[nameId] ?? `unknown:${nameId}`;

    totalSelfSize += selfSize;
    incrementStat(byType, type, selfSize);
    incrementStat(byTypeAndName, `${type}:${name}`, selfSize);
  }

  return {
    filePath,
    nodeCount: parsed.snapshot.node_count,
    edgeCount: parsed.snapshot.edge_count,
    extraNativeBytes: parsed.snapshot.extra_native_bytes ?? 0,
    totalSelfSize,
    byType,
    byTypeAndName,
  };
}

function incrementStat(
  map: Map<string, AggregateStat>,
  key: string,
  selfSize: number,
): void {
  const current = map.get(key);

  if (current) {
    current.count += 1;
    current.selfSize += selfSize;
    return;
  }

  map.set(key, {
    count: 1,
    selfSize,
  });
}

function printSnapshotSummary(summary: SnapshotSummary): void {
  console.log(`Snapshot: ${basename(summary.filePath)}`);
  console.log(`  Nodes: ${formatInteger(summary.nodeCount)}`);
  console.log(`  Edges: ${formatInteger(summary.edgeCount)}`);
  console.log(`  Total self size: ${formatBytes(summary.totalSelfSize)}`);
  console.log(`  extra_native_bytes: ${formatBytes(summary.extraNativeBytes)}`);
  console.log('  Top node types by self size:');

  for (const [type, stat] of topEntries(summary.byType, 8)) {
    console.log(
      `    ${type.padEnd(18)} ${formatBytes(stat.selfSize).padStart(10)}  ${formatInteger(stat.count).padStart(8)} nodes`,
    );
  }
}

function printDiffSummary(
  older: SnapshotSummary,
  newer: SnapshotSummary,
): void {
  console.log(
    `Diff: ${basename(older.filePath)} -> ${basename(newer.filePath)}`,
  );
  console.log(
    `  Node delta: ${formatSignedInteger(newer.nodeCount - older.nodeCount)}`,
  );
  console.log(
    `  Total self size delta: ${formatSignedBytes(newer.totalSelfSize - older.totalSelfSize)}`,
  );
  console.log(
    `  extra_native_bytes delta: ${formatSignedBytes(
      newer.extraNativeBytes - older.extraNativeBytes,
    )}`,
  );

  const diffEntries = buildDiffEntries(older.byTypeAndName, newer.byTypeAndName);

  console.log('  Top growth by self size:');
  for (const entry of diffEntries
    .filter((candidate) => candidate.selfSizeDelta > 0)
    .slice(0, 20)) {
    console.log(
      `    ${formatTypeAndName(entry).padEnd(56)} ${formatSignedBytes(entry.selfSizeDelta).padStart(10)}  ${formatSignedInteger(entry.countDelta).padStart(8)}`,
    );
  }

  console.log('  Top growth by count:');
  for (const entry of [...diffEntries]
    .filter((candidate) => candidate.countDelta > 0)
    .sort((left, right) => {
      if (right.countDelta !== left.countDelta) {
        return right.countDelta - left.countDelta;
      }

      return right.selfSizeDelta - left.selfSizeDelta;
    })
    .slice(0, 20)) {
    console.log(
      `    ${formatTypeAndName(entry).padEnd(56)} ${formatSignedInteger(entry.countDelta).padStart(8)}  ${formatSignedBytes(entry.selfSizeDelta).padStart(10)}`,
    );
  }

  console.log('  Native-node growth by self size:');
  for (const entry of diffEntries
    .filter(
      (candidate) => candidate.type === 'native' && candidate.selfSizeDelta > 0,
    )
    .slice(0, 20)) {
    console.log(
      `    ${formatTypeAndName(entry).padEnd(56)} ${formatSignedBytes(entry.selfSizeDelta).padStart(10)}  ${formatSignedInteger(entry.countDelta).padStart(8)}`,
    );
  }
}

function buildDiffEntries(
  older: Map<string, AggregateStat>,
  newer: Map<string, AggregateStat>,
): DiffEntry[] {
  const keys = new Set([...older.keys(), ...newer.keys()]);
  const entries: DiffEntry[] = [];

  for (const key of keys) {
    const olderStat = older.get(key);
    const newerStat = newer.get(key);
    const separatorIndex = key.indexOf(':');
    const type = separatorIndex === -1 ? key : key.slice(0, separatorIndex);
    const name = separatorIndex === -1 ? '' : key.slice(separatorIndex + 1);

    entries.push({
      key,
      type,
      name,
      countDelta: (newerStat?.count ?? 0) - (olderStat?.count ?? 0),
      selfSizeDelta: (newerStat?.selfSize ?? 0) - (olderStat?.selfSize ?? 0),
      nextCount: newerStat?.count ?? 0,
      nextSelfSize: newerStat?.selfSize ?? 0,
    });
  }

  return entries.sort((left, right) => {
    if (right.selfSizeDelta !== left.selfSizeDelta) {
      return right.selfSizeDelta - left.selfSizeDelta;
    }

    return right.countDelta - left.countDelta;
  });
}

function topEntries(
  map: Map<string, AggregateStat>,
  limit: number,
): Array<[string, AggregateStat]> {
  return [...map.entries()]
    .sort((left, right) => right[1].selfSize - left[1].selfSize)
    .slice(0, limit);
}

function formatTypeAndName(entry: DiffEntry): string {
  const compactName = entry.name.length > 40
    ? `${entry.name.slice(0, 37)}...`
    : entry.name;

  return `${entry.type}:${compactName}`;
}

function formatBytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let nextValue = value;
  let unitIndex = 0;

  while (Math.abs(nextValue) >= 1024 && unitIndex < units.length - 1) {
    nextValue /= 1024;
    unitIndex += 1;
  }

  return `${nextValue.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function formatSignedBytes(value: number): string {
  return `${value >= 0 ? '+' : ''}${formatBytes(value)}`;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatSignedInteger(value: number): string {
  return `${value >= 0 ? '+' : ''}${formatInteger(value)}`;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
