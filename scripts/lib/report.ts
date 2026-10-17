import type { TracedNetwork } from '../../src/trace/engine.ts';
import { DRAIN_CLASSES } from '../../src/trace/trace.ts';

export function table(header: string[], rows: (string | number)[][]): void {
  const cells = [header, ...rows.map((r) => r.map(String))];
  const widths = header.map((_, i) => Math.max(...cells.map((r) => r[i].length)));
  for (const r of cells) console.log('  ' + r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  '));
}

export function printNetworkStats({ net, traces, waters }: TracedNetwork): void {
  const s = net.stats;
  console.log('Network');
  console.log(`  assets: ${s.assets} (${Object.entries(s.assetsByKind).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  console.log(`  drains (catch basins, manholes, inlets): ${s.drains}`);
  console.log(`  links: ${s.links}, of which inferred: ${s.inferredLinks}`);
  console.log(`  links by source: ${Object.entries(s.linksByHow).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`  pipe/ditch ends left blank by the city: from ${s.lineEndsBlank.from}, to ${s.lineEndsBlank.to}; IDs not found: from ${s.lineEndsUnresolved.from}, to ${s.lineEndsUnresolved.to}`);
  console.log(`  lines flipped to match their IDs: ${s.linesFlipped}; bridges refused (would loop): ${s.rejectedLoopBridges}`);
  console.log(`  separate network pieces: ${s.components}; loops: ${s.loops} (${s.assetsInLoops} assets); assets with no way out: ${s.sinks}`);
  console.log(`  skipped (no geometry): ${s.skippedNoGeometry}; repeated IDs: ${s.duplicateIds}`);
  console.log(`  lakes counted in the Fennel system: ${waters.fennelLakes().join(', ') || 'none'}`);
  const byClass = Object.fromEntries(DRAIN_CLASSES.map((c) => [c, traces.filter((t) => t.ending.cls === c).length]));
  console.log(`  drains by class: ${DRAIN_CLASSES.map((c) => `${c} ${byClass[c]}`).join(', ')}`);
  const codes = new Map<string, number>();
  for (const t of traces) codes.set(t.ending.code, (codes.get(t.ending.code) ?? 0) + 1);
  console.log(`  endings: ${[...codes.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
}
