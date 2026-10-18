// Keeps users/{uid}/drives in step with this phone's drive summaries (never the GPS tracks).
// A full merge on sign-in and on each visit, then a quick check for new or deleted drives. Errors wait and retry; nothing here blocks the app.
import { allSummaries, MAX_SUMMARIES, saveSummary } from '../screens/saved.ts';
import { loadCloud } from './firebase.ts';
import { driveId, fromDoc, localPlan, mergePlan, planEmpty, toDoc, type Known, type Plan } from './merge.ts';

interface State {
  known: Known;
  /** when this phone last synced, ms */
  last: number;
}

export interface SyncView {
  last: number | null;
  busy: boolean;
  /** offline or failed; trying again soon */
  waiting: boolean;
  /** drives in the backup */
  count: number;
}

export interface SyncHooks {
  /** a short note for a toast */
  said(msg: string, ok: boolean): void;
  /** the backup was deleted from another device */
  wiped(): void;
}

const SUMS = 'tt-sums';
/** seconds between retries after a failure */
const RETRY = [5, 15, 60, 180, 600];
const CHECK_MS = 4000;
const stateKey = (uid: string) => `tt-cloud-sync:${uid}`;

let uid: string | null = null;
let hooks: SyncHooks = { said: () => {}, wiped: () => {} };
let busy = false, waiting = false, tries = 0;
let next: 'full' | 'local' | null = null;
let lastRaw: string | null = null;
let retryTimer = 0, checkTimer = 0;
let running: Promise<void> | null = null;
const subs = new Set<() => void>();

function readState(u: string): State {
  try {
    const s = JSON.parse(localStorage.getItem(stateKey(u)) ?? 'null') as State | null;
    if (s && typeof s.known === 'object' && s.known) return { known: s.known, last: Number(s.last) || 0 };
  } catch { /* damaged or blocked */ }
  return { known: {}, last: 0 };
}

function writeState(u: string, s: State): void {
  try { localStorage.setItem(stateKey(u), JSON.stringify(s)); } catch { /* full or blocked: the next sync rebuilds it */ }
}

function clearState(u: string): void {
  try { localStorage.removeItem(stateKey(u)); } catch { /* blocked */ }
}

const raw = (): string | null => { try { return localStorage.getItem(SUMS); } catch { return null; } };

function emit(): void {
  for (const fn of subs) try { fn(); } catch (e) { console.warn(e); }
}

