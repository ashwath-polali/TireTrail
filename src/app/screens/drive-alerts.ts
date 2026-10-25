// The live drive's warning levels on screen and out loud; the rules are in drive/coach/alerts.ts.
// The drive screen's root gets data-alert (the level, while the banner holds it) and data-edge (while the edge shows); drive-alerts.css draws them.
import type { Alert } from '../../drive/coach/alerts.ts';
import { canSpeak, isMuted, RANK, speak } from '../../drive/coach/voice.ts';
// @ts-ignore: Vite loads the CSS
import './drive-alerts.css';

/** An alert's line through the voice's one queue: a serious one (rank 4) cuts the line being said, with its double chime. */
export function speakRanked(line: string, o: { rank: number; chime: boolean }): boolean {
  if (!line || isMuted() || !canSpeak()) return false;
  const serious = o.rank >= RANK.serious;
  return speak(line, { rank: o.rank, chime: o.chime ? (serious ? 'serious' : 'soft') : false, cut: serious });
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
