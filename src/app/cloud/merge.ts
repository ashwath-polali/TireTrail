// What to send, fetch and delete when this phone's drive summaries meet the cloud copy. Pure: no network, no storage.
import { readSummary, type DriveSummary } from '../../drive/summary.ts';

/** The last version of each drive both sides agreed on: its hash and when it was written. */
export type Known = Record<string, { h: string; u: number }>;

/** A drive as the cloud holds it. u = when it was written, ms. */
export interface CloudDrive {
  s: DriveSummary;
  u: number;
}

export interface Plan {
  /** send these to the cloud */
  upload: DriveSummary[];
  /** save these on this phone */
  download: DriveSummary[];
  /** delete these drive ids in the cloud */
  remove: string[];
  /** what both sides hold once the plan is done */
  known: Known;
}

export const driveId = (at: number): string => String(at);

/** JSON with keys sorted, so the same summary always reads the same. */
export function stableJson(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(stableJson).join(',')}]`;
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(x) ?? 'null';
}

// FNV-1a, two seeds
function fnv(s: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

export function hashSummary(s: DriveSummary): string {
  const j = stableJson(readSummary(s) ?? s);
  return fnv(j, 0x811c9dc5) + fnv(j, 0x9e3779b9);
}

/** The Firestore document for one drive: the summary (no GPS track) and when it was written. */
export function toDoc(s: DriveSummary, u: number): Record<string, unknown> {
  const clean = readSummary(s) ?? s;
  return { ...JSON.parse(JSON.stringify(clean)) as Record<string, unknown>, updated: u };
}

/** A drive read back from Firestore, or null if it's damaged. */
export function fromDoc(data: unknown): CloudDrive | null {
  const s = readSummary(data);
  if (!s) return null;
  const u = (data as { updated?: unknown }).updated;
  return { s, u: typeof u === 'number' && Number.isFinite(u) ? u : 0 };
}

/** A summary this phone dropped to stay under its cap (the oldest, with the list full), not one the person deleted. */
export function evicted(at: number, local: DriveSummary[], cap: number): boolean {
  return local.length >= cap - 10 && local.every((s) => s.at > at);
}

/** Merges both ways by drive id; when both changed one drive, the newer write wins. now = this write's time. */
export function mergePlan(local: DriveSummary[], cloud: CloudDrive[], known: Known, now: number, cap: number): Plan {
  const here = new Map(local.map((s) => [driveId(s.at), s]));
  const there = new Map(cloud.map((c) => [driveId(c.s.at), c]));
  const upload: DriveSummary[] = [], remove: string[] = [], next: Known = {};
  const pulled: { c: CloudDrive; h: string }[] = [], fresh: { c: CloudDrive; h: string }[] = [];

  for (const [id, s] of here) {
    const h = hashSummary(s), c = there.get(id);
    if (!c) { upload.push(s); next[id] = { h, u: now }; continue; }
    const ch = hashSummary(c.s);
    if (ch === h) { next[id] = { h, u: c.u }; continue; }
    // unchanged here since the last sync: dated then; changed here: dated now
    const k = known[id], mine = k && k.h === h ? k.u : now;
    if (mine > c.u) { upload.push(s); next[id] = { h, u: now }; } else { pulled.push({ c, h: ch }); next[id] = { h: ch, u: c.u }; }
  }

  for (const [id, c] of there) {
    if (here.has(id)) continue;
    if (known[id]) {
      // it was here and synced, so the person deleted it on this phone
      if (!evicted(c.s.at, local, cap)) remove.push(id);
      continue;
    }
    fresh.push({ c, h: hashSummary(c.s) });
  }

  // only what fits under the phone's cap, newest first
  const ats = [...local.map((s) => s.at), ...fresh.map((f) => f.c.s.at)].sort((a, b) => b - a);
  const floor = ats.length > cap ? ats[cap - 1] : -Infinity;
  for (const f of fresh) {
    if (f.c.s.at < floor) continue;
    pulled.push(f);
    next[driveId(f.c.s.at)] = { h: f.h, u: f.c.u };
  }

  return { upload, download: pulled.map((p) => p.c.s), remove, known: next };
}

/** Between full syncs: send new or changed drives, delete removed ones, without reading the cloud. */
export function localPlan(local: DriveSummary[], known: Known, now: number, cap: number): Plan {
  const upload: DriveSummary[] = [], remove: string[] = [], next: Known = {};
  const ids = new Set<string>();
  for (const s of local) {
    const id = driveId(s.at), h = hashSummary(s), k = known[id];
    ids.add(id);
    if (k && k.h === h) next[id] = k;
    else { upload.push(s); next[id] = { h, u: now }; }
  }
  for (const id of Object.keys(known)) {
    if (ids.has(id)) continue;
    if (!evicted(Number(id), local, cap)) remove.push(id);
  }
  return { upload, download: [], remove, known: next };
}

export const planEmpty = (p: Plan): boolean => !p.upload.length && !p.download.length && !p.remove.length;
