// Per-stop line and general tips.
import type { StreetClass } from '../trace/streets.ts';

export interface Tip {
  id: 'brake-earlier' | 'slow-into-turns' | 'tire-pressure';
  title: string;
  text: string;
}

export const GENERAL_TIPS: readonly Tip[] = [
  { id: 'brake-earlier', title: 'Brake earlier', text: 'Start slowing sooner so you can stop gently. Brake as hard as you need to; just begin earlier.' },
  { id: 'slow-into-turns', title: 'Slow into turns', text: 'Take corners at a gentler speed. Cornering wears tread too.' },
  { id: 'tire-pressure', title: 'Check tire pressure monthly', text: 'Under-inflated tires wear out faster, which also costs money.' },
];

// Only creek-class stops say the rubber reaches the creek.
export function stopTip(cls: StreetClass, hard: boolean, receiving: string): string {
  const brake = hard ? ' Brake earlier here.' : '';
  switch (cls) {
    case 'creek': {
      const via = !receiving || receiving === 'Fennel Creek' ? '' : /tributary/i.test(receiving) ? ' by way of a tributary' : ` by way of ${receiving}`;
      return `This stop's rubber goes to Fennel Creek${via}, where coho salmon spawn.${brake}`;
    }
    case 'ground':
      return `This one soaks into the ground.${brake}`;
    case 'elsewhere':
      return `This one drains to ${receiving || 'water outside the Fennel Creek system'}.${brake}`;
    case 'unknown':
      return `The city's pipe map doesn't show where this one goes.${brake}`;
    case 'none':
      return `There's no mapped storm drain near this stop.${brake}`;
  }
}