export function onSync(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

/** How the backup stands, for this person (default: the one syncing). */
export function syncView(u: string | null = uid): SyncView {
  const s = u ? readState(u) : null;
  return { last: s?.last || null, busy, waiting, count: s ? Object.keys(s.known).length : 0 };
}

/** Starts syncing for this person. first: they just signed in (says so in a toast). */
export function startSync(u: string, h: SyncHooks, first: boolean): void {
  if (uid !== u) stopSync();
  uid = u;
  hooks = h;
  lastRaw = raw();
  queue(first ? 'signin' : 'full');
  if (!checkTimer) {
    checkTimer = window.setInterval(check, CHECK_MS);
    addEventListener('storage', onStorage);
    addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', check);
  }
}

export function stopSync(): void {
  uid = null;
  next = null;
  waiting = false;
  tries = 0;
  clearTimeout(retryTimer);
  clearInterval(checkTimer);
  checkTimer = 0;
  removeEventListener('storage', onStorage);
  removeEventListener('online', onOnline);
  document.removeEventListener('visibilitychange', check);
  emit();
}

/** Try again now (the sheet's Sync now). */
export function syncNow(): void {
  if (uid) queue('full');
}

const onStorage = (e: StorageEvent) => { if (e.key === SUMS) check(); };
const onOnline = () => { if (waiting) syncNow(); };

/** A drive was saved or deleted since the last look: send just that. */
function check(): void {
  if (!uid || document.hidden) return;
  const r = raw();
  if (r === lastRaw) return;
  lastRaw = r;
  queue('local');
}

let firstToast = false;

function queue(kind: 'signin' | 'full' | 'local'): void {
  if (kind === 'signin') firstToast = true;
  const k = kind === 'local' ? 'local' : 'full';
  next = next === 'full' || k === 'full' ? 'full' : 'local';
  if (!busy) running = pump();
}

async function pump(): Promise<void> {
  busy = true;
  emit();
  while (next && uid) {
    const kind = next, u = uid;
    next = null;
    try {
      await (kind === 'full' ? full(u) : local(u));
      waiting = false;
      tries = 0;
    } catch (e) {
      if (uid !== u) continue;
      console.warn('TireTrail backup will try again:', e);
      waiting = true;
      if (firstToast) { firstToast = false; hooks.said("Signed in. Your backup will finish when you're back online.", false); }
      clearTimeout(retryTimer);
      retryTimer = window.setTimeout(syncNow, RETRY[Math.min(tries++, RETRY.length - 1)] * 1000);
    }
  }
  busy = false;
  emit();
}

async function full(u: string): Promise<void> {
  const c = await loadCloud();
  const [docs, prof] = await Promise.all([c.drives(u), c.profile(u)]);
  if (uid !== u) return;
  const st = readState(u);
  // synced before, but the backup is gone: it was deleted on another device
  if (!prof && Object.keys(st.known).length) {
    clearState(u);
    hooks.wiped();
    return;
  }
  const cloud = docs.flatMap((d) => {
    const x = fromDoc(d.data);
    return x && driveId(x.s.at) === d.id ? [x] : [];
  });
  const now = Date.now();
  const plan = mergePlan(allSummaries(), cloud, st.known, now, MAX_SUMMARIES);
  const got = pull(plan);
  lastRaw = raw();
  await push(c, u, plan, now);
  say(plan, got);
}

async function local(u: string): Promise<void> {
  const st = readState(u), now = Date.now();
  const plan = localPlan(allSummaries(), st.known, now, MAX_SUMMARIES);
  if (planEmpty(plan)) return;
  const c = await loadCloud();
  if (uid !== u) return;
  await push(c, u, plan, now);
  say(plan, 0);
}

/** Saves the downloads here. A drive that didn't fit isn't counted as on this phone. */
function pull(plan: Plan): number {
  if (!plan.download.length) return 0;
  for (const s of plan.download) saveSummary(s);
  const have = new Set(allSummaries().map((s) => driveId(s.at)));
  let got = 0;
  for (const s of plan.download) {
    const id = driveId(s.at);
    if (have.has(id)) got++;
    else delete plan.known[id];
  }
  // progress and spots can redraw with the new drives
  if (got) dispatchEvent(new CustomEvent('tt:drives'));
  return got;
}

async function push(c: Awaited<ReturnType<typeof loadCloud>>, u: string, plan: Plan, now: number): Promise<void> {
  const count = Object.keys(plan.known).length;
  await c.write(u, plan.upload.map((s) => ({ id: driveId(s.at), data: toDoc(s, now) })), plan.remove, { lastSync: now, drives: count });
  if (uid !== u) return;
  writeState(u, { known: plan.known, last: now });
}

function say(plan: Plan, got: number): void {
  const first = firstToast;
  firstToast = false;
  const n = Object.keys(plan.known).length;
  if (got) hooks.said(`Backed up. ${got === 1 ? '1 drive' : `${got} drives`} came back to this phone.`, true);
  else if (first) hooks.said(n ? `Backed up ${n === 1 ? '1 drive' : `${n} drives`}` : 'Signed in. New drives back up as you save them.', true);
  else if (plan.upload.length) hooks.said('Backed up', true);
}

/** Deletes everything under users/{uid}. Throws if it couldn't. */
export async function deleteCloudData(u: string): Promise<void> {
  // nothing may write while it deletes
  stopSync();
  await running;
  const c = await loadCloud();
  await c.wipe(u);
  clearState(u);
}
