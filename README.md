# MDXPCM2MIDI

X68000 の MDX (MXDRV) ファイルを Standard MIDI File に変換する Web ツールです。PDX を一緒に読み込むと、ADPCM パートを原音で鳴らすための SoundFont (.sf2) も生成します。変換はすべてブラウザ内 (Web Worker) で行い、ファイルはサーバへ送信しません。

FM パートは、同梱の YM2151 プラグイン **OPM68** (VST3 / CLAP) で鳴らすと X68000 とほぼ同じ音色・音程で再生できます (推奨)。

## 出力モード

| FM 音色モード | 出力 | 再生方法 |
|---|---|---|
| **OPM68 (既定・推奨)** | `.flp` / `.mid` + `.opm` (+ `.sf2`) | FL Studio は `.flp` を開くだけ (OPM68 ×8 と音色を設定済み)。他の DAW は FM トラックごとに OPM68 を立ち上げ `.opm` を読み込む |
| VOPM | `.mid` + `.opm` (+ `.sf2`) | VOPM / VOPMex を 8 インスタンス、MIDI ch1–8 に割り当て |
| GM 近似 | `.mid` (+ `.sf2`) | 一般の GM 音源。FM 音色は OPM パラメータから推定 |

ADPCM は PDX があれば `.sf2` (原音) を、なければ GM ドラムに割り当てます。変換ごとにチャンネル別の音色レポート (`*_report.md`) も出力します。

## 構成

```
packages/core       変換コア (TypeScript, 依存なし)
  src/mdx.ts          MDX ヘッダ・音色・チャンネル解析 (9ch / PCM8 16ch)
  src/sequencer.ts    仮想 MXDRV シーケンサ (リピート・ループ・同期・テンポ・ポルタメント/LFO)
  src/convert.ts      シーケンサ出力 → SMF (format 1, 480 PPQN)
  src/opm.ts          .opm 音色バンク (VOPM / OPM68) ライタ
  src/flp.ts          FL Studio プロジェクト (.flp) の読み書き・テンプレートへの流し込み
  src/gm.ts           OPM 音色 → GM 音色の推定
  src/pdx.ts          PDX 解析・MSM6258 ADPCM / PCM8 16bit・8bit 復号
  src/sf2.ts          SoundFont 2 ライタ
  src/report.ts       チャンネル別音色レポート
  src/cli.ts          Node CLI (mdx2mid)
apps/web            Vite 製の静的サイト (Cloudflare Pages で配信)
plugin/opm68        YM2151 プラグイン OPM68 (ymfm + DPF, VST3 / CLAP) → plugin/opm68/README.md
tools/opmrender     ymfm で .mid + .opm を描画する開発用の試聴ツール
scripts/corpus.ts   大量の MDX を一括変換してエラーを集計するテストランナー
```

## 開発

```sh
pnpm install
pnpm test                      # ユニットテスト
pnpm dev                       # http://localhost:5173
pnpm build                     # apps/web/dist を生成 (Cloudflare Pages の出力先)
node packages/core/dist/cli.mjs song.mdx [-p song.pdx] [-o out.mid] [--loops 2] [--fade 8] \
     [--gm] [--opm68 | --vopm] [--flp template.flp] [--no-pdx] [--json]
```

CLI は FM の既定が GM 近似です (Web UI の既定は OPM68)。`-p` を省略すると MDX 内の PDX 名から同じフォルダ・`../PDX`・親フォルダを探します。

コーパステスト (手元の MDX 群で実行。MDX/PDX は著作物のためリポジトリには含めません):

```sh
npx esbuild scripts/corpus.ts --bundle --platform=node --format=esm --outfile=corpus.mjs
node corpus.mjs list D:/X68000/MDX list.txt
node corpus.mjs run list.txt out.jsonl 600     # 600 秒ごとに再開可能
node corpus.mjs summary out.jsonl
```

26,012 曲中 25,804 曲 (99.2%) が変換に成功しています (失敗は LZX 圧縮 203 曲・ヘッダ異常 5 曲)。

## 変換仕様

| MDX | MIDI |
|---|---|
| FM A–H | ch1–8 |
| ADPCM P (PCM8: P–W) | SF2 モード: ch10 (bank128 ドラムキット) と ch9, 11–16 (bank127/prog0)。GM モード: ch10 の GM ドラム |
| テンポ (Timer B) | 4分音符 = 48 clock → 480 PPQN、μs/四分 = 12288 × (256 − n) |
| @n (音色) | OPM68: ベロシティ / VOPM: プログラムチェンジ / GM: 推定した GM 音色 |
| v / @v / ( ) | OPM68: 制御ノート (プラグインがキャリア TL に加算) / VOPM: キャリア TL に焼き込んだ音色として切り替え / GM: CC7 (0.75dB/step を換算) |
| p | CC10 (p0 は CC11=0 でミュート) |
| D (デチューン) / _ (ポルタメント) / MP (ピッチ LFO) / MD (LFO ディレイ) | OPM68: 制御ノート (MIDI ノート 0〜14) / VOPM・GM: ピッチベンド (RPN で幅を設定、既定 ±12) |
| MA (音量 LFO, EB) | OPM68: 制御ノート / VOPM・GM: CC11 (エクスプレッション) |
| q / @q / & | ゲートタイム・タイ / スラー |
| L ループ, [ ]255 | 指定回数展開、任意で終端フェード (CC11) |

### OPM68 モード (`fmMode: 'opm68'` / CLI `--opm68`)

