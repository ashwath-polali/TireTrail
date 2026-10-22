// "What do you drive?": kept on this phone, chosen while parked. A typical car until set.
import { isVehicle, VEHICLE_ORDER, VEHICLES, type Vehicle } from '../../drive/dust.ts';
import { h } from '../dom.ts';

const KEY = 'tt-vehicle';

export function getVehicle(): Vehicle {
  try { const v = localStorage.getItem(KEY); return isVehicle(v) ? v : 'car'; } catch { return 'car'; }
}

/** true once the driver picked one */
export function vehicleSet(): boolean {
  try { return isVehicle(localStorage.getItem(KEY)); } catch { return false; }
}

export function setVehicle(v: Vehicle): void {
  try { localStorage.setItem(KEY, v); } catch { /* blocked */ }
}

/** Five keys in a row; the chosen one is pressed. onPick runs after it's saved. */
export function vehiclePicker(onPick: (v: Vehicle) => void): HTMLElement {
  const now = getVehicle(), set = vehicleSet();
  const box = h('div.dv-car', { role: 'group', 'aria-label': 'What do you drive?' });
  for (const v of VEHICLE_ORDER) {
    box.append(h('button.dv-car-k', {
      type: 'button', 'aria-pressed': String(set && v === now),
      onclick: () => { setVehicle(v); for (const b of box.children) b.setAttribute('aria-pressed', String(b === btn)); onPick(v); },
    }, VEHICLES[v].label));
    const btn = box.lastElementChild as HTMLElement;
  }
  return box;
}
