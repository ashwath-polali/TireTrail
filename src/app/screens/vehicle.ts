// "What do you drive?": chosen while parked. A typical car until set. Kept here and in the signed-in profile (cloud/car.ts).
import { VEHICLE_ORDER, VEHICLES, type Vehicle } from '../../drive/dust.ts';
import { keepCar, localCar } from '../cloud/car.ts';
import { h } from '../dom.ts';

export function getVehicle(): Vehicle {
  return localCar()?.car ?? 'car';
}

/** true once the driver picked one */
export function vehicleSet(): boolean {
  return !!localCar();
}

export function setVehicle(v: Vehicle): void {
  keepCar({ car: v, at: Date.now() });
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
