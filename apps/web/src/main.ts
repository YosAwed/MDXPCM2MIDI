import { zipSync } from 'fflate';
import type { ConvertOptions } from '@mdxpcm2midi/core';
import type { WorkerReq, WorkerRes } from './worker';

interface Item {
  id: number;
  file: string;
  mdx: Uint8Array;
  title: string;
  pdxName: string;
  pcm8: boolean;
  error?: string;
  status: 'ready' | 'busy' | 'done' | 'error';
  result?: Extract<WorkerRes, { kind: 'convert' }>;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const items: Item[] = [];
const pdxPool = new Map<string, { name: string; data: Uint8Array }>();
let nextId = 1;

// ---- worker RPC ----
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const pending = new Map<number, (r: WorkerRes) => void>();
let reqId = 1;
worker.onmessage = (ev: MessageEvent<WorkerRes>) => { pending.get(ev.data.id)?.(ev.data); pending.delete(ev.data.id); };
type ReqNoId = WorkerReq extends infer R ? (R extends WorkerReq ? Omit<R, 'id'> : never) : never;
function call(req: ReqNoId): Promise<WorkerRes> {
  const id = reqId++;
  return new Promise((res) => { pending.set(id, res); worker.postMessage({ ...req, id }); });
}

// ---- file intake ----
async function addFiles(files: File[]) {
  for (const f of files) {
    const data = new Uint8Array(await f.arrayBuffer());
    if (/\.pdx$/i.test(f.name)) {
      pdxPool.set(f.name.toLowerCase(), { name: f.name, data });
    } else if (/\.mdx$/i.test(f.name)) {
      const it: Item = { id: nextId++, file: f.name, mdx: data, title: '', pdxName: '', pcm8: false, status: 'ready' };
      const r = await call({ kind: 'inspect', mdx: data.slice() });
      if (r.ok && r.kind === 'inspect') Object.assign(it, { title: r.title, pdxName: r.pdxName, pcm8: r.pcm8 });
      else if (!r.ok) Object.assign(it, { status: 'error', error: r.error });
      items.push(it);
    }
  }
  // a PDX added later invalidates SF2-less results
  for (const it of items) if (it.status === 'done' && it.pdxName && !it.result?.sf2 && pdxFor(it)) { it.status = 'ready'; it.result = undefined; }
  render();
}

function pdxFor(it: Item) {
  if (!it.pdxName) return null;
  const n = it.pdxName.toLowerCase();
  return pdxPool.get(n.endsWith('.pdx') ? n : `${n}.pdx`) ?? null;
}

async function entriesToFiles(dt: DataTransfer): Promise<File[]> {
  const out: File[] = [];
  const walk = async (e: FileSystemEntry): Promise<void> => {
    if (e.isFile) out.push(await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej)));
    else if (e.isDirectory) {
      const reader = (e as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const c of batch) await walk(c);
      }
    }
  };
  const entries = Array.from(dt.items).map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return Array.from(dt.files);
  for (const e of entries) await walk(e);
  return out;
}

const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', async (e) => {
  e.preventDefault(); drop.classList.remove('over');
  if (e.dataTransfer) await addFiles(await entriesToFiles(e.dataTransfer));
});
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $<HTMLInputElement>('file').click(); } });
$<HTMLInputElement>('file').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  await addFiles(Array.from(input.files ?? []));
  input.value = '';
});

// ---- options ----
function options(it: Item): ConvertOptions {
  const mode = $<HTMLSelectElement>('pcmMode').value;
  const hasPdx = !!pdxFor(it);
  return {
    loops: +$<HTMLInputElement>('loops').value || 2,
    fadeSeconds: +$<HTMLInputElement>('fade').value || 0,
    bendRange: +$<HTMLInputElement>('bend').value || 12,
    fmMode: $<HTMLSelectElement>('fmMode').value === 'vopm' ? 'vopm' : 'gm',
    volumeMode: (() => { const v = $<HTMLSelectElement>('volumeMode').value; return v === 'auto' ? undefined : (v as 'cc7' | 'velocity' | 'bake'); })(),
    pcmMode: mode === 'gm' ? 'gm' : mode === 'sf2' ? (hasPdx ? 'sf2' : 'gm') : hasPdx ? 'sf2' : 'gm',
  };
}
for (const id of ['loops', 'fade', 'pcmMode', 'bend', 'fmMode', 'volumeMode']) {
  $(id).addEventListener('change', () => { for (const it of items) if (it.status === 'done') { it.status = 'ready'; it.result = undefined; } render(); });
}

// ---- convert ----
async function convertItem(it: Item) {
  if (it.status === 'busy' || it.error) return;
  it.status = 'busy'; render();
  const pdx = pdxFor(it);
  const r = await call({ kind: 'convert', mdx: it.mdx.slice(), pdx: pdx ? pdx.data.slice() : null, options: options(it), fileName: it.file });
  if (r.ok && r.kind === 'convert') { it.result = r; it.status = 'done'; }
  else if (!r.ok) { it.status = 'error'; it.error = r.error; }
  render();
}
async function convertAll() { for (const it of items) if (it.status === 'ready') await convertItem(it); }

