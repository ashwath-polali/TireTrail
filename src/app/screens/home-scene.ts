// Which picture home shows: the creek (the default) or the night drive toward Rainier. Kept on this device. No DOM, so tests run it.

export type HomeScene = 'creek' | 'night';
export const SCENE_KEY = 'tt-scene';

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const local = (): Store | null => { try { return localStorage; } catch { return null; } };

/** The picture picked last time; the creek when there's none or storage is blocked. */
export function savedScene(store: Store | null = local()): HomeScene {
  try { return store?.getItem(SCENE_KEY) === 'night' ? 'night' : 'creek'; } catch { return 'creek'; }
}

/** The other picture. */
export const nextScene = (s: HomeScene): HomeScene => (s === 'creek' ? 'night' : 'creek');

/** Keeps the pick; blocked storage just forgets it. */
export function keepScene(s: HomeScene, store: Store | null = local()): void {
  try { store?.setItem(SCENE_KEY, s); } catch { /* blocked */ }
}
