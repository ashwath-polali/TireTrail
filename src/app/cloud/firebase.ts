// Firebase config and lazy start. These web config values are public by design; the Firestore rules keep each person's data to them.
import type { Cloud } from './sdk.ts';

export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyClPcS3bJmdP1ne8yFTBpSwJJp02m10CwY',
  authDomain: 'tiretrail-3d31b.firebaseapp.com',
  projectId: 'tiretrail-3d31b',
  storageBucket: 'tiretrail-3d31b.firebasestorage.app',
  messagingSenderId: '519010382013',
  appId: '1:519010382013:web:c457b5d0aa9ee8ac3307d4',
};

let loading: Promise<Cloud> | null = null;
let ready: Cloud | null = null;

/** Loads the Firebase code (once) and starts it. A failed load, like offline, is tried again on the next call. */
export function loadCloud(): Promise<Cloud> {
  if (loading) return loading;
  const p = import('./sdk.ts').then((m) => (ready = new m.Cloud(FIREBASE_CONFIG)));
  loading = p;
  p.catch(() => { if (loading === p) loading = null; });
  return p;
}

/** Firebase, if it has already loaded. */
export const cloudNow = (): Cloud | null => ready;