const base = (f: string) => f.replace(/\.mdx$/i, '');
function download(name: string, data: Uint8Array, type: string) {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function zipAll() {
  await convertAll();
  const files: Record<string, Uint8Array> = {};
  const sf2Done = new Set<string>();
  for (const it of items) {
    if (!it.result) continue;
    files[`${base(it.file)}.mid`] = it.result.midi;
    files[`${base(it.file)}_report.md`] = new TextEncoder().encode(it.result.report);
    for (const b of it.result.opmBanks ?? []) {
      const n = it.result.opmBanks!.length === 1 ? `${base(it.file)}.opm` : `${base(it.file)}_ch${b.label}.opm`;
      files[n] = new TextEncoder().encode(b.text);
    }
    if (it.result.sf2) {
      // one SoundFont per song (keys depend on the song's sample usage)
      const n = `${base(it.file)}.sf2`;
      if (!sf2Done.has(n)) { files[n] = it.result.sf2; sf2Done.add(n); }
    }
  }
  download('mdx2midi.zip', zipSync(files, { level: 6 }), 'application/zip');
}

$('convertAll').addEventListener('click', convertAll);
$('zipAll').addEventListener('click', zipAll);
$('clear').addEventListener('click', () => { items.length = 0; pdxPool.clear(); render(); });

// ---- render ----
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Minimal Markdown (headings, bullet lists, pipe tables) to HTML for the report. */
function mdToHtml(md: string): string {
  const out: string[] = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        if (!/^\|[-| ]+\|$/.test(lines[i])) rows.push(lines[i].slice(1, -1).split('|').map((c) => c.trim()));
        i++;
      }
      i--;
      const [h, ...b] = rows;
      out.push(`<table><thead><tr>${h.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${b.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    } else if (l.startsWith('### ')) out.push(`<h5>${esc(l.slice(4))}</h5>`);
    else if (l.startsWith('## ')) out.push(`<h4>${esc(l.slice(3))}</h4>`);
    else if (l.startsWith('# ')) continue;
    else if (l.startsWith('- ')) out.push(`<p class="li">${esc(l.slice(2))}</p>`);
  }
  return out.join('');
}

function render() {
  const list = $('list');
  if (!items.length) {
    list.innerHTML = pdxPool.size ? `<p class="empty">PDX ${pdxPool.size} 件を読み込みました。MDX を追加してください。</p>` : '';
  } else {
    list.innerHTML = items.map((it) => {
      const pdx = pdxFor(it);
      const pdxBadge = !it.pdxName ? '<span class="badge muted">PDX なし</span>'
        : pdx ? `<span class="badge ok">${esc(pdx.name)}</span>`
        : `<span class="badge warn" title="同じ名前の PDX をドロップすると SF2 を作れます">${esc(it.pdxName)}.PDX 未読込</span>`;
      const r = it.result;
      const meta = r ? `<span>${fmt(r.durationSec)}${r.loopSec !== null ? `(ループ ${fmt(r.loopSec)}〜)` : ''}</span><span>ch ${r.channels.join('')}</span>` : '';
      const report = r ? `<details class="report"><summary>チャンネル別の音色割り当て</summary><div class="md">${mdToHtml(r.report)}</div></details>` : '';
      const warns = r?.warnings.length ? `<details class="warns"><summary>警告 ${r.warnings.length} 件</summary><ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>` : '';
      const btns = it.status === 'done' && r
        ? `<button data-dl="mid" data-id="${it.id}">.mid</button>${r.sf2 ? `<button data-dl="sf2" data-id="${it.id}" class="secondary">.sf2</button>` : ''}<button data-dl="report" data-id="${it.id}" class="ghost" title="チャンネル別の音色割り当てレポート (Markdown)">レポート.md</button>${r.opmBanks?.length ? `<button data-dl="opm" data-id="${it.id}" class="secondary" title="VOPM 音色バンク (${r.opmVoices} 音色)">${r.opmBanks.length > 1 ? `.opm ×${r.opmBanks.length}` : '.opm'}</button>` : ''}`
        : it.status === 'busy' ? '<span class="spin">変換中…</span>'
        : it.status === 'error' ? `<span class="err">${esc(it.error ?? 'エラー')}</span>`
        : `<button data-conv="${it.id}" class="secondary">変換</button>`;
      return `<article class="item ${it.status}">
        <div class="name"><strong>${esc(it.title || it.file)}</strong><small>${esc(it.file)}${it.pcm8 ? ' · PCM8' : ''}</small></div>
        <div class="meta">${pdxBadge}${meta}</div>
        <div class="btns">${btns}</div>${report}${warns}
      </article>`;
    }).join('');
  }
  const any = items.some((i) => !i.error);
  $<HTMLButtonElement>('convertAll').disabled = !items.some((i) => i.status === 'ready');
  $<HTMLButtonElement>('zipAll').disabled = !any;
}

$('list').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const conv = t.dataset.conv, dl = t.dataset.dl;
  if (conv) { const it = items.find((i) => i.id === +conv); if (it) convertItem(it); }
  if (dl) {
    const it = items.find((i) => i.id === +(t.dataset.id ?? 0));
    if (it?.result) {
      if (dl === 'mid') download(`${base(it.file)}.mid`, it.result.midi, 'audio/midi');
      else if (dl === 'report') download(`${base(it.file)}_report.md`, new TextEncoder().encode(it.result.report), 'text/markdown');
      else if (dl === 'opm' && it.result.opmBanks?.length) {
        const banks = it.result.opmBanks;
        if (banks.length === 1) download(`${base(it.file)}.opm`, new TextEncoder().encode(banks[0].text), 'text/plain');
        else download(`${base(it.file)}_opm.zip`, zipSync(Object.fromEntries(banks.map((b) => [`${base(it.file)}_ch${b.label}.opm`, new TextEncoder().encode(b.text)]))), 'application/zip');
      }
      else if (dl === 'sf2' && it.result.sf2) download(`${base(it.file)}.sf2`, it.result.sf2, 'application/octet-stream');
    }
  }
});

$('ver').textContent = `build ${__BUILD__}`;
declare const __BUILD__: string;
render();
