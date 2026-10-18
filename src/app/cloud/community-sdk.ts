// Firestore writes for community/totals. Loaded on demand, like sdk.ts.
import { doc, getDoc, increment, serverTimestamp, setDoc, updateDoc, type Firestore } from 'firebase/firestore/lite';
import type { CommunityAdd } from '../../drive/community.ts';

const code = (e: unknown) => String((e as { code?: unknown })?.code ?? '');

/** Adds one drive. Creates the document the first time. */
export async function addDrive(db: Firestore, a: CommunityAdd): Promise<void> {
  const ref = doc(db, 'community', 'totals');
  const bump = () => updateDoc(ref, {
    drives: increment(1),
    smoothStops: increment(a.smoothStops),
    salmonSmoothStops: increment(a.salmonSmoothStops),
    miles: increment(a.miles),
    updated: serverTimestamp(),
  });
  try {
    await bump();
  } catch (e) {
    if (code(e) !== 'not-found') throw e;
    try {
      await setDoc(ref, { drives: 1, ...a, updated: serverTimestamp() });
    } catch (e2) {
      // someone else made it first
      if ((await getDoc(ref)).exists()) await bump();
      else throw e2;
    }
  }
}

export async function readTotals(db: Firestore): Promise<Record<string, unknown> | null> {
  const s = await getDoc(doc(db, 'community', 'totals'));
  return s.exists() ? s.data() : null;
}
