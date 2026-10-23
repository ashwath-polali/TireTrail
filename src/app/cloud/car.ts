// "What do you drive?": kept on this phone, and in users/{uid}/profile/main when signed in, so every device uses the same car.
// The newest pick wins. A pick made before syncing has no time and loses to one in the backup.
import { isVehicle, type Vehicle } from '../../drive/dust.ts';

const KEY = 'tt-vehicle', AT = 'tt-vehicle-at';
/** fired when the driver picks here (sync sends it) */
export const CAR_EVENT = 'tt:vehicle';

export interface CarPick {
  car: Vehicle;
  /** ms when it was picked; 0 if unknown */
  at: number;
}

/** This phone's pick, or null if none yet. */
export function localCar(): CarPick | null {
  try {
    const v = localStorage.getItem(KEY);
    if (!isVehicle(v)) return null;
    const at = Number(localStorage.getItem(AT));
    return { car: v, at: Number.isFinite(at) && at > 0 ? at : 0 };
  } catch { return null; }
}

/** Saves a pick here. quiet: it came from the backup, so don't send it back. */
export function keepCar(p: CarPick, quiet = false): void {
  try {
    localStorage.setItem(KEY, p.car);
    localStorage.setItem(AT, String(p.at));
  } catch { /* blocked */ }
  if (!quiet && typeof dispatchEvent === 'function') dispatchEvent(new CustomEvent(CAR_EVENT));
}

/** The pick in a profile doc, or null. */
export function cloudCar(prof: Record<string, unknown> | null | undefined): CarPick | null {
  const car = prof?.car, at = prof?.carAt;
  return isVehicle(car) ? { car, at: typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : 0 } : null;
}

/** What to do: keep the backup's pick here, send this phone's, or neither. */
export function carPlan(here: CarPick | null, cloud: CarPick | null): { keep?: CarPick; send?: CarPick } {
  if (here && (!cloud || here.at > cloud.at)) return { send: here };
  if (cloud && (!here || cloud.at > here.at || (cloud.at === here.at && cloud.car !== here.car))) return { keep: cloud };
  return {};
}

/** profile fields for a pick */
export const carFields = (p: CarPick): Record<string, unknown> => ({ car: p.car, carAt: p.at });
