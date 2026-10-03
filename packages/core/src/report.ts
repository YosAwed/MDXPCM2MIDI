// Human-readable report: which voice / program / volume each channel uses.

import type { ConvertResult } from './convert.js';
import { GM_PROGRAM_NAMES } from './gm.js';

const VOLTAB = [0x2a, 0x28, 0x25, 0x22, 0x20, 0x1d, 0x1a, 0x18, 0x15, 0x12, 0x10, 0x0d, 0x0a, 0x08, 0x05, 0x02];

/** MXDRV volume label for an attenuation: "v15" when it matches the v table, else "@v<att>". */
export function volumeLabel(att: number): string {
  const v = VOLTAB.indexOf(att);
  return v >= 0 ? `v${v}` : `@v${att}`;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const FREQ = ['3.9k', '5.2k', '7.8k', '10.4k', '15.6k', '16bit', '8bit'];

export interface ReportOptions { fileName?: string; opmFiles?: Record<string, string> }

export function formatReport(r: ConvertResult, opts: ReportOptions = {}): string {
  const L: string[] = [];
  const vopm = r.fmMode === 'vopm' || r.fmMode === 'opm68';
  const opm68 = r.fmMode === 'opm68';
  L.push(`# ${r.title || opts.fileName || 'MDX'}`);
  L.push('');
  if (opts.fileName) L.push(`- ファイル: ${opts.fileName}`);
  L.push(`- PDX: ${r.pdxName || 'なし'}${r.pcm8 ? ' (PCM8 16ch)' : ''}`);
  L.push(`- 長さ: ${mmss(r.durationSec)}${r.loopSec !== null ? ` (ループ開始 ${mmss(r.loopSec)})` : ''}`);
  L.push(`- FM 音色: ${opm68 ? 'OPM68 (ノートのベロシティ = 音色番号+1)' : vopm ? 'VOPM (.opm のプログラム番号)' : 'GM 音色に近似'} / 音量: ${{ bake: '音色の TL に焼き込み', cc7: 'CC7', velocity: 'ベロシティ' }[r.volumeMode]}`);
  L.push('');

  // ---- setup ----
  if (vopm) {
    L.push(opm68 ? '## OPM68 の割り当て' : '## VOPM の割り当て');
    L.push('');
    if (r.channels.filter((c) => c.kind === 'FM').every((c) => c.midiCh === 1)) {
      L.push('FM の各トラックはすべて MIDI ch1 で出力しています。トラックごとに VOPM を 1 つずつ割り当ててください。');
      L.push('');
    }
    L.push('| MIDI ch | MDX ch | 読み込む .opm |');
    L.push('|---|---|---|');
    for (const c of r.channels.filter((c) => c.kind === 'FM')) {
      const bank = r.opmBanks.length === 1 ? r.opmBanks[0] : r.opmBanks.find((b) => b.channels.includes(c.ch));
      const file = bank ? (opts.opmFiles?.[bank.label] ?? (r.opmBanks.length === 1 ? '(共通バンク)' : `ch${bank.label} 用バンク`)) : '-';
      L.push(`| ${c.midiCh} | ${c.ch} | ${file} |`);
    }
    const pcm = r.channels.filter((c) => c.kind === 'ADPCM');
    if (pcm.length) L.push(`| ${pcm.map((c) => c.midiCh).join(', ')} | ${pcm.map((c) => c.ch).join('')} | (ADPCM: .sf2 / GM ドラム) |`);
    L.push('');
  }

  // ---- per channel ----
  L.push('## チャンネル別の音色');
  L.push('');
  for (const c of r.channels) {
    L.push(`### ${c.kind} ${c.ch} → MIDI ch${c.midiCh}  (${c.notes} 音)`);
    L.push('');
    if (c.kind === 'FM') {
      const tl = c.voiceTimeline;
      if (tl.length > 1) {
        const shown = tl.slice(0, 40).map((x) => `${mmss(x.sec)} @${x.voice}`).join(' → ');
        L.push(`音色の切り替え (${tl.length - 1} 回): ${shown}${tl.length > 40 ? ' → …' : ''}`);
        L.push('');
      }
      L.push(`| MDX 音色 | 音量 | ${opm68 ? 'Velocity (OPM68)' : vopm ? 'Program (VOPM)' : 'GM Program'} | 音数 | 使用区間 |`);
      L.push('|---|---|---|---|---|');
      for (const u of c.usage) {
        const v = r.voices.find((x) => x.number === u.voice);
        const vs = u.voice >= 0 ? `@${u.voice}${v ? ` (AL${v.con} FB${v.fl})` : ''}` : '(未指定)';
        const prog = u.program < 0 ? '-' : opm68 ? `${u.program + 1}` : vopm ? `${u.program}` : `${u.program + 1} ${GM_PROGRAM_NAMES[u.program] ?? ''}`;
        L.push(`| ${vs} | ${volumeLabel(u.att)} | ${prog} | ${u.notes} | ${mmss(u.firstSec)}–${mmss(u.lastSec)} |`);
      }
    } else {
      L.push('| PDX サンプル | 周波数 | MIDI ノート | 音数 | 使用区間 |');
      L.push('|---|---|---|---|---|');
      const rows = new Map<number, { notes: number; first: number; last: number }>();
      for (const u of c.usage) {
        const k = u.pcmKey ?? -1;
        const o = rows.get(k) ?? { notes: 0, first: u.firstSec, last: u.lastSec };
        o.notes += u.notes; o.first = Math.min(o.first, u.firstSec); o.last = Math.max(o.last, u.lastSec);
        rows.set(k, o);
      }
      for (const [k, o] of [...rows].sort((a, b) => a[0] - b[0])) {
        const pk = r.pcmKeys[k];
        if (!pk) continue;
        const idx = pk.bank * 96 + pk.sample;
        const rate = FREQ[pk.freq] ?? `f${pk.freq}`;
        L.push(`| #${idx}${pk.bank ? ` (bank${pk.bank})` : ''} | ${rate} | ${pk.midiKey} | ${o.notes} | ${mmss(o.first)}–${mmss(o.last)} |`);
      }
    }
    L.push('');
  }

  // ---- voice parameters ----
  const used = new Set(r.channels.flatMap((c) => c.usage.map((u) => u.voice)).filter((v) => v >= 0));
  if (used.size) {
    L.push('## 使用している MDX 音色のパラメータ');
    L.push('');
    for (const n of [...used].sort((a, b) => a - b)) {
      const v = r.voices.find((x) => x.number === n);
      if (!v) continue;
      const chs = r.channels.filter((c) => c.usage.some((u) => u.voice === n)).map((c) => c.ch).join('');
      L.push(`### @${n}  AL=${v.con} FB=${v.fl} SLOT=${(v.slotMask & 15).toString(2).padStart(4, '0')}  (使用 ch: ${chs})`);
      L.push('');
      L.push('| OP | AR | D1R | D2R | RR | D1L | TL | KS | MUL | DT1 | DT2 | AMS-EN |');
      L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
      for (const [nm, i] of [['M1', 0], ['C1', 2], ['M2', 1], ['C2', 3]] as const) {
        const o = v.ops[i];
        L.push(`| ${nm} | ${o.ar} | ${o.d1r} | ${o.d2r} | ${o.rr} | ${o.d1l} | ${o.tl} | ${o.ks} | ${o.mul} | ${o.dt1} | ${o.dt2} | ${o.ame} |`);
      }
      L.push('');
    }
  }
  if (r.warnings.length) {
    L.push('## 警告');
    L.push('');
    for (const w of r.warnings) L.push(`- ${w}`);
    L.push('');
  }
  return L.join('\n');
}
