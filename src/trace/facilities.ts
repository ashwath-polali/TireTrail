// City facility types, grouped by what they do with water.

/** Soak into the ground. */
export const INFILTRATION_TYPES: ReadonlySet<string> = new Set([
  'Retention/Infiltration',
  'Infiltration Facility',
  'Infiltration Vault',
  'Infiltration',
]);

/** Infiltration with a storm overflow (still counts as soaking in). */
export const INFILTRATION_OVERFLOW_TYPES: ReadonlySet<string> = new Set(['Retention/Infiltration - Overflow']);

/** Hold water, release it slowly downstream. */
export const DETENTION_TYPES: ReadonlySet<string> = new Set([
  'Detention Facility',
  'Detention Vault',
  'Detention Pipe',
  'Detention - Wet',
  'Detention',
  'Retention/Detention',
]);

/** Filter water and pass it on. */
export const TREATMENT_TYPES: ReadonlySet<string> = new Set([
  'Filter Vault',
  'Bioretention Swale',
  'Filtration Swale',
  'Biofiltration Swale',
  'Hydrodynamic Separator Vault',
]);

/** A pipe discharging into these is not a broken end. */
export const FACILITY_TO_TYPES: ReadonlySet<string> = new Set([
  ...INFILTRATION_TYPES,
  ...INFILTRATION_OVERFLOW_TYPES,
  ...DETENTION_TYPES,
  ...TREATMENT_TYPES,
]);
