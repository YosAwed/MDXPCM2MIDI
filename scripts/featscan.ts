// Per-song MXDRV command usage scan (used to pick feature test songs).
//   esbuild scripts/featscan.ts --bundle --platform=node --format=esm --outfile=featscan.mjs
//   node featscan.mjs <mdx dir> <out.jsonl>   (one JSON line per MDX: channels, CONs, loop, cmd byte counts)
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseMdx } from '../packages/core/src/mdx.js';
import { sequence } from '../packages/core/src/sequencer.js';
const root = process.argv[2], out = process.argv[3];
const lines: string[] = [];
function walk(d: string) {
  for (const f of readdirSync(d)) {
    if (f.startsWith('_')) continue;
    const p = join(d, f);
    let s; try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) walk(p);
    else if (/\.mdx$/i.test(f) && s.size < 200000) {
      try {
        const m = parseMdx(new Uint8Array(readFileSync(p)));
        const r = sequence(m, { loops: 1, maxTicks: 48 * 4 * 400 });
        const cons = [...new Set([...m.voices.values()].map((v) => v.con))].sort().join('');
        const used = r.usedChannels.map((u, i) => (u ? 'ABCDEFGHPQRSTUVW'[i] : '')).join('');
        const cc: Record<string, number> = {};
        for (const [k, v] of Object.entries(r.cmdCounts)) cc[(+k).toString(16)] = v;
        lines.push(JSON.stringify({ f: relative(root, p), t: m.title.slice(0, 60), pdx: m.pdxName, pcm8: m.pcm8, used, cons, end: r.endTick, loop: r.loopTick, lfo: !!r.opmLfo, keys: r.pcmKeys.length, cc }));
      } catch (e) { lines.push(JSON.stringify({ f: relative(root, p), err: String((e as Error).message).slice(0, 80) })); }
    }
  }
}
walk(root);
writeFileSync(out, lines.join('\n'));
console.log(lines.length);
