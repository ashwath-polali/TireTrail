// The live drive's warning levels on screen and out loud; the rules are in drive/coach/alerts.ts.
// The drive screen's root gets data-alert (the level, while the banner holds it) and data-edge (while the edge shows); drive-alerts.css draws them.
import type { Alert } from '../../drive/coach/alerts.ts';
import { canSpeak, isMuted, speak, stopVoice, tone } from '../../drive/coach/voice.ts';
// @ts-ignore: Vite loads the CSS
import './drive-alerts.css';

/** a serious line waits this long after the chime, and after a cut (the iPhone drops a line said right after a cancel), ms */
export const CHIME_MS = 420, CUT_MS = 180;

/** speak(line, { rank, chime }): rank 4 (serious) stops the line being said, chimes twice when asked, then says this one. */
export function speakRanked(line: string, o: { rank: number; chime: boolean }): boolean {
  if (!line || isMuted() || !canSpeak()) return false;
  if (o.rank < 4) return speak(line);
  stopVoice();
  if (o.chime) tone('alert');
  setTimeout(() => speak(line), o.chime ? CHIME_MS : CUT_MS);
  return true;
}

/** Shows an alert's level on the drive screen's root for holdMs, and its edge for edgeMs (all the hold with reduced motion). */
export class AlertMarks {
  private hold = 0;
  private edge = 0;

  show(root: HTMLElement | null | undefined, a: Alert, holdMs: number, still = false): void {
    clearTimeout(this.hold);
    clearTimeout(this.edge);
    if (!root) return;
    if (a.level === 'normal') return this.clear(root);
    root.dataset.alert = a.level;
    // a fresh flash restarts its animation
    delete root.dataset.edge;
    void root.offsetWidth;
    if (a.flash) {
      root.dataset.edge = 'on';
      this.edge = window.setTimeout(() => { delete root.dataset.edge; }, still ? holdMs : a.edgeMs);
    }
    this.hold = window.setTimeout(() => this.clear(root), holdMs);
  }

  clear(root: HTMLElement | null | undefined): void {
    clearTimeout(this.hold);
    clearTimeout(this.edge);
    if (!root) return;
    delete root.dataset.alert;
    delete root.dataset.edge;
  }
}
