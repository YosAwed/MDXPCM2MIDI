# OPM68 — YM2151 (OPM) instrument plugin (VST3 / CLAP)

MDXPCM2MIDI の出力を X68000 と同じ YM2151 で鳴らすためのプラグインです。音源コアは [ymfm](https://github.com/aaronsgiles/ymfm) (BSD-3)、プラグイン枠組みは [DPF](https://github.com/DISTRHO/DPF) (ISC)。

## 特徴
- YM2151 を 4MHz (X68000) で動作。MUL=0 (×0.5)・DT2・LFO・ノイズも実機どおり
- MXDRV と同じ音程 (MIDI ノート − 15 = MDX ノート、KF+5) と音量計算 (キャリア TL に減衰を加算)
- **ノートのベロシティ 1〜127 で音色 (バンクのスロット 0〜126) を選ぶ**モード (既定 ON)。DAW がプログラムチェンジや MIDI チャンネルを捨てても音色が正しく切り替わる
- **MXDRV のドライバ処理を内蔵**: ポルタメント、ディチューン、ソフトウェア LFO (EC 音程 / EB 音量)、LFO ディレイ (E9)、音量を、MXDRV 2.06 と同じクロック単位の計算で再現 (下記「制御ノート」)
- ベロシティは DAW から届いた値をそのまま復元 (FL Studio は値/128 で渡すため、DPF の既定の ×127 丸めでは 65 以上が 1 ずれる。`dpf-velocity.patch` で対応)
- MIDI チャンネルは無視 (どのチャンネルのノートも同じように鳴る)
- CC7 / CC11 は MXDRV の音量カーブ (0.75dB/step) として TL に反映、CC10 パン、ピッチベンド (RPN でレンジ指定、既定 ±12)
- 1 インスタンスで最大 8 音ポリ (Mono スイッチあり)
- バンク (.opm) はプロジェクトに保存されます

## 使い方 (FL Studio)
1. `OPM68.vst3` を `C:\Program Files\Common Files\VST3\` に、`OPM68.clap` を `C:\Program Files\Common Files\CLAP\` にコピー
2. MDXPCM2MIDI で「FM 音色: OPM68 プラグイン用」を選んで変換 (`.mid` / `.opm` / `.sf2`)
3. `.mid` を読み込み、FM 8 チャンネルそれぞれの音源を OPM68 に差し替え、「Load .OPM...」で `.opm` を読み込む
4. ADPCM (ch10) は `.sf2` を SoundFont プレーヤーで鳴らす

## 制御ノート
DAW (FL Studio など) はピッチベンドやオートメーションをバッファ単位で間引き、ピッチ幅の設定でも拡大縮小してしまうため、MXDRV の速いポルタメントや LFO が崩れます。
そこで変換器は OPM68 モードでピッチベンドを使わず、MXDRV がチャンネルごとに持っている状態 (ポルタメント・ディチューン・音程 LFO・音量 LFO・LFO ディレイ・音量・テンポ) を、
MDX のコマンドと同じ位置に置いた短い「制御ノート」で送ります。OPM68 はこれを発音せず、MXDRV 2.06 と同じ計算 (1 クロックごとの状態更新) で音程と音量を動かします。
ノートはサンプル単位で正確に届くので、DAW の設定に左右されません。

- 制御ノートは **MIDI ノート 0〜14** (ピアノロール最下部)。MDX の最低音は MIDI 15 (o0 d+) なので、曲の音とは重なりません
- ある時刻・あるチャンネルの制御データを 1 つの「パケット」にまとめ、i バイト目をノート i のベロシティ−1 で表します。形式は `packages/core/src/opm68ctl.ts` の先頭を参照
- 収まらない分は次のクロックに回します (曲頭で多くの設定が重なったときだけ)
- この短いノートは消したり動かしたりしないでください

実機相当との比較: [portable_mdx](https://github.com/yosshin4004/portable_mdx) (MXDRV 2.06 の移植) の OPM レジスタ書き込みと、OPM68 の音程 (KC/KF) と音量 (キャリア TL) をクロック単位で突き合わせ、
bos06 / bos14 / Knight Arms / Star Cruiser などで 98〜100% 一致することを確認しています (差はクロック境界の時刻の丸め程度)。

## ビルド
```sh
git clone --recursive https://github.com/DISTRHO/DPF.git ../DPF
git -C ../DPF apply "$PWD/dpf-velocity.patch"   # FL Studio のベロシティ (値/128) を正確に復元する
make                                   # Linux
make WINDOWS=true CC=x86_64-w64-mingw32-gcc-posix CXX=x86_64-w64-mingw32-g++-posix \
     DPF_TARGET_DIR=bin-win DPF_BUILD_DIR=build-win   # Windows (mingw-w64)
```
`test/render.cpp` はエンジン単体のオフライン描画、`test/clap_smoke.cpp` は CLAP 版を読み込んで鳴らす簡易ホストです。
