# opmrender (開発用の試聴ツール)

VOPM モードで出力した `.mid` + `.opm` を、ymfm の YM2151 エミュレーションで WAV 相当に描画します。
DAW を立ち上げずに音色や音程の変換結果を確認するためのもので、VOPM そのものの挙動とは細部が異なります。

```sh
git clone --depth 1 https://github.com/aaronsgiles/ymfm.git
g++ -O2 -std=c++17 -Iymfm/src opmrender.cpp ymfm/src/ymfm_opm.cpp -o opmrender
pip install mido
python3 midi2ev.py song.mid ev.txt          # MIDI ch1-8 をイベント列に (62.5kHz サンプル単位)
./opmrender song.opm ev.txt fm.raw          # s16le stereo 62500Hz
ffmpeg -f s16le -ar 62500 -ac 2 -i fm.raw fm.wav
```
