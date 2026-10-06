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
OPM68 は、MXDRV のチャンネルごとのドライバ状態 (ポルタメント、デチューン、ソフト LFO、音量、クロック長など) を、**MIDI CC ではなく、発音しない MIDI ノートのベロシティ**で受け取ります。
DAW (FL Studio など) はピッチベンドやオートメーションをバッファ単位で間引き、ピッチベンド幅の設定で拡大縮小もしてしまうので、MXDRV の速いポルタメントや LFO が崩れます。ノートならサンプル単位で正確に届くため、OPM68 が MXDRV 2.06 と同じ計算で、1 クロックごとに音程と音量を動かせます。

実装: エンコーダ [`packages/core/src/opm68ctl.ts`](../../packages/core/src/opm68ctl.ts)、デコーダ [`plugin/opm68/OpmEngine.hpp`](OpmEngine.hpp)

### キーの使い分け

| MIDI ノート番号 | 用途 |
|---|---|
| 0〜14 | **制御ノート**。OPM68 はこのキーを発音せず、データとして読みます |
| 15 以上 | 通常のノート。MDX の最低音 (o0 d+) が 15 なので、音楽のノートとは重なりません |

- 制御ノートは変換器 ([MDXPCM2MIDI](../../README.md)) が OPM68 モードで自動的に出力します。手で書く必要はありません。
- **OPM68 以外の音源で .mid を鳴らすときは、ノート 0〜14 を削除またはミュートしてください。** そのままだと最低音域のノートとして鳴ります。
- 制御ノートには、移調・クオンタイズ・ベロシティのスケーリングやヒューマナイズをかけないでください。データが壊れます。

### パケット

1 チャンネル・1 MDX クロック分の制御データが 1 つのパケットです。パケットの *i* バイト目を、ノート *i* のノートオンで送ります。

- バイト値 = ベロシティ − 1 (7 bit。ベロシティ 1〜127 が値 0〜126)
- **byte 0 (ヘッダ)**
  - bit 0〜3: パケット長 − 1 (パケット長は 1〜15 バイト)
  - bit 4〜6: late (0〜6)。そのクロックで入りきらなかったため、後送りしたアイテムであることを示します。値は、本来のクロックから何クロック遅れたかです
- **byte 1 以降: アイテムの並び**
  - 各アイテムは、タグ 1 バイト (bit 4〜6 = type、bit 0〜3 = param) と、それに続く varint からなります
- 1 パケットに入りきらないアイテムは、次のクロックに送られます。1 つのパケットには、同じ遅れ (late) のアイテムだけが入ります。LEGATO は対応するノートと同じクロックに届くよう、常に先頭に置かれます。

#### varint

- 値を 63 進で表し、下位の桁から順に並べます (各桁 0〜62)。
- 続きのバイトがある場合は bit 6 (+64) を立てます。これで各バイトは 126 以下 (ベロシティ 127 以下) に収まります。
- 符号付きの値 (s) は zigzag 符号化します (0, −1, 1, −2, … → 0, 1, 2, 3, …)。
- 例: 100 → `[101, 1]` (37 + 64、続いて 1)

#### アイテムの種類

| type | 名前 | param / データ |
|---|---|---|
| 0 | PORTA | s = MDX `F2` の値 (1 クロックあたり 1/256 KF)。param bit 0 = 1 のときは、オフセットをリセットせずに停止 |
| 1 | DETUNE | s = MDX `F3` の値 (1/64 半音)。次のノートから適用 |
| 2 | PLFO | ソフトウェア ピッチ LFO (MDX `EC`)。param = モード: 0 オフ、1 オン/リスタート、2〜5 波形 0〜3 を設定、+8 で振幅 ×256。設定モード (2 以上) のときは、u 周期 と s 振幅 が続く |
| 3 | ALFO | ソフトウェア 音量 LFO (MDX `EB`)。形式は PLFO と同じ |
| 4 | DELAY ほか | param 0: u = LFO ディレイ (MDX `E9`)<br>param 1: LEGATO (データなし)。このクロックの次のノートは、別の音程へのタイ (`&`)。キーオンせずに発音中の音の音程を変え、LFO は止めない<br>param 2: VOICE u = 発音中の音にすぐ読み込むバンクスロット (発音中の `@`)<br>param 3: REG u レジスタ、u データ。`y` コマンドの OPM レジスタ直接書き込み |
| 5 | CLOCK | u = 256 − TimerB (MDX の 1 クロックが 256 µs の何倍か) |
| 6 | VOLUME | u = MXDRV の減衰量 (このモードでは、音色に音量を焼き込みません) |
| 7 | FADE | u = フェードアウトによる追加の減衰量 (0 = なし、127 = 無音)。VOLUME に加算 |

