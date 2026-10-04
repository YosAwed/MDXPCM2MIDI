# mxverify — OPM68 vs MXDRV 2.06 register comparison

Compares the pitch (KC/KF) and carrier level (C2 TL) that OPM68 produces with what real MXDRV 2.06 writes
to the OPM, clock by clock.

1. Build [portable_mdx](https://github.com/yosshin4004/portable_mdx) `examples/simple_mdx2wav` with two small patches:
   - `src/mxdrv/mxdrv.cpp` `L_WRITEOPM`: when `MXLOG` is set, append `"<tick> <reg> <data>"` (tick = `G.L001ba6`) for every OPM write
   - `examples/simple_mdx2wav/main.c`: `MXSECS` overrides the song length (skips the measuring pass, which would also be logged)
2. Build `plugin/opm68/test/render.cpp`; with `OPMTRACE=<file>` it logs `"<sec> p <pitch code>"` and `"<sec> t <C2 TL>"` for the current voice.
3. `verify.sh song.mdx [secs]` converts the song with `--opm68`, renders every FM channel through the engine and runs `regcmp.py`.
