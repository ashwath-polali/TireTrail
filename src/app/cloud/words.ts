// Plain words for the account sheet. Pure.

/** "just now", "5 min ago", "3 h ago", "yesterday", "Oct 12" */
export function agoWords(ms: number | null, now: number): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return 'Not yet';
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86400) return 'Yesterday';
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** What to tell the person when Google sign-in fails; null when they just closed the window. */
export function signInWords(code: string): string | null {
  switch (code) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
    case 'auth/user-cancelled':
      return null;
    case 'auth/popup-blocked':
      return 'Your browser blocked the Google window. Allow pop-ups for this site, then tap the button again.';
    case 'auth/network-request-failed':
    case 'tt/offline':
      return "Can't reach Google right now. Check your connection, then try again.";
    case 'auth/unauthorized-domain':
      return "This web address isn't allowed to sign in yet. Add it under Authorized domains in Firebase.";
    case 'auth/operation-not-allowed':
      return 'Google sign-in is turned off for this app.';
    case 'auth/too-many-requests':
      return 'Too many tries. Wait a minute, then try again.';
    case 'auth/web-storage-unsupported':
      return 'This browser blocks the storage sign-in needs. Try a normal (not private) window.';
    default:
      return "Couldn't sign in. Try again.";
  }
}

/** A short first name for the top bar: "Ashwath", or the email's start. */
export function shortName(name: string, email: string): string {
  const first = name.trim().split(/\s+/)[0] || email.split('@')[0] || 'Account';
  return first.length > 12 ? `${first.slice(0, 11)}…` : first;
}

/** "1 drive", "12 drives" */
export const drivesWord = (n: number): string => `${n} drive${n === 1 ? '' : 's'}`;

/** "All drivers: 3,812 gentle stops where rain flows to salmon streams". Null before anyone has driven. */
export function allDriversLine(t: { drives: number; smoothStops: number; salmonSmoothStops: number } | null): string | null {
  if (!t || !(t.drives >= 1)) return null;
  const n = (x: number) => Math.round(x).toLocaleString('en-US');
  if (t.salmonSmoothStops > 0) return `All drivers: ${n(t.salmonSmoothStops)} gentle ${t.salmonSmoothStops === 1 ? 'stop where rain flows to a salmon stream' : 'stops where rain flows to salmon streams'}`;
  return `All drivers: ${n(t.drives)} ${t.drives === 1 ? 'drive' : 'drives'} so far`;
}