#### 例

DETUNE −3 を送る場合:

- zigzag(−3) = 5 なので、アイテムは `[0x10, 5]`、ヘッダは 2 (パケット長 3 − 1)
- ノート 0 / 1 / 2 を、ベロシティ 3 / 17 / 6 で同時に鳴らします

#### 補足

- OPM ハード LFO (MDX `EA` / MHON / MHOF) は、MXDRV と同じレジスタ書き込みを REG アイテムで送ります。チップ共通のレジスタは全 FM チャンネルに送ります。
- 変換器は曲頭 (tick 0) で、曲の途中で変わるフェード・デチューン・LFO ディレイ・ソフト LFO の初期値を送り直します。DAW でループ再生したり頭から再生し直したりしても、前回の終わりの状態 (フェード後の無音など) が残りません。
- type 4 の param 0 と 4〜15 は、すべて LFO ディレイとして読みます。REG (param 3) に対応していない古いビルドでは REG も LFO ディレイとして読まれるので、ディレイがずれます。
- タグは 126 以下なので、type は 0〜7 の 8 種類だけで、すべて使用済みです。

### OPM68 側の受信動作

- **ノートオンだけを使います。** キー 0〜14 のノートオフは無視するので、制御ノートの長さに意味はありません。ベロシティ 0 はノートオフ扱いになるため、データには使えません。
- **バイトはキーごとに保持します。** ヘッダ (キー 0) と、パケット長分のバイトがすべてそろった時点で適用します。同時刻のノートオンが届く順序は問いません。
- **そろわないパケットは捨てます。** そろわないまま 256 チップサンプル (4 MHz 時で約 4.1 ms) 経つと破棄します。
- **同じ時刻の通常ノートより前に届く必要があります。** OPM68 は通常ノートの発音直前にパケットを確定させるからです。後から届いたパケットはその時点から効くだけで、特に LEGATO は次のノートに効いてしまいます。
- **MIDI チャンネルは無視します。** 1 つの OPM68 = MDX の 1 チャンネルです。複数チャンネルの制御ノートを 1 つの OPM68 に送らないでください。
- **late > 0 の扱い:** パケットに LFO か LFO ディレイが含まれ、直前のキーオンがちょうど late クロック前であれば、キーオン時の LFO 処理をやり直して late クロック分進めます。それ以外の項目は、届いた時点から有効です。
- **CLOCK を受け取るまでは、TimerB 200 相当 (1 クロック 14.336 ms) で動きます。**

### 制御ノート以外の MIDI

- **ベロシティ (ノート 15 以上):** `velprog` が ON のとき、ベロシティ 1〜127 で .opm バンクのスロット 0〜126 を選びます。バンクは通常 1 つを全 FM チャンネルで共有し、使う音色が 127 (ベロシティで選べるスロット数) を超える曲だけ、チャンネル別のバンク (`曲名_chA.opm` 〜) になります。
- `velprog` が ON の間、プログラムチェンジは無視します。
- **音量:** CC7 / CC11 を MXDRV の音量カーブ (0.75 dB/step) で減衰量に換算し、VOLUME・FADE と合算します。
- **パン:** CC10 は 3 段階です (42 以下 = 左、86 以上 = 右、その間 = 中央)。
- **ピッチベンド:** 幅は `bendrange` パラメータ、または RPN 0 で設定します。

