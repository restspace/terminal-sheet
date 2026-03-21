import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import path from 'node:path';

interface TraceEvent {
  pid?: number;
  tid?: number;
  ts?: number;
  ph?: string;
  name?: string;
  dur?: number;
  cat?: string;
  args?: Record<string, unknown>;
}

interface TracePayload {
  traceEvents?: TraceEvent[];
}

function main(): void {
  const inputPath = process.argv[2];

  if (!inputPath) {
    console.error(
      'Usage: npx tsx src/dev/analyzePerformanceTrace.ts <trace.json|trace.json.gz>',
    );
    process.exitCode = 1;
    return;
  }

  const payload = parseTrace(inputPath);
  const events = payload.traceEvents ?? [];
  const rendererThreadKeys = getRendererThreadKeys(events);

  console.log(`Trace: ${path.resolve(inputPath)}`);
  console.log(`Events: ${events.length.toLocaleString()}`);
  console.log(
    `Renderer threads: ${
      rendererThreadKeys.length ? rendererThreadKeys.join(', ') : 'none found'
    }`,
  );
  console.log('');

  printSection(
    'Top Renderer Durations',
    summarizeDurations(
      events.filter((event) => isRendererEvent(event, rendererThreadKeys)),
      20,
    ),
  );
  printSection(
    'Top Function Calls',
    summarizeFunctionCalls(
      events.filter(
        (event) =>
          isRendererEvent(event, rendererThreadKeys) &&
          event.name === 'FunctionCall' &&
          event.ph === 'X',
      ),
      20,
    ),
  );
  printSection(
    'Animation Frame Sources',
    summarizeAnimationFrameScripts(
      events.filter(
        (event) =>
          isRendererEvent(event, rendererThreadKeys) &&
          event.name === 'AnimationFrame::Script::Execute',
      ),
      20,
    ),
  );
  printSection(
    'Layout Roots',
    summarizeLayoutRoots(
      events.filter(
        (event) =>
          isRendererEvent(event, rendererThreadKeys) && event.name === 'Layout',
      ),
      20,
    ),
  );
  printSection(
    'Timeline Counts',
    summarizeCounts(
      events.filter(
        (event) =>
          isRendererEvent(event, rendererThreadKeys) &&
          typeof event.name === 'string' &&
          (event.cat ?? '').includes('devtools.timeline'),
      ),
      30,
    ),
  );
}

function parseTrace(inputPath: string): TracePayload {
  const buffer = readFileSync(inputPath);
  const json =
    inputPath.endsWith('.gz') ? gunzipSync(buffer).toString('utf8') : buffer.toString('utf8');

  return JSON.parse(json) as TracePayload;
}

function getRendererThreadKeys(events: TraceEvent[]): string[] {
  const threadNames = new Map<string, string>();

  for (const event of events) {
    if (event.ph !== 'M' || event.name !== 'thread_name') {
      continue;
    }

    const name = getString(event.args, 'name');

    if (!name || event.pid === undefined || event.tid === undefined) {
      continue;
    }

    threadNames.set(`${event.pid}:${event.tid}`, name);
  }

  return [...threadNames.entries()]
    .filter(([, name]) => /CrRendererMain/i.test(name))
    .map(([key]) => key);
}

function isRendererEvent(event: TraceEvent, rendererThreadKeys: string[]): boolean {
  return rendererThreadKeys.includes(`${event.pid}:${event.tid}`);
}

function summarizeDurations(
  events: TraceEvent[],
  limit: number,
): Array<[string, string]> {
  const totals = new Map<string, number>();

  for (const event of events) {
    if (event.ph !== 'X' || typeof event.name !== 'string') {
      continue;
    }

    totals.set(event.name, (totals.get(event.name) ?? 0) + (event.dur ?? 0));
  }

  return [...totals.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([name, duration]) => [name, formatDuration(duration)]);
}

function summarizeFunctionCalls(
  events: TraceEvent[],
  limit: number,
): Array<[string, string]> {
  const totals = new Map<string, number>();

  for (const event of events) {
    const data = getRecord(event.args, 'data');
    const url = getString(data, 'url');

    if (!url) {
      continue;
    }

    const lineNumber = getNumber(data, 'lineNumber');
    const columnNumber = getNumber(data, 'columnNumber');
    const key = `${url}:${lineNumber}:${columnNumber}`;

    totals.set(key, (totals.get(key) ?? 0) + (event.dur ?? 0));
  }

  return [...totals.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([location, duration]) => [location, formatDuration(duration)]);
}

function summarizeAnimationFrameScripts(
  events: TraceEvent[],
  limit: number,
): Array<[string, string]> {
  const counts = new Map<string, number>();

  for (const event of events) {
    const info = getRecord(event.args, 'animation_frame_script_timing_info');
    const url = getString(info, 'source_location_url');

    if (!url) {
      continue;
    }

    const functionName = getString(info, 'source_location_function_name') ?? '<anon>';
    const property = getString(info, 'property_like_name') ?? '';
    const key = `${url}:${functionName}:${property}`;

    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([source, count]) => [source, count.toLocaleString()]);
}

function summarizeLayoutRoots(
  events: TraceEvent[],
  limit: number,
): Array<[string, string]> {
  const counts = new Map<string, number>();

  for (const event of events) {
    const endData = getRecord(event.args, 'endData');
    const layoutRoots = Array.isArray(endData?.layoutRoots)
      ? endData.layoutRoots
      : [];

    for (const candidate of layoutRoots) {
      if (!candidate || typeof candidate !== 'object') {
        continue;
      }

      const nodeName = getString(candidate as Record<string, unknown>, 'nodeName');

      if (!nodeName) {
        continue;
      }

      counts.set(nodeName, (counts.get(nodeName) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([root, count]) => [root, count.toLocaleString()]);
}

function summarizeCounts(
  events: TraceEvent[],
  limit: number,
): Array<[string, string]> {
  const counts = new Map<string, number>();

  for (const event of events) {
    if (typeof event.name !== 'string') {
      continue;
    }

    counts.set(event.name, (counts.get(event.name) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([name, count]) => [name, count.toLocaleString()]);
}

function printSection(title: string, rows: Array<[string, string]>): void {
  console.log(`${title}:`);

  if (!rows.length) {
    console.log('  (none)');
    console.log('');
    return;
  }

  for (const [label, value] of rows) {
    console.log(`  ${value.padStart(10)}  ${label}`);
  }

  console.log('');
}

function formatDuration(durationUs: number): string {
  return `${(durationUs / 1000).toFixed(2)}ms`;
}

function getRecord(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const candidate = value?.[key];
  return candidate && typeof candidate === 'object'
    ? (candidate as Record<string, unknown>)
    : undefined;
}

function getString(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

function getNumber(
  value: Record<string, unknown> | undefined,
  key: string,
): number {
  const candidate = value?.[key];
  return typeof candidate === 'number' ? candidate : -1;
}

main();
