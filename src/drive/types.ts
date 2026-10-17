export interface Fix {
  /** ms since epoch */
  t: number;
  lat: number;
  lon: number;
  /** m/s, Doppler */
  speed?: number | null;
  /** degrees from north */
  heading?: number | null;
  /** meters */
  accuracy?: number | null;
}

/** no GPS (screen locked or app hidden) */
export interface Gap {
  from: number;
  to: number;
  reason: 'hidden' | 'signal';
}

export interface Drive {
  fixes: Fix[];
  gaps: Gap[];
  startedAt: number;
  endedAt: number;
}
