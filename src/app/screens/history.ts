// My drives: your progress (score trend, money, hard brakes per 10 miles, streak), your spots, then every drive.
import { moneyText } from '../../drive/money.ts';
import { progressOf, type Progress } from '../../drive/progress.ts';
import { spotsFrom, type Spot } from '../../drive/spots.ts';
import type { DriveSummary } from '../../drive/summary.ts';
import type { XY } from '../../geo/geo.ts';
import type { App, FrameOut, Screen } from '../app.ts';
import { h } from '../dom.ts';
import { bars, button, glyph, hero, insight, meter, panel, score, scoreTone, screen, stagger, toast } from '../ui/ui.ts';
import { driveChips } from './drive-sheets.ts';
import { count, dayWord, needMoreLine, per10Word, shortDay, spotWords, streakLine, timeWord, usdShort } from './drive-words.ts';
import { driveSummaries, forgetDrive, savedDrives } from './saved.ts';

const label = (text: string) => h('p.u-eyebrow.dv-label', {}, text);
const ico = (name: string, scale = 2) => h('span.u-ico', { 'aria-hidden': 'true', html: glyph(name, scale) });

export class HistoryScreen implements Screen {
  private readonly app: App;
  /** a drive was picked while one is still recording */
  private blocked = false;

  constructor(app: App) {
    this.app = app;
  }

  enter(): void {
    const app = this.app, drive = app.screens.drive;
    drive.ensureSummaries();
    const sums = driveSummaries(), has = sums.length > 0, phone = drive.canRecord;
    const warn = this.blocked && drive.recording;
    this.blocked = false;
    const p = progressOf(sums, 12);
    const miles = sums.reduce((t, s) => t + s.mi, 0);
    const top = hero({
      eyebrow: 'MY DRIVES',
      title: has ? 'Your progress' : 'No drives yet',
      sub: has ? `${count(sums.length, 'drive')}, ${miles.toFixed(miles < 10 ? 1 : 0)} miles. Here's how your driving is changing.`
        : phone ? 'Record a drive and your progress shows up here: your score, what hard stops and speeding cost you, and the places you brake hard.'
          : 'Drives are saved on the phone that recorded them. Open TireTrail on your phone to record one.',
    });
    const body = h('div.dv-progress', {},
      top,
      warn ? insight({ icon: 'warn', tone: 'warn', title: 'End your drive first.', body: 'A drive is still recording on the Drive tab.' }) : null,
      has ? this.progress(p) : this.empty(phone),
      has ? this.spots(spotsFrom(sums)) : null,
      has ? this.list(sums) : null,
      h('footer.dv-progress-foot', {},
        h('p.u-caption', {}, `Your drives stay on this ${phone ? 'phone' : 'computer'}. Nothing is uploaded.`),
        button('Open a GPX file', { kind: 'ghost', icon: 'up', onClick: () => drive.pickFile() })));
    stagger(body);
    app.showPage(screen([body]));
  }

  /** No drives yet: one key that starts one. */
  private empty(phone: boolean): HTMLElement {
    const app = this.app, go = () => { app.setTab('drive'); app.screens.drive.home(); };
    return panel([
      h('div.dv-empty', {},
        h('img.dv-empty-art', { src: 'art/tut-5-app.png', alt: '', draggable: 'false' }),
        phone ? button('Start a drive', { kind: 'primary', icon: 'record', wide: true, onClick: go })
          : button('Try a sample drive', { kind: 'primary', icon: 'play', wide: true, onClick: () => { app.setTab('drive'); void app.screens.drive.loadSample(); } })),
    ], { pad: 'm' });
  }

