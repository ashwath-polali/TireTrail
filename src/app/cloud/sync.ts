// Keeps users/{uid}/drives in step with this phone's drive summaries, and users/{uid}/tracks with its routes (trimmed, see track.ts).
// A full merge on sign-in, on each visit and on coming back to the app, then a quick check for new or deleted drives.
// While the app is open it looks at the backup every few seconds (one read), so a drive ended on the phone shows up on the laptop.
// A new drive's route goes up before its summary, so no device sees one without the other; the newest routes load here on their own.
// Errors wait and retry; nothing here blocks the app.
// The car picked in What do you drive? rides along in the profile (car.ts).
import { forgetLog } from '../screens/drive-log.ts';
import { allSummaries, forgetDrive, keepFetched, MAX_SUMMARIES, pack, saveSummary, savedDrives, trackOf, unpack } from '../screens/saved.ts';
import { wasSignedIn } from './auth.ts';
import { CAR_EVENT, carFields, carPlan, cloudCar, keepCar, localCar } from './car.ts';
import { loadCloud } from './firebase.ts';
import { driveId, fromDoc, localPlan, mergePlan, planEmpty, toDoc, type Known, type Plan } from './merge.ts';
import { readTrack, trackDoc } from './track.ts';

interface State {
  known: Known;
  /** when this phone last synced, ms */
  last: number;
  /** drive ids whose route is in the backup, as last seen */
  tracks: string[];
  /** the backup's lastSync when this device last read or wrote it */
  seen?: number;
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
/** how often an open app looks for drives saved on another device */
export const POLL_MS = 10_000;
/** routes fetched on their own after a sync, newest drives first (saved.ts keeps 8) */
const PREFETCH = 6;
/** how long opening a drive waits for sign-in to finish */
const SIGNIN_WAIT_MS = 8000;
/** coming back to the app after this long reads the cloud again, for drives from other devices */
const AGAIN_MS = 60_000;
const stateKey = (uid: string) => `tt-cloud-sync:${uid}`;

let uid: string | null = null;
let hooks: SyncHooks = { said: () => {}, wiped: () => {} };
let busy = false, waiting = false, tries = 0;
let next: 'full' | 'local' | null = null;
let lastRaw: string | null = null;
let lastFull = 0;
let retryTimer = 0, checkTimer = 0, pollTimer = 0, polling = false;
/** routes the backup lists but doesn't hold: not offered again this visit */
const gone = new Set<string>();
/** taps waiting for sign-in to finish */
const waiters = new Set<() => void>();
let running: Promise<void> | null = null;
const subs = new Set<() => void>();

function readState(u: string): State {
  try {
    const s = JSON.parse(localStorage.getItem(stateKey(u)) ?? 'null') as State | null;
    if (s && typeof s.known === 'object' && s.known) {
      return { known: s.known, last: Number(s.last) || 0, tracks: Array.isArray(s.tracks) ? s.tracks.filter((x) => typeof x === 'string') : [], seen: Number(s.seen) || 0 };
    }
  } catch { /* damaged or blocked */ }
  return { known: {}, last: 0, tracks: [] };
}

function writeState(u: string, s: State): void {
  try { localStorage.setItem(stateKey(u), JSON.stringify(s)); } catch { /* full or blocked: the next sync rebuilds it */ }
}

function clearState(u: string): void {
  try { localStorage.removeItem(stateKey(u)); } catch { /* blocked */ }
}

const raw = (): string | null => { try { return localStorage.getItem(SUMS); } catch { return null; } };
const listed = (x: unknown): string[] => (Array.isArray(x) ? x.filter((i): i is string => typeof i === 'string') : []);

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
  for (const w of [...waiters]) w();
  if (!checkTimer) {
    checkTimer = window.setInterval(check, CHECK_MS);
    pollTimer = window.setInterval(() => void checkBackup(), POLL_MS);
    addEventListener('storage', onStorage);
    addEventListener('online', onOnline);
    addEventListener(CAR_EVENT, syncNow);
    document.addEventListener('visibilitychange', onVisible);
  }
}

export function stopSync(): void {
  uid = null;
  next = null;
  waiting = false;
  tries = 0;
  lastFull = 0;
  clearTimeout(retryTimer);
  clearInterval(checkTimer);
  clearInterval(pollTimer);
  checkTimer = pollTimer = 0;
  gone.clear();
  removeEventListener('storage', onStorage);
  removeEventListener('online', onOnline);
  removeEventListener(CAR_EVENT, syncNow);
  document.removeEventListener('visibilitychange', onVisible);
  emit();
}

/** Try again now (the sheet's Sync now). */
export function syncNow(): void {
  if (uid) queue('full');
}