実機相当との比較 (`tools/mxverify`): [portable_mdx](https://github.com/yosshin4004/portable_mdx) (MXDRV 2.06 の移植) の OPM レジスタ書き込みと、OPM68 の音程 (KC/KF) と 4 オペレータすべての TL を MDX クロックごとに突き合わせています。
コーパスから無作為に選んだ 395 曲・2,607 FM チャンネル (各 15 秒, v0.6) で、97.6% のチャンネルが音程・4 オペレータ TL とも全クロック一致、99.1% が 5% 以内でした。残る差は、別チャンネルのレジスタを y コマンドで書き換える曲、PCM8 との同期待ちを使う曲などです。

## Control notes (English)
OPM68 receives MXDRV's per-channel driver state (portamento, detune, software LFOs, volume, clock length and more) as **velocities of silent MIDI notes, not as MIDI CCs**.
DAWs (FL Studio and others) thin pitch bend and automation to buffer rate and scale it by their own bend range, which breaks MXDRV's fast portamento and LFOs. Notes arrive sample-accurately, so OPM68 can move pitch and volume every clock with the same calculations as MXDRV 2.06.

Implementation: encoder [`packages/core/src/opm68ctl.ts`](../../packages/core/src/opm68ctl.ts), decoder [`plugin/opm68/OpmEngine.hpp`](OpmEngine.hpp)

### Key ranges

| MIDI note number | Purpose |
|---|---|
| 0–14 | **Control notes.** OPM68 does not play these keys; it reads them as data |
| 15 and up | Normal notes. MDX's lowest note (o0 d+) is 15, so control notes never collide with music |

- The converter ([MDXPCM2MIDI](../../README.md)) writes control notes automatically in OPM68 mode. You never need to write them by hand.
- **When playing the .mid with any synth other than OPM68, delete or mute notes 0–14.** Otherwise they sound as very low notes.
- Do not transpose, quantize, velocity-scale or humanize control notes. Doing so corrupts the data.

### Packets

All control data for one channel at one MDX clock forms one packet. Byte *i* of the packet is sent as a note-on on note *i*.

- byte value = velocity − 1 (7 bits; velocity 1–127 carries 0–126)
- **byte 0 (header)**
  - bits 0–3: packet length − 1 (packets are 1–15 bytes)
  - bits 4–6: late (0–6). Marks items deferred because they did not fit in their own clock; the value is how many clocks late they are
- **byte 1 onward: items**
  - Each item is a tag byte (bits 4–6 = type, bits 0–3 = param) followed by varints
- Items that do not fit in a packet move to the next clock. A packet only holds items of the same lateness. LEGATO always goes first so that it arrives in the same clock as its note.

#### varint

- Values are written in base 63, least significant digit first (each digit 0–62).
- Bit 6 (+64) is set when more bytes follow, so every byte stays ≤ 126 (velocity ≤ 127).
- Signed values (s) are zigzag-encoded (0, −1, 1, −2, … → 0, 1, 2, 3, …).
- Example: 100 → `[101, 1]` (37 + 64, then 1)

#### Item types

| type | Name | param / data |
|---|---|---|
| 0 | PORTA | s = MDX `F2` value (1/256 KF per clock). param bit 0 = 1: stop without resetting the offset |
| 1 | DETUNE | s = MDX `F3` value (1/64 semitone), applied from the next note |
| 2 | PLFO | Software pitch LFO (MDX `EC`). param = mode: 0 off, 1 on/restart, 2–5 set wave 0–3, +8 amplitude ×256. Set modes (2 and up) are followed by u period and s amplitude |
| 3 | ALFO | Software amplitude LFO (MDX `EB`), same format as PLFO |
| 4 | DELAY etc. | param 0: u = LFO delay (MDX `E9`)<br>param 1: LEGATO (no data). The next note in this clock is a tie into another pitch (`&`): change the pitch of the sounding note without a key-on; LFOs keep running<br>param 2: VOICE u = bank slot to load into the sounding note now (`@` during a note)<br>param 3: REG u register, u data. A `y` command (direct OPM register write) |
| 5 | CLOCK | u = 256 − TimerB (one MDX clock is that many 256 µs units) |
| 6 | VOLUME | u = MXDRV attenuation (voices are not volume-baked in this mode) |
| 7 | FADE | u = extra attenuation for the fade-out (0 = none, 127 = silent), added to VOLUME |

#### Example

To send DETUNE −3:

- zigzag(−3) = 5, so the item is `[0x10, 5]` and the header is 2 (packet length 3 − 1)
- Play notes 0 / 1 / 2 together with velocities 3 / 17 / 6

#### Notes

- The OPM hardware LFO (MDX `EA` / MHON / MHOF) is sent as REG items carrying the same register writes MXDRV makes. Chip-global registers are sent to every FM channel.
- At the song start (tick 0) the converter resends the initial values of fade, detune, LFO delay and the software LFOs whenever the song changes them later. Looping in the DAW or replaying from the top does not keep the state left at the end of the previous pass (such as silence after a fade).
- Type 4 params 0 and 4–15 are all read as LFO delay. Older builds without REG (param 3) also read REG as LFO delay, which throws the delay off.
- Tags are ≤ 126, so there are only 8 types (0–7), and all of them are taken.

### How OPM68 receives them

- **Only note-ons are used.** Note-offs on keys 0–14 are ignored, so control-note length means nothing. Velocity 0 counts as a note-off and cannot carry data.
- **Bytes are held per key.** A packet is applied once the header (key 0) and all of its bytes have arrived. The order of note-ons at the same timestamp does not matter.
- **Incomplete packets are dropped.** A packet still incomplete after 256 chip samples (about 4.1 ms at 4 MHz) is discarded.
- **Packets must arrive before a normal note at the same timestamp.** OPM68 settles the packet just before the note sounds. A packet arriving later only takes effect from then on; a late LEGATO in particular applies to the next note instead.
- **MIDI channels are ignored.** One OPM68 = one MDX channel. Do not send control notes from several channels to one OPM68.
- **late > 0:** if the packet contains an LFO or LFO delay and the last key-on was exactly late clocks ago, OPM68 redoes the key-on LFO handling and runs late clocks forward. Other items take effect on arrival.
- **Until a CLOCK arrives, OPM68 runs at the equivalent of TimerB 200 (14.336 ms per clock).**

### Other MIDI messages

- **Velocity (notes 15 and up):** with `velprog` on, velocity 1–127 selects slot 0–126 in the .opm bank. One bank is normally shared by all FM channels; only songs that use more than 127 voices (the slots velocity can reach) get per-channel banks (`songname_chA.opm` …).
- While `velprog` is on, program changes are ignored.
- **Volume:** CC7 / CC11 are converted to attenuation on MXDRV's volume curve (0.75 dB/step) and summed with VOLUME and FADE.
- **Pan:** CC10 has three positions (≤ 42 = left, ≥ 86 = right, otherwise centre).
- **Pitch bend:** range set by the `bendrange` parameter or RPN 0.

## 変更履歴
- 0.6.5: 制御ノートのヘッダが示すパケット長が受け付けられる最大 (15 バイト) を超えるとき、範囲外を読み書きせずにそのパケットを捨てる (不正な入力への対策。変換器の出力では起きないので、音は 0.6.4 と同じ)
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
配布用の zip (Windows / macOS / Linux) は GitHub Actions ([`.github/workflows/opm68-release.yml`](../../.github/workflows/opm68-release.yml)) で作ります。リリースを公開すると 3 つとも自動でビルドされ、そのリリースに添付されます (Actions タブから手動実行も可)。

`test/render.cpp` はエンジン単体のオフライン描画、`test/clap_smoke.cpp` は CLAP 版を読み込んで鳴らす簡易ホストです。
