// Writes public/data/areas/names.json: every street name in the county areas, and which areas have it.
import { readFileSync, writeFileSync } from 'node:fs';
import type { Bundle } from '../src/data/bundle.ts';

const dir = 'public/data/areas';
const index = JSON.parse(readFileSync(`${dir}/index.json`, 'utf8')) as { id: string }[];
const where = new Map<string, Set<number>>();
index.forEach((a, k) => {
  const b = JSON.parse(readFileSync(`${dir}/${a.id}.json`, 'utf8')) as Bundle;
  // only names that have street runs in this area
  const used = new Set(b.streets.runs.piece);
  b.streets.pieces.forEach((p, i) => {
    if (!p.name || !used.has(i)) return;
    if (!where.has(p.name)) where.set(p.name, new Set());
    where.get(p.name)!.add(k);
  });
});
const names = [...where.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
const out = { areas: index.map((a) => a.id), names: names.map((n) => [n, ...where.get(n)!]) };
writeFileSync(`${dir}/names.json`, JSON.stringify(out));
console.log(`${names.length} street names across ${index.length} areas`);