- MDX の FM 音色 (最大 127) を `.opm` バンクに書き出し、**ノートのベロシティ (1〜127 = スロット + 1) で音色を選びます**。DAW がプログラムチェンジや MIDI チャンネルを無視しても正しく鳴ります。
- 音量・ポルタメント・ディチューン・音程 LFO (MP)・音量 LFO (MA)・LFO ディレイ (MD)・テンポは、ピッチベンドや CC を使わず、ピアノロール最下部 (MIDI ノート 0〜14、MDX の最低音より下) の短い「制御ノート」で送ります。OPM68 が MXDRV 2.06 と同じ計算で 1 クロックごとに音程と音量を動かすため、DAW のピッチベンド間引きやピッチ幅設定に左右されません。制御ノートは消したり動かしたりしないでください。
- MXDRV 2.06 (portable_mdx) の OPM レジスタ書き込みとクロック単位で比べ、音程・音量とも 98〜100% 一致することを確認しています (`tools/mxverify`)。
- プラグインの導入・FL Studio での使い方・制御ノートの仕様は [plugin/opm68/README.md](plugin/opm68/README.md) を参照してください。
- FL Studio で制御ノートが低音として鳴る場合は古いプラグインが残っています。OPM68 の UI の版表記 (v0.6) を確認してください。v0.5 以降の MIDI は v0.4 以前のプラグインでは正しく鳴りません。
- フェードアウト (E7 / `fadeSeconds`) も制御ノート (FADE) で送ります (v0.6)。パンは CC10 のままです。
- v0.6 で MXDRV との一致度を上げました: 同じクロックの MP と MPON、タイ (&) で音程を変えるスラー (キーオンしない)、発音中の @、y コマンド (レジスタ直接書き込み、y$12 のテンポ)、制御パケットが溢れたときの遅れ補正、TL 0x80 以上のキャリア、CON 4 のキャリア判定。`tools/mxverify` で 395 曲中 97.6% の FM チャンネルが全クロック一致

### FL Studio プロジェクト (.flp) 出力 (v0.6)
- OPM68 モードでは `.flp` も作れます (Web UI の「.flp」ボタン / CLI `--flp テンプレート.flp`)。MIDI を読み込んでチャンネルごとに OPM68 へ差し替える手間がなくなります。
- テンプレート (`apps/web/public/opm68_template.flp`、FL Studio 2026 で作成) には OPM68 (CLAP) が 8 つ (FM A〜FM H) と sforzando (ADPCM) が入っています。変換器は Pattern 1 にノート・制御ノート・パン (チャンネルパンのイベント) を入れ、各 OPM68 のプラグイン状態に曲の `.opm` を埋め込み、テンポ・タイトル・プレイリスト上の長さを設定します。
- 自分のテンプレートも使えます (Web UI に `.flp` をドロップ)。条件: チャンネル名 `FM A`〜`FM H` (無ければ OPM68 のチャンネルを順に使用)、Pattern 1 がプレイリストに置かれていること。ADPCM は名前に `ADPCM` を含むチャンネルに入ります (SF2 は手動で読み込み)。
- 曲中でテンポが変わる曲は、FL のテンポを最初の値に固定し、ノート位置を実時間に合わせて配置します (PPQ 960)。OPM68 は制御ノートのテンポ情報で LFO などを刻むので音は変わりません。
- パン p0 (発音オフ) は .flp では表現できないため無視します。

### VOPM モード (`fmMode: 'vopm'` / CLI `--vopm`)

- MDX の FM 音色を VOPM / MiOPMdrv 形式の `.opm` バンク (128 スロット) に書き出し、プログラムチェンジで切り替えます。オペレータは `.opm` の M1, C1, M2, C2 順に並べ替えます。
- 曲中で最初に出てくる OPM ハード LFO 設定 (EA) を各音色の `LFO:` / `CH: AMS PMS` に書き込みます。
- 音量はキャリアの TL に加算した音色として焼き込みます。(音色, 音量) の組が 128 を超える曲は FM チャンネルごとに `.opm` を出力します。`volumeMode: 'cc7' | 'velocity'` も選べます。
- VOPM の癖への対策: OPM クロックを 4MHz に設定・内蔵ローパスを無効化 (NRPN)、MUL=0 の音色は MUL を倍にして 1 オクターブ下げる、冒頭に 1 小節の無音を入れる。
- FL Studio では VOPM のプログラムチェンジ・MIDI ch の扱いに問題が多いため、OPM68 モードを推奨します。

### 主なオプション (`ConvertOptions`)

`loops` (既定 2) / `fadeSeconds` / `fmMode` (`'gm' | 'vopm' | 'opm68'`) / `pcmMode` (`'sf2' | 'gm'`) / `volumeMode` (`'bake' | 'cc7' | 'velocity'`) / `bendRange` / `leadInBeats` / `programMap` / `drumMap` など。詳細は `packages/core/src/convert.ts` を参照。

## 既知の制限

- LZX 圧縮 MDX は未対応
- 0xE0–0xE6 は MXDRV 2.06 では未定義で、MXDRV と同じくそのチャンネルを終了します (別ドライバ向けの曲、例: あにまーじゃん V3 は MXDRV でも無音になります)
- GM モードの FM 音色は近似
- ブラウザ内試聴は未実装 (ymfm の WASM 化を予定)

## ライセンス・クレジット

- OPM68 は [ymfm](https://github.com/aaronsgiles/ymfm) (BSD-3-Clause, Aaron Giles) と [DPF](https://github.com/DISTRHO/DPF) (ISC) を使用しています。
