// npm run agreement: our trace vs the answer key
import { colorOf, COLORS, compareWithKey, sampleDisagreements } from '../src/trace/agreement.ts';
import { traceNetwork } from '../src/trace/engine.ts';
import { DRAIN_CLASSES } from '../src/trace/trace.ts';
import { loadAnswerKey, loadInputs } from './lib/inputs.ts';
import { printNetworkStats, table } from './lib/report.ts';

const started = performance.now();
const traced = traceNetwork(loadInputs());
console.log(`Traced ${traced.traces.length} drains in ${Math.round(performance.now() - started)} ms\n`);
printNetworkStats(traced);

const a = compareWithKey(traced.net, traced.traces, loadAnswerKey(), traced.projection);
console.log(`\nAgreement with the answer key (${a.compared} drains compared, ${a.unmatched} unmatched)`);
console.log(`  3 colors (creek / ground / grey): ${(a.colorAgreement * 100).toFixed(1)}%`);
console.log(`  4 classes:                        ${(a.classAgreement * 100).toFixed(1)}%\n`);

console.log('Colors (rows: this trace, columns: answer key)');
table(['', ...COLORS], COLORS.map((o) => [o, ...COLORS.map((k) => a.confusion3[o][k])]));
console.log('\nClasses (rows: this trace, columns: answer key)');
table(['', ...DRAIN_CLASSES], DRAIN_CLASSES.map((o) => [o, ...DRAIN_CLASSES.map((k) => a.confusion4[o][k])]));

// ending code pairs behind the disagreements
const pairs = new Map<string, number>();
for (const r of a.rows) {
  if (colorOf(r.ours) === colorOf(r.key)) continue;
  const k = `${r.oursCode} vs ${r.keyCode}`;
  pairs.set(k, (pairs.get(k) ?? 0) + 1);
}
console.log('\nDisagreements by ending (this trace vs answer key)');
for (const [k, v] of [...pairs.entries()].sort((x, y) => y[1] - x[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);

console.log('\n20 example disagreements');
for (const r of sampleDisagreements(a.rows, 20)) {
  console.log(`- ${r.id}: ours ${r.ours} (${r.oursCode}), key ${r.key} (${r.keyCode})`);
  console.log(`    ours: ${r.oursReason}`);
  console.log(`    key:  ${r.keyFate}`);
  if (r.pastKeyEnding) console.log(`    why:  this trace ${r.pastKeyEnding}`);
}
