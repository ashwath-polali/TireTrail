// "Clover Creek Tributary 7" feeds Clover Creek. "West Tributary" is the stream's own name.
const WATER = /\b(creek|river|lake|slough|brook|fork|branch|run|channel|waterway|canal|outflow|outlet|stream|bay|inlet|pond|spring)s?$/i;

/** The water a tributary feeds, or null when "Tributary" is part of the stream's own name. */
export function tributaryOf(name: string): string | null {
  const t = /^(.+?)\s+tributary\b/i.exec(name.trim());
  return t && WATER.test(t[1]) ? t[1] : null;
}
