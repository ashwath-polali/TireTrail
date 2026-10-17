// Tiny DOM builder: h('div.card', { onclick }, 'text', child)
type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined>;
type Kid = Node | string | number | null | undefined | false;

export function h(tag: string, attrs: Attrs = {}, ...kids: Kid[]): HTMLElement {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v as EventListener);
    else if (k === 'html') el.innerHTML = String(v);
    else el.setAttribute(k, String(v));
  }
  for (const k of kids) if (k !== null && k !== undefined && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// US units on screen; the engine stays metric
export const fmt = {
  mi: (m: number) => { const v = m / 1609.344; return `${v < 10 ? v.toFixed(1) : Math.round(v)} mi`; },
  ft: (m: number) => `${(Math.round((m * 3.28084) / 10) * 10).toLocaleString('en-US')} ft`,
  mph: (mps: number) => `${Math.round(mps * 2.23694)} mph`,
  mass: (mg: number) => (mg >= 1000 ? `${(mg / 1000).toFixed(1)} g` : `${Math.round(mg)} mg`),
  pct: (x: number) => `${Math.round(x * 100)}%`,
  clock: (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`,
};
