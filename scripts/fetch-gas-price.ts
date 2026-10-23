// Refreshes src/drive/gas-price.json: U.S. EIA weekly Washington regular gas (series EMM_EPMR_PTE_SWA_DPG).
// Needs EIA_API_KEY (free: https://www.eia.gov/opendata/register.php). Without one, or if the fetch fails, it keeps the
// dated price. Runs before every build and never fails it. EIA posts Monday-dated weeks on Tuesday.
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('../src/drive/gas-price.json', import.meta.url);
const SERIES = 'EMM_EPMR_PTE_SWA_DPG';
const STALE_DAYS = 30;

interface Price { usdPerGal: number; weekOf: string; source: string; seriesId: string; fetchedAt: string }

const today = () => new Date().toISOString().slice(0, 10);
const ok = (v: unknown, week: unknown): boolean => typeof v === 'number' && v >= 2 && v <= 10 && typeof week === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(week);

async function fetchEia(key: string): Promise<{ v: number; week: string } | null> {
  const q = new URLSearchParams({ api_key: key, frequency: 'weekly', 'data[0]': 'value', 'facets[series][]': SERIES, 'sort[0][column]': 'period', 'sort[0][direction]': 'desc', length: '1' });
  const res = await fetch(`https://api.eia.gov/v2/petroleum/pri/gnd/data/?${q}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`EIA ${res.status}`);
  const row = ((await res.json()) as { response?: { data?: { period?: string; value?: unknown }[] } }).response?.data?.[0];
  const v = typeof row?.value === 'string' ? Number(row.value) : row?.value;
  return ok(v, row?.period) ? { v: v as number, week: row!.period! } : null;
}

async function main(): Promise<void> {
  const now = JSON.parse(readFileSync(FILE, 'utf8')) as Price;
  const key = process.env.EIA_API_KEY;
  if (key) {
    try {
      const got = await fetchEia(key);
      if (!got) console.warn('gas price: EIA sent no usable value; keeping', now.usdPerGal, now.weekOf);
      else if (got.week !== now.weekOf || got.v !== now.usdPerGal) {
        const next: Price = { usdPerGal: got.v, weekOf: got.week, source: 'U.S. EIA', seriesId: SERIES, fetchedAt: today() };
        writeFileSync(FILE, `${JSON.stringify(next, null, 2)}\n`);
        Object.assign(now, next);
        console.log(`gas price: $${got.v} a gallon, week of ${got.week} (U.S. EIA)`);
      } else console.log(`gas price: up to date, $${got.v} (week of ${got.week})`);
    } catch (e) {
      console.warn('gas price: fetch failed, keeping the dated price.', (e as Error).message);
    }
  } else {
    console.log(`gas price: no EIA_API_KEY, keeping $${now.usdPerGal} (week of ${now.weekOf})`);
  }
  const age = Math.floor((Date.now() - Date.parse(`${now.weekOf}T00:00:00Z`)) / 86_400_000);
  if (age > STALE_DAYS) console.warn(`gas price: WARNING, the price is ${age} days old. Set EIA_API_KEY and run npm run gas:price.`);
}

main().catch((e) => console.warn('gas price:', e));
