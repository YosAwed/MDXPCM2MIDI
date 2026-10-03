// Corpus test runner (time-bounded, resumable).
//   node corpus.mjs list <dir> <list.txt>         write list of .mdx files
//   node corpus.mjs run <list.txt> <out.jsonl> [seconds] [step]  process next files (resumes from out.jsonl)
//   node corpus.mjs summary <out.jsonl>
import { readdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { convert } from '../packages/core/src/index.js';

const [mode, a1, a2, a3, a4] = process.argv.slice(2);

const RANGES = [31, 31, 31, 15, 15, 127, 3, 15, 7, 3, 128];
function checkOpm(txt: string): string | null {
  const L = txt.split('\r\n');
  let voices = 0;
  for (let i = 0; i < L.length; i++) {
    if (!L[i].startsWith('@:')) continue;
    voices++;
    if (!L[i + 1].startsWith('LFO:') || !L[i + 2].startsWith('CH:')) return `bad header @${i}`;
    for (let k = 0; k < 4; k++) {
      const ln = L[i + 3 + k], nums = ln.slice(3).trim().split(/\s+/).map(Number);
      if (ln.slice(0, 3) !== ['M1:', 'C1:', 'M2:', 'C2:'][k] || nums.length !== 11) return `bad op line ${ln}`;
      if (nums.some((n, j) => !(n >= 0 && n <= RANGES[j]))) return `out of range ${ln}`;
    }
  }
  return voices === 128 ? null : `voices=${voices}`;
}

if (mode === 'list') {
  const files: string[] = [];
  const walk = (d: string) => {
    let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else if (/\.mdx$/i.test(e.name)) files.push(p);
    }
  };
  walk(a1);
  files.sort();
  writeFileSync(a2, files.join('\n'));
  console.log(files.length);
} else if (mode === 'run') {
  const files = readFileSync(a1, 'utf8').split('\n').filter(Boolean);
  const step = +(a4 ?? 1);
  const done = existsSync(a2) ? readFileSync(a2, 'utf8').split('\n').filter(Boolean).length : 0;
  const deadline = Date.now() + (+(a3 ?? 140)) * 1000;
  const pdxCache = new Map<string, Map<string, string>>();
  const dirPdx = (d: string) => {
    let m = pdxCache.get(d);
    if (!m) { m = new Map(); try { for (const f of readdirSync(d)) if (/\.pdx$/i.test(f)) m.set(f.toLowerCase(), join(d, f)); } catch {} pdxCache.set(d, m); }
    return m;
  };
  let i = done, out: string[] = [];
  for (; i * step < files.length && Date.now() < deadline; i++) {
    const f = files[i * step];
    const rec: Record<string, unknown> = { f };
    try {
      const buf = new Uint8Array(readFileSync(f));
      const head = convert(buf, null, { pcmMode: 'gm', loops: 1 });
      let pdx: Uint8Array | null = null;
      if (head.pdxName && head.pcmKeys.length) {
        const want = (head.pdxName.toLowerCase().endsWith('.pdx') ? head.pdxName : head.pdxName + '.pdx').toLowerCase();
        const hit = dirPdx(dirname(f)).get(want) ?? dirPdx(join(dirname(f), '..', 'PDX')).get(want);
        rec.pdx = hit ? 1 : 0;
        if (hit) pdx = new Uint8Array(readFileSync(hit));
      }
      const r = convert(buf, pdx, { loops: 2, fmMode: 'vopm' });
      const bad = checkOpm(r.opmBank);
      if (bad) r.warnings.push(`OPM: ${bad}`);
      if (r.warnings.some((w) => w.includes('定義されていません'))) rec.undefVoice = 1;
      Object.assign(rec, { ok: 1, pcm8: r.pcm8 ? 1 : 0, dur: Math.round(r.durationSec), loop: r.loopSec !== null ? 1 : 0, w: r.warnings });
    } catch (e) { rec.ok = 0; rec.err = String((e as Error).message).slice(0, 120); }
    out.push(JSON.stringify(rec));
    if (out.length >= 50) { appendFileSync(a2, out.join('\n') + '\n'); out = []; }
  }
  if (out.length) appendFileSync(a2, out.join('\n') + '\n');
  console.log(`processed ${i}/${Math.ceil(files.length / step)}`);
} else if (mode === 'summary') {
  const recs = readFileSync(a1, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const errs = new Map<string, string[]>(), warns = new Map<string, { n: number; ex: string }>();
  let ok = 0, pcm8 = 0, pdxW = 0, pdxF = 0, ww = 0, longs = 0;
  for (const r of recs) {
    if (!r.ok) { const l = errs.get(r.err) ?? []; if (l.length < 3) l.push(r.f); errs.set(r.err, l); continue; }
    ok++; pcm8 += r.pcm8; if (r.pdx !== undefined) { pdxW++; pdxF += r.pdx; }
    if (r.dur > 900) longs++;
    if (r.w.length) ww++;
    for (const w of r.w) {
      const k = w.replace(/ch \d+/, 'ch N').replace(/0x[0-9a-f]+/g, 'X').replace(/\d+(, \d+)*/g, 'N');
      const o = warns.get(k) ?? { n: 0, ex: r.f }; o.n++; warns.set(k, o);
    }
  }
  console.log(JSON.stringify({ total: recs.length, ok, fail: recs.length - ok, withWarn: ww, pcm8, pdxWanted: pdxW, pdxFound: pdxF, over15min: longs,
    errors: Object.fromEntries([...errs].sort((a, b) => b[1].length - a[1].length).slice(0, 15)),
    warnings: [...warns].sort((a, b) => b[1].n - a[1].n).slice(0, 25) }, null, 1));
}
