// npm run numbers: writes headline numbers into docs/ENGINE.md
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { compareWithKey } from '../src/trace/agreement.ts';
import { analyzeCity } from '../src/trace/city.ts';
import { loadAnswerKey, loadInputs } from './lib/inputs.ts';
import { numbersMarkdown } from './lib/numbers-md.ts';

const city = analyzeCity(loadInputs());
const agreement = compareWithKey(city.net, city.traces, loadAnswerKey(), city.projection);
const md = numbersMarkdown(city, agreement);
console.log(md);

const doc = new URL('../docs/ENGINE.md', import.meta.url);
const START = '<!-- numbers:start -->';
const END = '<!-- numbers:end -->';
if (existsSync(doc)) {
  const text = readFileSync(doc, 'utf8');
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (a >= 0 && b > a) {
    writeFileSync(doc, `${text.slice(0, a + START.length)}\n${md}\n${text.slice(b)}`);
    console.log('\nUpdated the numbers section of docs/ENGINE.md');
  } else {
    console.log('\ndocs/ENGINE.md has no numbers markers; nothing written');
  }
}
