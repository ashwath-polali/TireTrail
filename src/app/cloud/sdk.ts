// The only file that imports Firebase. Loaded on demand by firebase.ts, so the first page load never carries it.
import { initializeApp, type FirebaseOptions } from 'firebase/app';
import { GoogleAuthProvider, getAuth, onAuthStateChanged, signInWithPopup, signOut, type Auth, type User } from 'firebase/auth';
import { arrayRemove, arrayUnion, collection, deleteDoc, doc, getDoc, getDocs, getFirestore, writeBatch, type Firestore } from 'firebase/firestore/lite';

export interface Person {
  uid: string;
  name: string;
  email: string;
}

const person = (u: User): Person => ({ uid: u.uid, name: u.displayName ?? '', email: u.email ?? '' });

/** Firestore takes at most 500 writes in one batch */
const BATCH = 400;

export class Cloud {
  readonly auth: Auth;
  readonly db: Firestore;

  constructor(config: FirebaseOptions) {
    const app = initializeApp(config);
    this.auth = getAuth(app);
    this.db = getFirestore(app);
  }

  /** Opens Google's window. Call it straight from the tap, or the browser blocks it. */
  popup(): Promise<Person> {
    const p = new GoogleAuthProvider();
    p.setCustomParameters({ prompt: 'select_account' });
    return signInWithPopup(this.auth, p).then((r) => person(r.user));
  }

  signOut(): Promise<void> {
    return signOut(this.auth);
  }

  /** fn gets the signed-in person, or null; first call once the saved session is checked. */
  watch(fn: (p: Person | null) => void): () => void {
    return onAuthStateChanged(this.auth, (u) => fn(u ? person(u) : null));
  }

  async drives(uid: string): Promise<{ id: string; data: unknown }[]> {
    const snap = await getDocs(collection(this.db, 'users', uid, 'drives'));
    return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
  }

  async profile(uid: string): Promise<Record<string, unknown> | null> {
    const snap = await getDoc(doc(this.db, 'users', uid, 'profile', 'main'));
    return snap.exists() ? snap.data() : null;
  }

  /** One drive's route, or null if there isn't one. */
  async track(uid: string, id: string): Promise<unknown | null> {
    const snap = await getDoc(doc(this.db, 'users', uid, 'tracks', id));
    return snap.exists() ? snap.data() : null;
  }

  /** Saves one route and lists it in the profile, together. Fails if the backup was deleted. */
  async putTrack(uid: string, id: string, data: Record<string, unknown>): Promise<void> {
    const b = writeBatch(this.db);
    b.update(doc(this.db, 'users', uid, 'profile', 'main'), { tracks: arrayUnion(id) });
    b.set(doc(this.db, 'users', uid, 'tracks', id), data);
    await b.commit();
  }

  /**
   * Writes the profile, then drives and deletes (a deleted drive's route goes too), in batches.
   * create: the first backup. Otherwise the profile must still be there, so a backup deleted on another device isn't brought back.
   */
  async write(uid: string, put: { id: string; data: Record<string, unknown> }[], del: string[], profile: Record<string, unknown>, create = false): Promise<void> {
    type Op = (b: ReturnType<typeof writeBatch>) => void;
    const me = doc(this.db, 'users', uid, 'profile', 'main');
    const ops: Op[] = [
      (b) => { if (create) b.set(me, profile, { merge: true }); else b.update(me, del.length ? { ...profile, tracks: arrayRemove(...del) } : profile); },
      ...put.map((p): Op => (b) => { b.set(doc(this.db, 'users', uid, 'drives', p.id), p.data); }),
      ...del.flatMap((id): Op[] => [(b) => { b.delete(doc(this.db, 'users', uid, 'drives', id)); }, (b) => { b.delete(doc(this.db, 'users', uid, 'tracks', id)); }]),
    ];
    for (let i = 0; i < ops.length; i += BATCH) {
      const b = writeBatch(this.db);
      for (const op of ops.slice(i, i + BATCH)) op(b);
      await b.commit();
    }
  }

  /** Deletes everything under users/{uid}: every drive and route, then the profile. */
  async wipe(uid: string): Promise<void> {
    const prof = await this.profile(uid);
    const listed = Array.isArray(prof?.tracks) ? prof.tracks.filter((x): x is string => typeof x === 'string') : [];
    const drives = (await this.drives(uid)).map((d) => d.id);
    const del = async (kind: string, ids: string[]) => {
      for (let i = 0; i < ids.length; i += BATCH) {
        const b = writeBatch(this.db);
        for (const id of ids.slice(i, i + BATCH)) b.delete(doc(this.db, 'users', uid, kind, id));
        await b.commit();
      }
    };
    await del('drives', drives);
    await del('tracks', [...new Set([...drives, ...listed])]);
    // a route listed nowhere: whatever is still there
    await del('tracks', (await getDocs(collection(this.db, 'users', uid, 'tracks'))).docs.map((d) => d.id));
    await deleteDoc(doc(this.db, 'users', uid, 'profile', 'main'));
  }
}
