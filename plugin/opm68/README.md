# OPM68 — YM2151 (OPM) instrument plugin (VST3 / CLAP)

MDXPCM2MIDI の出力を X68000 と同じ YM2151 で鳴らすためのプラグインです。音源コアは [ymfm](https://github.com/aaronsgiles/ymfm) (BSD-3)、プラグイン枠組みは [DPF](https://github.com/DISTRHO/DPF) (ISC)。

## 特徴
- YM2151 を 4MHz (X68000) で動作。MUL=0 (×0.5)・DT2・LFO・ノイズも実機どおり
- MXDRV と同じ音程 (MIDI ノート − 15 = MDX ノート、KF+5) と音量計算 (キャリア TL に減衰を加算)
- **ノートのベロシティ 1〜127 で音色 (バンクのスロット 0〜126) を選ぶ**モード (既定 ON)。DAW がプログラムチェンジや MIDI チャンネルを捨てても音色・音量が正しく切り替わる
- MIDI チャンネルは無視 (どのチャンネルのノートも同じように鳴る)
- CC7 / CC11 は MXDRV の音量カーブ (0.75dB/step) として TL に反映、CC10 パン、ピッチベンド (RPN でレンジ指定、既定 ±12)
- 1 インスタンスで最大 8 音ポリ (Mono スイッチあり)
- バンク (.opm) はプロジェクトに保存されます

## 使い方 (FL Studio)
1. `OPM68.vst3` を `C:\Program Files\Common Files\VST3\` に、`OPM68.clap` を `C:\Program Files\Common Files\CLAP\` にコピー
2. MDXPCM2MIDI で「FM 音色: OPM68 プラグイン用」を選んで変換 (`.mid` / `.opm` / `.sf2`)
3. `.mid` を読み込み、FM 8 チャンネルそれぞれの音源を OPM68 に差し替え、「Load .OPM...」で `.opm` を読み込む
4. ADPCM (ch10) は `.sf2` を SoundFont プレーヤーで鳴らす

## 音程の制御ノート
DAW (FL Studio など) はピッチベンドをバッファ単位で間引き、さらにチャンネルのピッチ幅で拡大縮小して渡すため、MXDRV の速いポルタメントやビブラートが崩れます。
そこで変換器は OPM68 モードでピッチベンドを使わず、ポルタメント・ディチューン・ピッチ LFO (ビブラート) を、MDX のコマンドと同じ位置に置いた短い「制御ノート」(ピアノロール最下部、MIDI ノート 0〜11) で送ります。
OPM68 はこれを発音せず、音程の動きを自分で計算します。ノートはサンプル単位で正確に届くので、DAW の設定に左右されません。

| ノート | 内容 |
|---|---|
| 0, 1 | ポルタメント速度 (14bit, (v−8064)/32 半音/秒) |
| 2, 3 | ディチューン ((v−8064)/64 半音) |
| 4 | ピッチ LFO 波形 (0 オフ / 1 のこぎり / 2 矩形 / 3 三角) |
| 5, 6 / 7, 8 / 9, 10 | LFO 周期 (v/2 ms) / 深さ ((v−8064)/256 半音) / ディレイ (v/2 ms) |
| 11 | タイ: 鳴っている音のポルタメントと LFO を掛け直す |

値はベロシティ−1 (0〜126)。2 つ組は上位×127+下位。ピアノロール最下部のこの短いノートは消したり動かしたりしないでください。

## ビルド
```sh
git clone --recursive https://github.com/DISTRHO/DPF.git ../DPF
make                                   # Linux
make WINDOWS=true CC=x86_64-w64-mingw32-gcc-posix CXX=x86_64-w64-mingw32-g++-posix \
     DPF_TARGET_DIR=bin-win DPF_BUILD_DIR=build-win   # Windows (mingw-w64)
```
`test/render.cpp` はエンジン単体のオフライン描画、`test/clap_smoke.cpp` は CLAP 版を読み込んで鳴らす簡易ホストです。
