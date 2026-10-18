// Google sign-in: who is signed in, a tiny change event, and a note so Firebase loads again on the next visit.
import { cloudNow, loadCloud } from './firebase.ts';
import type { Person } from './sdk.ts';

export type { Person } from './sdk.ts';
/** idle: Firebase not loaded; loading; ready: the saved session is checked; failed: couldn't load (offline) */
export type Phase = 'idle' | 'loading' | 'ready' | 'failed';

const KEY = 'tt-cloud';
let me: Person | null = remembered();
let phase: Phase = 'idle';
let starting: Promise<boolean> | null = null;
const subs = new Set<() => void>();

function remembered(): Person | null {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Person | null;
    return p && typeof p.uid === 'string' ? { uid: p.uid, name: String(p.name ?? ''), email: String(p.email ?? '') } : null;
  } catch { return null; }
}

function remember(p: Person | null): void {
  try {
    if (p) localStorage.setItem(KEY, JSON.stringify({ uid: p.uid, name: p.name, email: p.email }));
    else localStorage.removeItem(KEY);
  } catch { /* storage blocked */ }
}

function emit(): void {
  for (const fn of subs) try { fn(); } catch (e) { console.warn(e); }
}

/** Calls fn whenever sign-in or loading changes. Returns a stop function. */
export function onAuth(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

/** The signed-in person. Before Firebase checks, the one remembered from last time. */
export const person = (): Person | null => me;
export const authPhase = (): Phase => phase;

/** Signed in on an earlier visit, so Firebase should load now. */
export const wasSignedIn = (): boolean => remembered() !== null;

/** Loads Firebase and checks the saved session. False if it couldn't load. */
export function prepare(): Promise<boolean> {
  if (starting) return starting;
  phase = 'loading';
  emit();
  const p = loadCloud().then((c) => new Promise<boolean>((done) => {
    c.watch((who) => {
      me = who;
      remember(who);
      phase = 'ready';
      emit();
      done(true);
    });
  }), () => {
    phase = 'failed';
    starting = null;
    emit();
    return false;
  });
  starting = p;
  return p;
}

/** An error with a Firebase-style code. */
export class CloudError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** Opens Google's window. Call it right from the tap: with Firebase loaded it opens at once, so pop-up blockers allow it. */
export function signIn(): Promise<Person> {
  const c = cloudNow();
  const go = c ? c.popup() : prepare().then((ok) => (ok ? cloudNow()!.popup() : Promise.reject(new CloudError('tt/offline'))));
  return go.catch((e: unknown) => {
    throw e instanceof CloudError ? e : new CloudError(String((e as { code?: unknown })?.code ?? 'unknown'));
  });
}

export async function signOut(): Promise<void> {
  remember(null);
  me = null;
  emit();
  await cloudNow()?.signOut();
}
