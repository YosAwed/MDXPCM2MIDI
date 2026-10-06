import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, extname, resolve } from 'node:path';
import { convert, formatReport, buildFlp, buildFlpArrange, arrangeSamplesFromPdx } from './index.js';

const args = process.argv.slice(2);
if (!args.length || args.includes('-h')) {
  console.log('usage: mdx2mid <file.mdx> [-p file.pdx] [-o out.mid] [--loops N] [--fade SEC] [--gm] [--vopm|--opm68] [--flp template.flp] [--flp-arrange template.flp [--sample-root DIR]] [--no-adpcm-filter] [--json]');
  process.exit(0);
}
let arrangeTemplate = '', sampleRoot = '', adpcmFilter = true;
let input = '', pdxPath = '', out = '', loops = 2, fade = 0, gm = false, json = false, noPdx = false, vopm = false, opm68 = false, flpTemplate = '';
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-p') pdxPath = args[++i];
  else if (a === '-o') out = args[++i];
  else if (a === '--loops') loops = +args[++i];
  else if (a === '--fade') fade = +args[++i];
  else if (a === '--gm') gm = true;
  else if (a === '--vopm') vopm = true;
  else if (a === '--opm68') { opm68 = true; vopm = true; }
  else if (a === '--flp') { flpTemplate = args[++i]; opm68 = true; vopm = true; }
  else if (a === '--flp-arrange') { arrangeTemplate = args[++i]; opm68 = true; vopm = true; }
  else if (a === '--sample-root') sampleRoot = args[++i];
  else if (a === '--no-pdx') noPdx = true;
  else if (a === '--no-adpcm-filter') adpcmFilter = false;
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
  res = convert(mdxBuf, pdxBuf, { loops, fadeSeconds: fade, pcmMode: gm || !pdxBuf ? 'gm' : 'sf2', fmMode: opm68 ? 'opm68' : vopm ? 'vopm' : 'gm', adpcmFilter });
} catch (e) {
  if (json) console.log(JSON.stringify({ file: input, ok: false, error: String((e as Error).message) }));
  else console.error(`${input}: ${(e as Error).message}`);
  process.exit(1);
}
if (!out) out = join(dirname(input), basename(input, extname(input)) + '.mid');
if (!json) {
  writeFileSync(out, res.midi);
  if (res.sf2) writeFileSync(out.replace(/\.mid$/i, '.sf2'), res.sf2);
  const stem = out.replace(/\.mid$/i, '');
  const opmFiles: Record<string, string> = {};
  if (vopm) {
    for (const b of res.opmBanks) {
      const f = res.opmBanks.length === 1 ? `${stem}.opm` : `${stem}_ch${b.label}.opm`;
      writeFileSync(f, b.text); opmFiles[b.label] = basename(f);
    }
  }
  if (flpTemplate) {
    const banks: Record<string, string> = {};
    for (const b of res.opmBanks) for (const L of b.channels) banks[L] = b.text;
    const f = buildFlp({ template: new Uint8Array(readFileSync(flpTemplate)), midi: res.midi, banks, title: res.title || basename(input), name: basename(input, extname(input)) });
    writeFileSync(`${stem}.flp`, f.flp);
    res.warnings.push(...f.warnings);
  }
  if (arrangeTemplate) {
    const banks: Record<string, string> = {};
    for (const b of res.opmBanks) for (const L of b.channels) banks[L] = b.text;
    const name = basename(input, extname(input));
    const sdir = `${stem}_samples`;
    const sep = sampleRoot.includes('\\') ? '\\' : '/';
    const f = buildFlpArrange({
      template: new Uint8Array(readFileSync(arrangeTemplate)), midi: res.midi, banks, title: res.title || basename(input), name,
      samples: arrangeSamplesFromPdx(res.pcmKeys, pdxPath ? new Uint8Array(readFileSync(pdxPath)) : null, adpcmFilter),
      samplePath: (file) => (sampleRoot === '.' ? `${basename(sdir)}\\${file}` : sampleRoot ? `${sampleRoot.replace(/[\\/]$/, '')}${sep}${basename(sdir)}${sep}${file}` : resolve(sdir, file)),
    });
    writeFileSync(`${stem}_arrange.flp`, f.flp);
    if (f.wavs.length) { mkdirSync(sdir, { recursive: true }); for (const w of f.wavs) writeFileSync(join(sdir, w.file), w.data); }
    res.warnings.push(...f.warnings, `arrange: トラック ${f.stats.tracks} / クリップ ${f.stats.clips} / パターン ${f.stats.patterns} / サンプラー ${f.stats.samplers}`);
  }
  writeFileSync(`${stem}_report.md`, formatReport(res, { fileName: basename(input), opmFiles }));
}
const info = {
  file: input, ok: true, title: res.title, pdx: res.pdxName, pdxFound: pdxPath || null, pcm8: res.pcm8,
  duration: +res.durationSec.toFixed(1), loop: res.loopSec !== null ? +res.loopSec.toFixed(1) : null,
  channels: res.usedChannels.join(''), pcmKeys: res.pcmKeys.length, warnings: res.warnings,
};
console.log(json ? JSON.stringify(info) : info);
