# OPM68 — YM2151 (OPM) instrument plugin (VST3 / CLAP)

MDXPCM2MIDI の出力を X68000 と同じ YM2151 で鳴らすためのプラグインです。音源コアは [ymfm](https://github.com/aaronsgiles/ymfm) (BSD-3)、プラグイン枠組みは [DPF](https://github.com/DISTRHO/DPF) (ISC)。

## 特徴
- YM2151 を 4MHz (X68000) で動作。MUL=0 (×0.5)・DT2・LFO・ノイズも実機どおり
- MXDRV と同じ音程 (MIDI ノート − 15 = MDX ノート、KF+5) と音量計算 (キャリア TL に減衰を加算)
- **ノートのベロシティ 1〜127 で音色 (バンクのスロット 0〜126) を選ぶ**モード (既定 ON)。DAW がプログラムチェンジや MIDI チャンネルを捨てても音色が正しく切り替わる
- **MXDRV のドライバ処理を内蔵**: ポルタメント、ディチューン、ソフトウェア LFO (EC 音程 / EB 音量)、LFO ディレイ (E9)、音量、フェードアウト、タイ (&) で音程を変えるスラー、発音中の音色変更 (@)、レジスタ直接書き込み (y) を、MXDRV 2.06 と同じクロック単位の計算で再現 (下記「制御ノート」)
- ベロシティは DAW から届いた値をそのまま復元 (FL Studio は値/128 で渡すため、DPF の既定の ×127 丸めでは 65 以上が 1 ずれる。`dpf-velocity.patch` で対応)
- MIDI チャンネルは無視 (どのチャンネルのノートも同じように鳴る)
- CC7 / CC11 は MXDRV の音量カーブ (0.75dB/step) として TL に反映、CC10 パン、ピッチベンド (RPN でレンジ指定、既定 ±12)
- 1 インスタンスで最大 8 音ポリ (Mono スイッチあり)。MDX の変換結果を鳴らすときは **Mono: ON** (実機と同じく次のキーオンで前の音のリリースが切れる。OFF だと RR の小さい音色で前の音が鳴り残る)。変換器が出す .flp は自動で ON
- **X68 Low-pass** (既定 ON): X68000 の出力段にあたるローパス。MXDRV (portable_mdx / x68sound) との周波数特性の差 (4 曲の平均) に合わせたもので、2.5 kHz 付近から下がり始め、-3 dB が約 5.5 kHz、20 kHz で約 -13 dB。ON で 1〜20 kHz の差が約 ±1 dB に収まる (OFF では 20 kHz で +13 dB 明るい)。FM ドラムのアタックの「カチッ」というクリック感が実機に近くなる
- **Low cut** (既定 OFF、ボタンで OFF → 70 Hz → 110 Hz): カップリングコンデンサによる低域の減衰を模した 1 次ハイパス。MXDRV (x68sound) には無い特性なので既定は OFF。70 Hz は状態のよい実機、110 Hz は容量が抜けた実機のつもりの目安
- バンク (.opm) はプロジェクトに保存されます

## 導入
- Windows: `OPM68.clap` を `C:\Program Files\Common Files\CLAP\`、`OPM68.vst3` (フォルダごと) を `C:\Program Files\Common Files\VST3\` にコピー (DAW を閉じてから上書き)
- Linux: `OPM68.clap` を `~/.clap/`、`OPM68.vst3` を `~/.vst3/` に置く
- macOS (Apple Silicon / Intel 共通、macOS 11 以降): `OPM68.clap` を `~/Library/Audio/Plug-Ins/CLAP/`、`OPM68.vst3` を `~/Library/Audio/Plug-Ins/VST3/`、`OPM68.component` (AU、Logic / GarageBand 用) を `~/Library/Audio/Plug-Ins/Components/` に置く。公証していないため、ダウンロードした zip から入れた場合は `xattr -dr com.apple.quarantine ~/Library/Audio/Plug-Ins/{CLAP/OPM68.clap,VST3/OPM68.vst3,Components/OPM68.component}` で隔離属性を外す
- 画面上部の版表記で、入っている版を確認できます。変換器と同じ版を使ってください

## 使い方
- **FL Studio**: 変換器の `.flp` 出力 (`--flp` / `--flp-arrange`、Web 版の「.flp」) を開くだけです。CLAP 版の OPM68 が 8 つ並び、音色バンクの埋め込みと Mono ON まで済んでいます
- **その他の DAW**: OPM68 モードで変換した `.mid` を読み込み、FM A〜H (MIDI ch1〜8) のトラックそれぞれに OPM68 を立ち上げて、「Load .OPM...」で `.opm` を読み込み、Mono を ON にします。ADPCM は `.sf2` を SoundFont プレーヤーで鳴らします
- 詳しくはリポジトリ直下の [README](../../README.md) を参照

## 制御ノート
DAW (FL Studio など) はピッチベンドやオートメーションをバッファ単位で間引き、ピッチ幅の設定でも拡大縮小してしまうため、MXDRV の速いポルタメントや LFO が崩れます。
そこで変換器は OPM68 モードでピッチベンドを使わず、MXDRV がチャンネルごとに持っている状態 (ポルタメント・ディチューン・音程 LFO・音量 LFO・LFO ディレイ・音量・テンポ) を、
MDX のコマンドと同じ位置に置いた短い「制御ノート」で送ります。OPM68 はこれを発音せず、MXDRV 2.06 と同じ計算 (1 クロックごとの状態更新) で音程と音量を動かします。
ノートはサンプル単位で正確に届くので、DAW の設定に左右されません。

- 制御ノートは **MIDI ノート 0〜14** (ピアノロール最下部)。MDX の最低音は MIDI 15 (o0 d+) なので、曲の音とは重なりません
- ある時刻・あるチャンネルの制御データを 1 つの「パケット」にまとめ、i バイト目をノート i のベロシティ−1 で表します。形式は `packages/core/src/opm68ctl.ts` の先頭を参照
- 収まらない分は次のクロックに回し、「何クロック前の分か」をヘッダに入れます。OPM68 はその分さかのぼって LFO・ディレイを適用します (曲頭で多くの設定が重なったときだけ)
- この短いノートは消したり動かしたりしないでください

実機相当との比較 (`tools/mxverify`): [portable_mdx](https://github.com/yosshin4004/portable_mdx) (MXDRV 2.06 の移植) の OPM レジスタ書き込みと、OPM68 の音程 (KC/KF) と 4 オペレータすべての TL を MDX クロックごとに突き合わせています。
コーパスから無作為に選んだ 395 曲・2,607 FM チャンネル (各 15 秒, v0.6) で、97.6% のチャンネルが音程・4 オペレータ TL とも全クロック一致、99.1% が 5% 以内でした。残る差は、別チャンネルのレジスタを y コマンドで書き換える曲、PCM8 との同期待ちを使う曲などです。

## 変更履歴
- 0.6.4: X68000 出力ローパス (X68 Low-pass、既定 ON) と Low cut (既定 OFF) を追加。これまでの OPM68 は 5 kHz より上が MXDRV より強く (20 kHz で約 +13 dB)、FM ドラムのアタックがクリック状に目立っていた。古いプロジェクトも開くと ON になる (OFF にすれば 0.6.3 と同じ音)
- 0.6.3: .flp に埋め込まれたバンク (ディスク上にファイルが無い) でも画面に音色一覧と音色数を表示 (これまでは「0 voices」と表示されていた。音は 0.6.2 でも正しい)
- 0.6.2: OPM ハード LFO (EA / MHON / MHOF) を MXDRV どおりに再現するための変更。@ (音色変更) で PMS/AMS ($38+ch) を消さない (MXDRV の @ は書かない)、LFO リセット ($01 bit1) を 1 サンプルのパルスとして扱う。0.6.1 以降の変換器の出力は 0.6.2 で鳴らしてください
- 0.6.0: .flp 出力対応、FADE、CON 4 キャリア修正、FL のベロシティ復元、スラー / 発音中の @ / y コマンド / 遅れ補正

## ビルド
```sh
git clone --recursive https://github.com/DISTRHO/DPF.git ../DPF
git -C ../DPF apply "$PWD/dpf-velocity.patch"   # FL Studio のベロシティ (値/128) を正確に復元する
make                                   # Linux
make all au CFLAGS="-arch arm64 -arch x86_64" CXXFLAGS="-arch arm64 -arch x86_64" LDFLAGS="-arch arm64 -arch x86_64"   # macOS (universal、AU も)
for b in bin/OPM68.{clap,vst3,component}; do codesign --force --deep -s - "$b"; done                                    # macOS (ad-hoc 署名)
make WINDOWS=true CC=x86_64-w64-mingw32-gcc-posix CXX=x86_64-w64-mingw32-g++-posix \
     DPF_TARGET_DIR=bin-win DPF_BUILD_DIR=build-win   # Windows (mingw-w64)
```
`test/render.cpp` はエンジン単体のオフライン描画、`test/clap_smoke.cpp` は CLAP 版を読み込んで鳴らす簡易ホストです。
