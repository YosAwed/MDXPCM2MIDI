# MDXPCM2MIDI

X68000 の MDX (MXDRV) ファイルを、今の DAW で鳴らせる形に変換するツールです。

- **FL Studio のプロジェクト (.flp)** をそのまま出力できます。開くだけで、同梱の YM2151 プラグイン **OPM68** が X68000 とほぼ同じ音色・音程で鳴ります
- Standard MIDI File (.mid) + 音色バンク (.opm) も出力できるので、他の DAW でも OPM68 で鳴らせます
- PDX を一緒に読み込むと、ADPCM パートを原音のサンプルで鳴らします (WAV + FL 標準 Sampler、または SoundFont)
- 変換はすべて手元 (ブラウザ内の Web Worker、または Node の CLI) で行います。ファイルをサーバへ送ることはありません

現在のバージョン: **v0.6.4** (OPM68 0.6.4) — [リリース一覧](https://github.com/YosAwed/MDXPCM2MIDI/releases)

## 目次

1. [導入](#導入)
2. [変換する](#変換する)
3. [FL Studio で鳴らす](#fl-studio-で鳴らす)
4. [他の DAW で鳴らす](#他の-daw-で鳴らす)
5. [OPM68 プラグイン](#opm68-プラグイン)
6. [変換仕様](#変換仕様)
7. [開発](#開発)
8. [既知の制限](#既知の制限)
9. [ライセンス・クレジット](#ライセンスクレジット)

## 導入

### 1. OPM68 プラグインを入れる (Windows)

1. [リリース](https://github.com/YosAwed/MDXPCM2MIDI/releases) から最新の `OPM68-x.y.z-win64.zip` をダウンロードして展開します
2. DAW を閉じてから、次の場所にコピー (上書き) します
   - `OPM68.clap` → `C:\Program Files\Common Files\CLAP\`
   - `OPM68.vst3` (フォルダごと) → `C:\Program Files\Common Files\VST3\`
3. DAW を起動し、プラグインの再スキャンをします (FL Studio: Options → Manage plugins → Find installed plugins)
4. OPM68 の画面上部の版表記 (例: `v0.6.4`) が、ダウンロードした版と同じことを確かめます

Linux は `OPM68-x.y.z-linux-x86_64.zip` を展開し、`OPM68.clap` を `~/.clap/`、`OPM68.vst3` を `~/.vst3/` に置きます。

> 変換器とプラグインは同じ版のものを使ってください。古いプラグインでは、新しい変換器の出力 (y コマンド、ハード LFO など) が正しく鳴りません。

### 2. 変換器を用意する

**CLI (Node)**: Node.js 22 以降と pnpm 10 が必要です。

```sh
git clone https://github.com/YosAwed/MDXPCM2MIDI.git
cd MDXPCM2MIDI
pnpm install
pnpm --filter @mdxpcm2midi/core build    # packages/core/dist/cli.mjs ができる
```

**Web 版**: Cloudflare Pages で公開する準備中です。手元では `pnpm dev` で起動できます (http://localhost:5173)。

## 変換する

### CLI

```sh
node packages/core/dist/cli.mjs song.mdx --flp apps/web/public/opm68_template.flp --loops 2 --fade 8
```

PDX は MDX に書かれた名前を元に、同じフォルダ・`../PDX`・親フォルダから自動で探します (`-p song.pdx` で指定も可)。

| オプション | 内容 |
|---|---|
| `--flp テンプレート.flp` | FL Studio プロジェクト (1 パターン形式) を出力。FM は OPM68 モードになる |
| `--flp-arrange テンプレート.flp` | FL Studio プロジェクト (アレンジ形式) を出力。ADPCM は WAV + FL 標準 Sampler |
| `--sample-root DIR` | アレンジ形式で .flp に書く WAV のパスの頭 (既定: 出力先の絶対パス)。`.` で `曲名_samples\xx.wav` の相対パス |
| `--opm68` / `--vopm` / `--gm` | FM 音色モード (CLI の既定は GM 近似。`--flp` 系を付けると OPM68) |
| `--loops N` | ループを何回演奏するか (既定 2) |
| `--fade 秒` | ループする曲の終わりにフェードアウトを付ける |
| `-p file.pdx` / `--no-pdx` | PDX を指定 / 使わない (ADPCM は GM ドラムになる) |
| `-o out.mid` | 出力先 (既定: MDX と同じ場所・同じ名前) |
| `--json` | 曲の情報を JSON で表示するだけ (ファイルは書かない) |

出力されるファイル (`song.mdx` の場合):

| ファイル | 内容 |
|---|---|
| `song.mid` | Standard MIDI File (format 1, 480 PPQN) |
| `song.opm` | 音色バンク (OPM68 / VOPM)。(音色×音量) が 128 を超える曲は `song_chA.opm` 〜 のチャンネル別 |
| `song.sf2` | ADPCM のサンプルの SoundFont (PDX があるとき) |
| `song.flp` | `--flp` のとき。FL Studio プロジェクト (1 パターン形式) |
| `song_arrange.flp` + `song_samples\*.wav` | `--flp-arrange` のとき。FL Studio プロジェクト (アレンジ形式) |
| `song_report.md` | チャンネルごとの音色の使われ方のレポート |

### Web 版

MDX と PDX をまとめてドロップすると変換されます。FM 音色モードの既定は OPM68 です。曲ごとに `.mid` / `.flp` / `.sf2` / `.opm` / レポートのボタンが出て、「ZIP でまとめてダウンロード」で一括ダウンロードできます。自分の FL Studio テンプレート (.flp) をドロップすると、それを使って .flp を作ります。

アレンジ形式の .flp は今のところ CLI だけです (Web 版は .flp と WAV をまとめた zip で対応予定)。

## FL Studio で鳴らす

### 1 パターン形式 (`--flp`)

`song.flp` を開くだけで鳴ります。.flp は OPM68 の **CLAP 版**を使うので、`OPM68.clap` を入れておいてください (アレンジ形式も同じ)。

- チャンネルラックに OPM68 が 8 つ (FM A〜FM H) 入っていて、曲の音色バンクが埋め込まれ、Mono が ON になっています
- 曲のノートは Pattern 1 にすべて入っています
- ADPCM は「ADPCM」チャンネル (sforzando) に入っています。`song.sf2` を sforzando に手動で読み込んでください

### アレンジ形式 (`--flp-arrange`)

`song_arrange.flp` を開くだけで鳴ります。`song_samples` フォルダは .flp と一緒に置いたままにしてください。

- **FM**: OPM68 は 1 パターン形式と同じく MDX のチャンネルごとに 1 つです。プレイリストのトラックが「チャンネル + 音色」ごと (例: `FM E @3`) に分かれ、その上にフレーズ単位のクリップが並びます (1 小節以上の休符とループ点で区切り)。中身が同じクリップは同じパターンを共有するので、繰り返しがひと目で分かります
- **ADPCM**: 使われた PDX サンプルごとに WAV を書き出し、FL 標準の Sampler で鳴らします (sforzando と SF2 の手動読み込みは不要)。サンプルごとにチャンネルとトラックが 1 本ずつです
- 元の位置のままなら、FM は 1 パターン形式とまったく同じに鳴ります (`scripts/flp_compare.py` で確認)
- クリップを動かしたりコピーしたりすると、音量・LFO などの状態が移動先とずれて音が変わることがあります。詳しくは [docs/flp-arrange.md](docs/flp-arrange.md)

### 共通の注意

- ピアノロール最下部 (MIDI ノート 0〜14) の短いノートは、OPM68 への「制御ノート」です (音量・ポルタメント・LFO などを送るもの)。消したり動かしたりしないでください
- 曲中でテンポが変わる曲は、FL のテンポを最初の値に固定し、ノートを実際の時間に合わせて並べます (PPQ 960)。音は合っていますが、小節線とはそろいません
- パン p0 (発音オフ) は .flp では表せないため無視します
- テンプレートは `apps/web/public/opm68_template.flp` (FL Studio 2026 で作成)。自分のテンプレートを使う場合は、チャンネル名を `FM A`〜`FM H` にし (無ければ OPM68 のチャンネルを順に使用)、Pattern 1 をプレイリストに置いて保存してください

## 他の DAW で鳴らす

1. `--opm68` (Web 版の既定) で変換し、`song.mid` と `song.opm` を作ります
2. `song.mid` を読み込み、FM A〜H (MIDI ch1〜8) のトラックにそれぞれ OPM68 を立ち上げます
3. 各 OPM68 で「Load .OPM...」から `song.opm` を読み込みます (全チャンネル共通。`song_chA.opm` 〜 が出た曲は同じ文字のチャンネルへ)
4. 各 OPM68 の **Mono を ON** にします (MDX の 1 チャンネル = OPM の 1 チャンネル。次のキーオンで前の音のリリースが切れる)
5. ADPCM (MIDI ch10、PCM8 の曲は ch9, 11〜16) は `song.sf2` を SoundFont プレーヤーで鳴らします

音色はノートのベロシティ (1〜127 = バンクのスロット 0〜126) で選ぶので、DAW がプログラムチェンジや MIDI チャンネルを無視しても正しく切り替わります。

VOPM / VOPMex で鳴らす場合は `--vopm` で変換し、8 インスタンスを MIDI ch1〜8 に割り当てます (プログラムチェンジで音色切り替え)。GM 音源向けには `--gm` (FM 音色は OPM パラメータから推定した近似) を使います。

## OPM68 プラグイン

YM2151 を X68000 と同じ 4MHz で動かすプラグインです (VST3 / CLAP、Windows / Linux)。音源コアは ymfm です。

| 画面のボタン | 既定 | 内容 |
|---|---|---|
| Load .OPM... | — | 音色バンクを読み込む (プロジェクトに保存される。.flp には変換器が埋め込み済み) |
| Vel=Voice | ON | ノートのベロシティで音色を選ぶ |
| Mono | OFF (.flp は ON) | MDX の変換結果は ON で鳴らす |
| Clock | 4MHz | X68000 は 4MHz (3.58MHz にも切り替え可) |
| X68 Low-pass | ON | X68000 の出力段にあたるローパス。MXDRV と同じく 5 kHz より上を丸める。OFF にすると明るい音になる (0.6.3 以前と同じ) |
| Low cut | OFF | 実機のカップリングコンデンサによる低域の減衰を模したもの (OFF → 70 Hz → 110 Hz) |

MXDRV のドライバ処理 (ポルタメント、ディチューン、ソフトウェア LFO、LFO ディレイ、音量、フェード、スラー、発音中の @、y コマンド、ハード LFO) をプラグインの中で MXDRV 2.06 と同じクロック単位の計算で再現します。MXDRV 2.06 (portable_mdx) の OPM レジスタ書き込みとクロック単位で比べ、無作為に選んだ 395 曲・2,607 FM チャンネルで 97.6% が音程・全オペレータ TL とも全クロック一致しています (`tools/mxverify`)。

詳しい仕様・制御ノートの形式・変更履歴・ビルド方法は [plugin/opm68/README.md](plugin/opm68/README.md) を参照してください。

## 変換仕様

| MDX | MIDI / .flp |
|---|---|
| FM A–H | ch1–8 (.flp: OPM68 ×8) |
| ADPCM P (PCM8: P–W) | SF2: ch10 (bank128 ドラムキット) と ch9, 11–16 (bank127/prog0)。GM: ch10 の GM ドラム。アレンジ形式 .flp: サンプルごとの Sampler |
| テンポ (Timer B) | 4分音符 = 48 clock → 480 PPQN、μs/四分 = 12288 × (256 − n) |
| @n (音色) | OPM68: ベロシティ / VOPM: プログラムチェンジ / GM: 推定した GM 音色 |
| v / @v / ( ) | OPM68: 制御ノート / VOPM: キャリア TL に焼き込んだ音色として切り替え / GM: CC7 (0.75dB/step を換算) |
| p | CC10 (p0 は CC11=0 でミュート)。.flp はチャンネルパンのイベント |
| D / _ / MP / MD / MA | OPM68: 制御ノート / VOPM・GM: ピッチベンド (RPN で幅を設定、既定 ±12)・CC11 |
| y (レジスタ直接書き込み)、EA / MHON / MHOF (ハード LFO) | OPM68: 制御ノート (チップ共通のレジスタは全 FM チャンネルの OPM68 へ) |
| q / @q / & | ゲートタイム・タイ / スラー (音程を変えるタイはキーオンしない) |
| L ループ, [ ]n | 指定回数展開。任意で終端フェード (OPM68: 制御ノート / 他: CC11) |
| LZX 圧縮 MDX | 展開してから変換 (LZX 0.32 / 0.42) |

主な変換オプション (`ConvertOptions`、`packages/core/src/convert.ts`): `loops` (既定 2) / `fadeSeconds` / `fmMode` (`'gm' | 'vopm' | 'opm68'`) / `pcmMode` (`'sf2' | 'gm'`) / `volumeMode` / `bendRange` / `leadInBeats` / `programMap` / `drumMap` など。

VOPM モードの補足: 曲中で最初のハード LFO 設定 (EA) を各音色に書き込み、音量はキャリア TL に焼き込みます。OPM クロック 4MHz・内蔵ローパス無効 (NRPN)、MUL=0 の音色は MUL を倍にして 1 オクターブ下げる、冒頭に 1 小節の無音を入れる、といった VOPM 向けの対策をしています。FL Studio では VOPM の扱いに問題が多いため、OPM68 を推奨します。

## 開発

```
packages/core       変換コア (TypeScript, 依存なし)
  src/mdx.ts          MDX ヘッダ・音色・チャンネル解析 (9ch / PCM8 16ch)
  src/lzx.ts          LZX 圧縮 MDX の展開
  src/sequencer.ts    仮想 MXDRV シーケンサ (リピート・ループ・同期・テンポ・ポルタメント/LFO)
  src/convert.ts      シーケンサ出力 → SMF (format 1, 480 PPQN)
  src/opm68ctl.ts     OPM68 制御ノート (パケット) の形式
  src/opm.ts          .opm 音色バンクのライタ
  src/flp.ts          FL Studio プロジェクトの読み書き・1 パターン形式
  src/flp-arrange.ts  FL Studio プロジェクトのアレンジ形式 (クリップ分割、WAV + Sampler)
  src/gm.ts           OPM 音色 → GM 音色の推定
  src/pdx.ts          PDX 解析・MSM6258 ADPCM / PCM8 16bit・8bit 復号
  src/sf2.ts          SoundFont 2 ライタ
  src/report.ts       チャンネル別音色レポート
  src/cli.ts          Node CLI (mdx2mid)
apps/web            Vite 製の静的サイト (Cloudflare Pages で配信予定)
plugin/opm68        YM2151 プラグイン OPM68 (ymfm + DPF)
tools/mxverify      OPM68 と MXDRV 2.06 (portable_mdx) のレジスタ比較
tools/opmrender     ymfm で .mid + .opm を描画する開発用の試聴ツール
scripts/corpus.ts   大量の MDX を一括変換してエラーを集計するテストランナー
scripts/featscan.ts 曲ごとの MXDRV コマンド使用回数のスキャナ (テスト曲選び用)
scripts/flp_compare.py  アレンジ形式 .flp を展開して 1 パターン形式と比較
docs/flp-arrange.md アレンジ形式の設計メモ
```

```sh
pnpm install
pnpm test                      # ユニットテスト (vitest)
pnpm dev                       # Web 版 (http://localhost:5173)
pnpm build                     # apps/web/dist と packages/core/dist/cli.mjs を生成
```

コーパステスト (手元の MDX 群で実行。MDX/PDX は著作物のためリポジトリには含めません):

```sh
npx esbuild scripts/corpus.ts --bundle --platform=node --format=esm --outfile=corpus.mjs
node corpus.mjs list D:/X68000/MDX list.txt
node corpus.mjs run list.txt out.jsonl 600     # 600 秒ごとに再開可能
node corpus.mjs summary out.jsonl
```

26,012 曲中 26,007 曲 (99.98%) が変換に成功しています (失敗はヘッダ異常 5 曲)。

## 既知の制限

- 0xE0–0xE6 は MXDRV 2.06 では未定義で、MXDRV と同じくそのチャンネルを終了します (別ドライバ向けの曲は MXDRV でも無音になります)
- MXDRV と一致しない残りのケース: 別チャンネルの KF を y コマンドで書き換える曲、PCM8 との同期待ちを使う曲など
- アレンジ形式の .flp でクリップを移動・コピーすると、音が元と変わることがある (自由に動かせるモードは検討中)
- GM モードの FM 音色は近似
- ブラウザ内での試聴は未実装 (ymfm の WASM 化を予定)

## ライセンス・クレジット

- OPM68 は [ymfm](https://github.com/aaronsgiles/ymfm) (BSD-3-Clause, Aaron Giles) と [DPF](https://github.com/DISTRHO/DPF) (ISC) を使用しています
- MXDRV との比較には [portable_mdx](https://github.com/yosshin4004/portable_mdx) を使用しています (リポジトリには含めていません)
