/// <reference lib="webworker" />
import { convert, parseMdx, formatReport, buildFlp, type ConvertOptions } from '@mdxpcm2midi/core';

export type WorkerReq =
  | { id: number; kind: 'inspect'; mdx: Uint8Array }
  | { id: number; kind: 'convert'; mdx: Uint8Array; pdx: Uint8Array | null; options: ConvertOptions; fileName: string; flpTemplate?: Uint8Array | null };

export type WorkerRes =
  | { id: number; ok: true; kind: 'inspect'; title: string; pdxName: string; pcm8: boolean }
  | {
      id: number; ok: true; kind: 'convert'; midi: Uint8Array; sf2: Uint8Array | null; durationSec: number;
      loopSec: number | null; warnings: string[]; channels: string[]; pcmKeys: number; programs: Record<number, number>;
      opmBanks: { label: string; channels: string; text: string; voices: number }[] | null; opmVoices: number;
      report: string; flp: Uint8Array | null;
    }
  | { id: number; ok: false; error: string };

self.onmessage = (ev: MessageEvent<WorkerReq>) => {
  const req = ev.data;
  try {
    if (req.kind === 'inspect') {
      const m = parseMdx(req.mdx);
      post({ id: req.id, ok: true, kind: 'inspect', title: m.title, pdxName: m.pdxName, pcm8: m.pcm8 });
    } else {
      const r = convert(req.mdx, req.pdx, req.options);
      const stem = req.fileName.replace(/\.mdx$/i, '');
      const opmFiles = Object.fromEntries(r.opmBanks.map((b) => [b.label, r.opmBanks.length === 1 ? `${stem}.opm` : `${stem}_ch${b.label}.opm`]));
      const report = formatReport(r, { fileName: req.fileName, opmFiles: req.options.fmMode !== 'gm' && req.options.fmMode ? opmFiles : undefined });
      let flp: Uint8Array | null = null;
      if (req.flpTemplate && req.options.fmMode === 'opm68') {
        const banks: Record<string, string> = {};
        for (const b of r.opmBanks) for (const L of b.channels) banks[L] = b.text;
        const f = buildFlp({ template: req.flpTemplate, midi: r.midi, banks, title: r.title || stem, name: stem });
        flp = f.flp;
        r.warnings.push(...f.warnings);
      }
      const transfer = [r.midi.buffer, ...(r.sf2 ? [r.sf2.buffer] : []), ...(flp ? [flp.buffer] : [])] as ArrayBuffer[];
      post({
        id: req.id, ok: true, kind: 'convert', midi: r.midi, sf2: r.sf2, durationSec: r.durationSec, loopSec: r.loopSec,
        warnings: r.warnings, channels: r.usedChannels, pcmKeys: r.pcmKeys.length, programs: r.programs,
        opmBanks: req.options.fmMode === 'vopm' || req.options.fmMode === 'opm68' ? r.opmBanks : null, opmVoices: r.opmBanks.reduce((a, b) => a + b.voices, 0), report, flp,
      }, transfer);
    }
  } catch (e) {
    post({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};

function post(msg: WorkerRes, transfer: Transferable[] = []) {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);
}