const onStorage = (e: StorageEvent) => { if (e.key === SUMS) check(); };
const onOnline = () => { if (waiting) syncNow(); };
// back from another app or tab: drives saved on another device may be waiting
const onVisible = () => {
  if (document.hidden || !uid) return;
  if (!busy && Date.now() - lastFull > AGAIN_MS) syncNow();
  else { check(); void checkBackup(); }
};

/** The backup moved on since this device last looked: another device saved, deleted or sent a route. Pure. */
export function backupChanged(st: Pick<State, 'known' | 'tracks' | 'seen'>, prof: Record<string, unknown> | null): boolean {
  if (!prof) return Object.keys(st.known).length > 0;
  const t = listed(prof.tracks);
  return (Number(prof.lastSync) || 0) !== (st.seen ?? 0) || t.length !== st.tracks.length || t.some((id) => !st.tracks.includes(id));
}

/** One read of the profile; a full sync when the backup changed. The timer calls it; so do tests. */
export async function checkBackup(): Promise<void> {
  const u = uid;
  if (!u || document.hidden || busy || polling) return;
  polling = true;
  try {
    const prof = await (await loadCloud()).profile(u);
    if (uid === u && !busy && (waiting || backupChanged(readState(u), prof))) syncNow();
  } catch { /* offline: the next look tries again */ } finally { polling = false; }
}

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

type Cloud = Awaited<ReturnType<typeof loadCloud>>;


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
  const plan = mergePlan(allSummaries(), cloud, st.known, now, MAX_SUMMARIES, new Set(docs.map((d) => d.id)));
  // which routes My drives can open, before it redraws
  const off = new Set([...plan.remove, ...plan.forget]), tracks = listed(prof?.tracks).filter((id) => !off.has(id));
  const more = tracks.some((id) => !st.tracks.includes(id));
  writeState(u, { ...st, tracks });
  const got = pull(plan), dropped = drop(plan);
  // the newest car pick wins: keep the backup's here, or send this phone's
  const car = carPlan(localCar(), cloudCar(prof));
  if (car.keep) keepCar(car.keep, true);
  if (more && !got && !dropped) dispatchEvent(new CustomEvent('tt:drives'));
  lastRaw = raw();
  // nothing new to send: no write, so two open devices don't keep waking each other
  const count = Object.keys(plan.known).length;
  if (!prof || plan.upload.length || plan.remove.length || car.send || Number(prof.drives) !== count) {
    if (prof) await routesFirst(c, u, plan);
    await push(c, u, plan, now, !prof, car.send ? carFields(car.send) : {});
  } else writeState(u, { known: plan.known, last: now, tracks, seen: Number(prof.lastSync) || 0 });
  lastFull = Date.now();
  say(plan, got, dropped);
  await sendTracks(c, u);
  await prefetch(u);
}

