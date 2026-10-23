// The sample drive (public/data/sample-drive.json) drawn small for the guide's map still. No DOM, so tests run it.
// Region meters (src/salmon/proj.ts) less ORIGIN, in 10 m units, y south. A test checks them against the data.

/** the region point (m) that (0, 0) stands for */
export const ORIGIN = [-21160, 4070] as const;

/** the route, simplified to 12 m: west, then south */
export const ROUTE: readonly (readonly [number, number])[] = [[337, 0], [332, 7], [331, 19], [327, 20], [185, 18], [164, 20], [1, 16], [3, 104], [2, 234]];

/** each salmon creek crossed, in order: where, whether gently, and the creek within 650 m (SWIFD lines, simplified) */
export const CREEKS: readonly { name: string; at: readonly [number, number]; gentle: boolean; lines: readonly (readonly (readonly [number, number])[])[] }[] = [
  { name: 'Clover Creek', at: [246, 19], gentle: true, lines: [[[206, -13], [220, -14], [223, 3], [246, 18], [249, 23], [246, 36], [247, 42], [249, 50]], [[249, 50], [251, 53], [271, 66], [278, 74]]] },
  { name: 'Spanaway Creek', at: [13, 17], gentle: false, lines: [[[27, -37], [24, -28], [18, -24], [14, -19], [16, -11], [16, -6], [21, -3], [19, 2]], [[19, 2], [14, 3], [15, 14], [7, 23], [6, 27], [19, 43], [27, 49], [28, 53]], [[28, 53], [34, 54], [42, 58], [46, 65], [45, 71]]] },
  { name: 'Morey Creek', at: [2, 58], gentle: true, lines: [[[-54, 27], [-51, 24], [-40, 22], [-31, 32], [-28, 38], [-10, 53], [-3, 55], [1, 58], [8, 59]], [[8, 59], [12, 56], [28, 53]]] },
];

/** the hard brakes */
export const BRAKES: readonly (readonly [number, number])[] = [[186, 18], [2, 16]];
