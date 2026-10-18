// The only file that imports Firebase. Loaded on demand by firebase.ts, so the first page load never carries it.
import { initializeApp, type FirebaseOptions } from 'firebase/app';
import { GoogleAuthProvider, getAuth, onAuthStateChanged, signInWithPopup, signOut, type Auth, type User } from 'firebase/auth';
import { collection, deleteDoc, doc, getDoc, getDocs, getFirestore, writeBatch, type Firestore } from 'firebase/firestore/lite';

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

  /** Writes and deletes drives, then the profile, in batches. */
  async write(uid: string, put: { id: string; data: Record<string, unknown> }[], del: string[], profile: Record<string, unknown>): Promise<void> {
    const ops: ((b: ReturnType<typeof writeBatch>) => void)[] = [
      ...put.map((p) => (b: ReturnType<typeof writeBatch>) => { b.set(doc(this.db, 'users', uid, 'drives', p.id), p.data); }),
      ...del.map((id) => (b: ReturnType<typeof writeBatch>) => { b.delete(doc(this.db, 'users', uid, 'drives', id)); }),
      (b: ReturnType<typeof writeBatch>) => { b.set(doc(this.db, 'users', uid, 'profile', 'main'), profile); },
    ];
    for (let i = 0; i < ops.length; i += BATCH) {
      const b = writeBatch(this.db);
      for (const op of ops.slice(i, i + BATCH)) op(b);
      await b.commit();
    }
  }

  /** Deletes everything under users/{uid}: every drive, then the profile. */
  async wipe(uid: string): Promise<void> {
    const ids = (await this.drives(uid)).map((d) => d.id);
    for (let i = 0; i < ids.length; i += BATCH) {
      const b = writeBatch(this.db);
      for (const id of ids.slice(i, i + BATCH)) b.delete(doc(this.db, 'users', uid, 'drives', id));
      await b.commit();
    }
    await deleteDoc(doc(this.db, 'users', uid, 'profile', 'main'));
  }
}