async function local(u: string): Promise<void> {
  const st = readState(u), now = Date.now();
  const plan = localPlan(allSummaries(), st.known, now, MAX_SUMMARIES);
  if (planEmpty(plan)) return;
  const c = await loadCloud();
  if (uid !== u) return;
  await routesFirst(c, u, plan);
  await push(c, u, plan, now);
  say(plan, 0, 0);
  await sendTracks(c, u);
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

/** Deletes here what was deleted on another device. */
function drop(plan: Plan): number {
  for (const id of plan.forget) { forgetDrive(Number(id)); forgetLog(Number(id)); }
  if (plan.forget.length) dispatchEvent(new CustomEvent('tt:drives'));
  return plan.forget.length;
}

async function push(c: Cloud, u: string, plan: Plan, now: number, create = false, more: Record<string, unknown> = {}): Promise<void> {
  const count = Object.keys(plan.known).length;
  await c.write(u, plan.upload.map((s) => ({ id: driveId(s.at), data: toDoc(s, now) })), plan.remove, { lastSync: now, drives: count, ...more }, create);
  if (uid !== u) return;
  // a deleted drive's route went with it
  const off = new Set(plan.remove);
  writeState(u, { known: plan.known, last: now, tracks: readState(u).tracks.filter((id) => !off.has(id)), seen: now });
}

/** The routes of the drives about to go up, sent before their summaries. One that fails goes again after. */
async function routesFirst(c: Cloud, u: string, plan: Plan): Promise<void> {
  if (!plan.upload.length) return;
  try { await sendTracks(c, u, new Set(plan.upload.map((s) => driveId(s.at)))); } catch (e) { console.warn('TireTrail will send a route again:', e); }
}

/**
 * Sends the routes of this phone's own drives that the backup doesn't have yet, one at a time:
 * the backed-up ones (older drives too, once), or just the ones in first.
 */
async function sendTracks(c: Cloud, u: string, first?: ReadonlySet<string>): Promise<void> {
  const st = readState(u), have = new Set(st.tracks);
  for (const d of savedDrives()) {
    const id = driveId(d.at);
    if (have.has(id) || (first ? !first.has(id) : !st.known[id])) continue;
    const doc = trackDoc(d.at, d.fixes.map(unpack), Date.now());
    // too short once the ends are left out: only its summary goes
    if (!doc) continue;
    await c.putTrack(u, id, { ...doc });
    if (uid !== u) return;
    have.add(id);
    writeState(u, { ...readState(u), tracks: [...have] });
  }
}

/** The backup has this drive's route (and it isn't here yet). */
export function routeInCloud(at: number): boolean {
  const id = driveId(at);
  return !!uid && !gone.has(id) && !trackOf(at) && readState(uid).tracks.includes(id);
}

/** ok: it's here now; none: the backup has only the summary; offline: couldn't reach it; signin: not signed in (or not this account's); damaged */
export type RouteResult = 'ok' | 'none' | 'offline' | 'signin' | 'damaged';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolves once sync starts for someone, or after ms. */
function signedInSoon(ms: number): Promise<void> {
  return new Promise((done) => {
    const go = () => { clearTimeout(t); waiters.delete(go); done(); };
    const t = setTimeout(go, ms);
    waiters.add(go);
  });
}

/** One route from the backup, kept here. */
async function loadRoute(u: string, at: number): Promise<RouteResult> {
  const id = driveId(at);
  let data: unknown;
  try {
    data = await (await loadCloud()).track(u, id);
  } catch (e) {
    console.warn('TireTrail could not load a route:', e);
    const code = String((e as { code?: unknown } | null)?.code ?? '');
    return /permission|unauthenticated/.test(code) ? 'signin' : 'offline';
  }
  if (uid !== u) return 'signin';
  if (data == null) { gone.add(id); return 'none'; }
  const fixes = readTrack(data, at);
  if (!fixes) return 'damaged';
  gone.delete(id);
  // storage full: it still opens until the page closes
  keepFetched(at, fixes.map(pack));
  return 'ok';
}

/** Just backed up from another device: its route may be a moment behind (an older app sends it after). */
function fresh(u: string, at: number): boolean {
  const k = readState(u).known[driveId(at)];
  return !!k && Date.now() - k.u < 3 * 60_000;
}

/** Fetches one drive's route from the backup and keeps it here. Waits a moment for sign-in, and for a route still on its way. */
export async function fetchRoute(at: number, retryMs = 2000): Promise<RouteResult> {
  if (trackOf(at)) return 'ok';
  if (!uid && wasSignedIn()) await signedInSoon(SIGNIN_WAIT_MS);
  const u = uid;
  if (!u) return 'signin';
  let r = await loadRoute(u, at);
  for (let i = 0; r === 'none' && i < 3 && fresh(u, at); i++) {
    await wait(retryMs);
    if (uid !== u) return 'signin';
    r = await loadRoute(u, at);
  }
  return r;
}

/** The newest drives' routes from other devices, fetched after a sync, so they're on the map and checked for creeks without a tap. */
async function prefetch(u: string): Promise<void> {
  const st = readState(u);
  const want = allSummaries().filter((s) => st.tracks.includes(driveId(s.at)) && !gone.has(driveId(s.at)) && !trackOf(s.at)).slice(0, PREFETCH);
  let got = 0;
  for (const s of want) {
    if (uid !== u) return;
    if ((await loadRoute(u, s.at)) === 'ok') got++;
  }
  if (got && uid === u) dispatchEvent(new CustomEvent('tt:drives'));
}

function say(plan: Plan, got: number, gone: number): void {
  const first = firstToast;
  firstToast = false;
  const n = Object.keys(plan.known).length;
  if (got) hooks.said(`${got === 1 ? '1 drive' : `${got} drives`} added from your backup.`, true);
  else if (first) hooks.said(n ? `Backed up ${n === 1 ? '1 drive' : `${n} drives`}` : 'Signed in. New drives back up as you save them.', true);
  else if (gone) hooks.said(`${gone === 1 ? '1 drive' : `${gone} drives`} deleted on another device.`, true);
  else if (plan.upload.length) hooks.said('Backed up', true);
}

/** Before deleting the drives on this phone, signed in or out: stops syncing and forgets what was backed up, so the backup isn't deleted too. */
export async function detachPhone(): Promise<void> {
  stopSync();
  await running;
  try {
    const ks: string[] = [];
    for (let i = 0; i < localStorage.length; i++) ks.push(localStorage.key(i) ?? '');
    for (const k of ks) if (k.startsWith('tt-cloud-sync:')) localStorage.removeItem(k);
  } catch { /* blocked */ }
}

/** Deletes everything under users/{uid}, routes too. Throws if it couldn't. */
export async function deleteCloudData(u: string): Promise<void> {
  // nothing may write while it deletes
  stopSync();
  await running;
  const c = await loadCloud();
  await c.wipe(u);
  clearState(u);
}
