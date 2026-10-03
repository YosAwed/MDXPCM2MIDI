import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, extname } from 'node:path';
import { convert } from './index.js';

const args = process.argv.slice(2);
if (!args.length || args.includes('-h')) {
  console.log('usage: mdx2mid <file.mdx> [-p file.pdx] [-o out.mid] [--loops N] [--fade SEC] [--gm] [--vopm] [--json]');
  process.exit(0);
}
let input = '', pdxPath = '', out = '', loops = 2, fade = 0, gm = false, json = false, noPdx = false, vopm = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-p') pdxPath = args[++i];
  else if (a === '-o') out = args[++i];
  else if (a === '--loops') loops = +args[++i];
  else if (a === '--fade') fade = +args[++i];
  else if (a === '--gm') gm = true;
  else if (a === '--vopm') vopm = true;
  else if (a === '--no-pdx') noPdx = true;
  else if (a === '--json') json = true;
  else input = a;
}
const mdxBuf = new Uint8Array(readFileSync(input));
// Auto-locate PDX next to the MDX (case-insensitive) using the name stored in the MDX.
function findPdx(name: string): string {
  if (!name) return '';
  const dir = dirname(input);
  const want = (name.toLowerCase().endsWith('.pdx') ? name : name + '.pdx').toLowerCase();
  for (const d of [dir, join(dir, '..', 'PDX'), join(dir, '..')]) {
    if (!existsSync(d)) continue;
    const hit = readdirSync(d).find((f) => f.toLowerCase() === want);
    if (hit) return join(d, hit);
  }
  return '';
}
let res;
try {
  const head = convert(mdxBuf, null, { loops, fadeSeconds: fade, pcmMode: 'gm' });
  if (!pdxPath && !noPdx && !gm) pdxPath = findPdx(head.pdxName);
  const pdxBuf = pdxPath ? new Uint8Array(readFileSync(pdxPath)) : null;
  res = convert(mdxBuf, pdxBuf, { loops, fadeSeconds: fade, pcmMode: gm || !pdxBuf ? 'gm' : 'sf2', fmMode: vopm ? 'vopm' : 'gm' });
} catch (e) {
  if (json) console.log(JSON.stringify({ file: input, ok: false, error: String((e as Error).message) }));
  else console.error(`${input}: ${(e as Error).message}`);
  process.exit(1);
}
if (!out) out = join(dirname(input), basename(input, extname(input)) + '.mid');
if (!json) {
  writeFileSync(out, res.midi);
  if (res.sf2) writeFileSync(out.replace(/\.mid$/i, '.sf2'), res.sf2);
  if (vopm) writeFileSync(out.replace(/\.mid$/i, '.opm'), res.opmBank);
}
const info = {
  file: input, ok: true, title: res.title, pdx: res.pdxName, pdxFound: pdxPath || null, pcm8: res.pcm8,
  duration: +res.durationSec.toFixed(1), loop: res.loopSec !== null ? +res.loopSec.toFixed(1) : null,
  channels: res.usedChannels.join(''), pcmKeys: res.pcmKeys.length, warnings: res.warnings,
};
console.log(json ? JSON.stringify(info) : info);
