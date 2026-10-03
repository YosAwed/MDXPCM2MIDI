# MDXPCM2MIDI

X68000 の MDX (MXDRV) ファイルを Standard MIDI File に変換する Web ツールです。PDX を一緒に読み込むと、ADPCM パートを原音で鳴らすための SoundFont (.sf2) も生成します。変換はすべてブラウザ内で行い、ファイルはサーバへ送信しません。

## 構成

```
packages/core   変換コア (TypeScript, 依存なし)
  src/mdx.ts        MDX ヘッダ・音色・チャンネル解析 (9ch / PCM8 16ch)
  src/sequencer.ts  仮想 MXDRV シーケンサ (リピート・ループ・同期・テンポ)
  src/convert.ts    シーケンサ出力 → SMF (format 1, 480 PPQN)
  src/pdx.ts        PDX 解析・MSM6258 ADPCM / PCM8 16bit・8bit 復号
  src/sf2.ts        SoundFont 2 ライタ
  src/cli.ts        Node CLI (mdx2mid)
apps/web        Vite 製の静的サイト (Cloudflare Pages で配信)
scripts/corpus.ts  大量の MDX を一括変換してエラーを集計するテストランナー
```

## 開発

```sh
pnpm install
pnpm test                      # ユニットテスト
pnpm dev                       # http://localhost:5173
pnpm build                     # apps/web/dist を生成
node packages/core/dist/cli.mjs song.mdx [-p song.pdx] [--loops 2] [--fade 8] [--gm] [--vopm]
```

コーパステスト (手元の MDX 群で実行):

```sh
npx esbuild scripts/corpus.ts --bundle --platform=node --format=esm --outfile=corpus.mjs
node corpus.mjs list D:/X68000/MDX list.txt
node corpus.mjs run list.txt out.jsonl 600     # 600 秒ごとに再開可能
node corpus.mjs summary out.jsonl
```

## 変換仕様

| MDX | MIDI |
|---|---|
| FM A–H | ch1–8。音色 (@n) は OPM パラメータから GM 音色を推定 |
| ADPCM P (PCM8: P–W) | SF2 モード: ch10 (bank128 ドラムキット) と ch9, 11–16 (bank127/prog0)。GM モード: ch10 の GM ドラム |
| テンポ (Timer B) | 4分音符 = 48 clock、μs/四分 = 12288 × (256 − n) |
| v / @v / ( ) | CC7 (TL 0.75dB/step を GM の音量カーブに換算) |
| p | CC10 (p0 は CC11=0 でミュート) |
| D (デチューン) / _ (ポルタメント) / MP (ピッチ LFO) | ピッチベンド (RPN で幅を設定、既定 ±12) |
| q / @q / & | ゲートタイム・タイ / スラー |
| L ループ, [ ]255 | 指定回数展開、任意で終端フェード (CC11) |

### VOPM モード (`fmMode: 'vopm'` / CLI `--vopm`)

- MDX の FM 音色を VOPM / MiOPMdrv 形式の `.opm` バンク (128 スロット) に書き出します。オペレータは `.opm` の M1, C1, M2, C2 順に並べ替えます。
- プログラムチェンジは `.opm` のスロット番号です。使用音色がすべて @0–127 なら MDX の @番号と同じ、それ以外は使用順に詰めます。
- 曲中で最初に出てくる OPM ハード LFO 設定 (EA) を各音色の `LFO:` / `CH: AMS PMS` に書き込みます。
- 未定義の @番号は MXDRV と同様に無視します (直前の音色のまま)。
- 音量は既定で MXDRV と同じくキャリアの TL に加算した音色として `.opm` に焼き込み、(音色, 音量) の組をプログラムチェンジで切り替えます (VOPM の CC7/ベロシティ特性に依存しない)。組が 128 を超える曲は FM チャンネルごとに `.opm` を出力します。発音中の音量変化は次の発音から反映されます。`volumeMode: 'cc7' | 'velocity'` も選べます。
- DAW では VOPM を 8 インスタンス立ち上げ、それぞれに `.opm` を読み込んで MIDI ch1–8 を割り当てます。ADPCM は `.sf2` を SoundFont プレーヤーで鳴らします。
- `tools/opmrender` は ymfm で `.mid` + `.opm` を描画する試聴用ツールです。

既知の制限: LZX 圧縮 MDX は未対応 / FM 音色の再現は GM 近似 / 振幅 LFO と OPM ハード LFO は無視 / 0xE0–0xE6 の独自拡張コマンドは非対応。

## デプロイ (Cloudflare Pages)

1. Cloudflare ダッシュボード → Workers & Pages → Create → Pages → **Connect to Git** で `YosAwed/MDXPCM2MIDI` を選択
2. ビルド設定
   - Framework preset: None
   - Build command: `pnpm install --frozen-lockfile && pnpm --filter web build`
   - Build output directory: `apps/web/dist`
   - 環境変数: `NODE_VERSION=22`
3. 以降 `main` への push で本番、その他のブランチはプレビューに自動デプロイ

### 公開前のアクセス制限 (Cloudflare Access)

1. Zero Trust → Access → Applications → Add an application → **Self-hosted**
2. ドメインに `mdxpcm2midi.pages.dev` (とプレビュー用 `*.mdxpcm2midi.pages.dev`) を指定
3. Policy: Action = Allow, Include = Emails (許可するメールアドレス) — ワンタイム PIN でログイン
4. 一般公開するときはこの Application を削除し、`apps/web/public/_headers` の `X-Robots-Tag: noindex` を外す
