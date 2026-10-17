// Downloads what the terrain estimates need: 3DEP tiles, and Ecology NHD + WDFW coho when the
// context source hasn't written its waters. Usage: node scripts/terrain/fetch.ts [--dem] [--waters]
import { DEM_DIR, KING_PIERCE_BOX } from './config.ts';
import { ensureTiles, tilesFor } from './dem.ts';
import { fetchWaters } from './waters.ts';

const args = process.argv.slice(2);
const all = !args.includes('--dem') && !args.includes('--waters');
if (all || args.includes('--dem')) await ensureTiles(tilesFor(KING_PIERCE_BOX), DEM_DIR);
if (all || args.includes('--waters')) await fetchWaters(KING_PIERCE_BOX);