  /** Score trend, money per drive, hard brakes per 10 miles and the streak. */
  private progress(p: Progress): HTMLElement {
    const recent = p.recent, latest = recent[recent.length - 1];
    const avg = p.avgScore ?? latest.score, tone = scoreTone(avg);
    const days = recent.map((d) => shortDay(d.at));
    const scoreCard = panel([
      h('div.dv-card-head', {}, label('SMOOTH SCORE'), h('span.dv-card-note', {}, p.drives >= 3 ? 'Last 3 drives' : 'So far')),
      score(avg, { tone, countUp: true, caption: 'out of 100' }),
      meter(avg, 100, { blocks: 20, tone }),
      h('p.dv-verdict', { 'data-tone': p.verdict === 'smoother' ? 'money' : p.verdict === 'rougher' ? 'warn' : 'plain' }, p.verdictText ? `${p.verdictText}.` : needMoreLine(p.needMore)),
      recent.length >= 2 ? h('div.dv-chart', {}, label('EACH DRIVE'), bars(recent.map((d) => d.score), { labels: days, tone: 'you' })) : null,
    ], { pad: 'l' });

    const perDrive = recent.reduce((t, d) => t + d.usd, 0) / recent.length;
    const moneyCard = panel([
      label('MONEY LOST PER DRIVE'),
      score(perDrive, { prefix: '$', decimals: 2, tone: 'money', countUp: true, caption: 'average, estimated' }),
      recent.length >= 2 ? bars(recent.map((d) => d.usd), { labels: days, tone: 'money' }) : null,
      h('p.dv-card-foot', {}, p.year && p.year.total.typical > 0 ? `To hard stops and speeding. ${moneyText(p.year.total.typical, 'year').replace(/^a/, 'A')} a year at this rate.` : 'To hard stops and speeding.'),
    ], { pad: 'm' });

    const latest3 = recent.slice(-3), per10 = latest3.reduce((t, d) => t + d.per10, 0) / latest3.length;
    const trend = p.per10
      ? p.per10.latest < p.per10.first - 0.05 ? `Down from ${per10Word(p.per10.first)} on your first drives.`
        : p.per10.latest > p.per10.first + 0.05 ? `Up from ${per10Word(p.per10.first)} on your first drives.` : 'About the same as your first drives.'
      : 'Lower is smoother.';
    const brakeCard = panel([
      label('HARD BRAKES EVERY 10 MI'),
      score(Math.round(per10 * 10) / 10, { decimals: per10 >= 10 ? 0 : 1, tone: per10 > 0 ? 'warn' : 'money', countUp: true }),
      recent.length >= 2 ? bars(recent.map((d) => d.per10), { labels: days, tone: 'warn' }) : null,
      h('p.dv-card-foot', {}, trend),
    ], { pad: 'm' });

    const streakCard = panel([
      h('div.dv-streak', {},
        h('span.dv-streak-ico', { 'aria-hidden': 'true', html: glyph(p.streak ? 'trophy' : 'star', 4) }),
        h('div', {}, label('STREAK'), h('p.dv-streak-line', {}, streakLine(p.streak)))),
    ], { pad: 'm' });

    return h('section.dv-prog', { 'aria-label': 'Your progress' }, scoreCard, h('div.dv-pair', {}, moneyCard, brakeCard), streakCard);
  }

  /** The places this driver keeps braking hard; each opens on the map. */
  private spots(spots: Spot[]): HTMLElement {
    const app = this.app;
    const row = (s: Spot) => panel([
      h('div.dv-spot-row', {},
        h('span.dv-spot-ico', { 'aria-hidden': 'true', html: glyph('bell', 3) }),
        h('div.dv-spot-text', {},
          h('p.dv-spot-t', {}, s.name || 'A spot on your drives'),
          h('p.dv-spot-s', {}, `${count(s.count, 'hard brake')} on ${count(s.drives, 'drive')}${s.salmon ? ' · drains to a salmon stream' : ''}`)),
        ico('chevron')),
    ], { onClick: () => app.screens.drive.showSpot(s), pad: 's' });
    return h('section.dv-sec', {},
      h('div.dv-card-head', {}, label('YOUR HARD-STOP SPOTS'), spots.length ? h('span.dv-card-note', {}, 'It chimes before these') : null),
      spots.length
        ? h('div.dv-spots', {}, ...spots.slice(0, 6).map(row))
        : insight({ icon: 'bell', tone: 'plain', title: 'No hard-stop spots yet.', body: 'Brake hard in the same place on 2 drives and TireTrail learns it. Next time it chimes before you get there.' }));
  }

  /** Every saved drive, newest first. Ones with their full track open on the map. */
  private list(sums: DriveSummary[]): HTMLElement {
    const app = this.app, tracks = new Set(savedDrives().map((d) => d.at));
    const open = (at: number) => {
      // opening a saved drive mid-recording would leave the recording half on screen
      if (app.screens.drive.openSaved(at)) return;
      this.blocked = true;
      this.enter();
    };
    const row = (d: DriveSummary) => {
      const can = tracks.has(d.at);
      const confirm = h('div.dv-row-confirm', { hidden: true },
        h('p.u-body', {}, "Delete this drive? It can't be undone."),
        h('div.dv-row-keys', {},
          button('Delete', { kind: 'danger', icon: 'trash', onClick: () => { forgetDrive(d.at); toast('Drive deleted.', { icon: 'trash' }); this.enter(); } }),
          button('Keep', { kind: 'secondary', onClick: () => { confirm.hidden = true; } })));
      const del = h('button.u-btn.u-ghost.u-square.dv-del', { type: 'button', 'aria-label': 'Delete this drive', title: 'Delete', onclick: () => { confirm.hidden = false; } }, ico('trash'));
      const kids = [
        h('div.dv-row-head', {},
          h('div.dv-row-when', {}, h('b', {}, dayWord(d.at)), h('span', {}, timeWord(d.at))),
          h('b.dv-row-score', { 'data-tone': scoreTone(d.score) }, String(d.score)),
          del),
        h('p.dv-row-line', {}, `${d.mi.toFixed(1)} mi · ${Math.max(1, Math.round(d.min))} min · ${usdShort(d.gas.typical + d.tires.typical)} lost`),
        driveChips(d, false),
        can ? null : h('p.u-caption', {}, 'Only the summary of an older drive is kept.'),
        confirm,
      ];
      return can ? panel(kids, { onClick: () => open(d.at), pad: 'm' }) : panel(kids, { pad: 'm' });
    };
    return h('section.dv-sec', {}, label('YOUR DRIVES'), h('div.dv-rows', {}, ...sums.map(row)));
  }

  leave(): void {}

  tap(_p: XY): boolean {
    return false;
  }

  frame(): FrameOut {
    return { scene: {} };
  }

  relayout(): void {
    this.enter();
  }
}
