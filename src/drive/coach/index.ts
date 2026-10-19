// The coach's API: live cues while driving, voice, stop spots, a colored replay, regular trips and money leaks.

// live cues: new LiveCoach({ spots, stopSpots, limits }).update(fix) gives at most one Cue
export { LiveCoach, cuesFor, eventWords, sayMs, secondsTo, speedingWords, LIVE, PRIORITY } from './live.ts';
export type { Cue, CueKind, LimitLookup, LiveCoachInput, LiveEvent } from './live.ts';

// voice: speak, tone, playCue(cue), mute saved on the phone, unlockAudio() from a tap
export { speak, tone, playCue, stopVoice, unlockAudio, isMuted, setMuted, canSpeak } from './voice.ts';

// stop spots: usual full stops (lights, stop signs) from saved drives' stopPts
export { stopSpotsFrom, exampleStopSpots, meanHeading, STOP_SPOT_M } from './stopspots.ts';
export type { StopSpot, StopDrive } from './stopspots.ts';

// replay: the route as colored stretches with "what happened" and "what to do"
export { replayDrive, worstStretches, FIRM_MPS2, REPLAY_OVER_MPH } from './replay.ts';
export type { Replay, ReplayOptions, Stretch, StretchKind } from './replay.ts';

// regular trips: grouping, names, per-trip stats and a day-to-day line
export { routesFrom, routeOf, routeName, sameTrip, compareLine, dayLabels, placesFromLabels, ENDS_M } from './routes.ts';
export type { Route, RouteDrive, Place } from './routes.ts';

// money leaks: the top 3 habits and places, dollars a month with a range
export { HARD_GAS_WHY, leaksFrom } from './leaks.ts';
export type { Leak, LeakKind, Leaks, LeakDrive } from './leaks.ts';

// plain words: distances, cents, dollars a month
export { distText, centsText, monthText, monthRange, plural, times } from './words.ts';
