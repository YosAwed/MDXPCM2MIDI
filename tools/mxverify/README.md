# mxverify — OPM68 vs MXDRV 2.06 register comparison

Compares the pitch (KC/KF) and the total level (TL) of all four operators that OPM68 produces with what real MXDRV 2.06 writes
to the OPM, clock by clock.

1. Build [portable_mdx](https://github.com/yosshin4004/portable_mdx) `examples/simple_mdx2wav` with two small patches (`portable_mdx.patch`):
   - `src/mxdrv/mxdrv.cpp` `L_WRITEOPM`: when `MXLOG` is set, append `"<tick> <reg> <data>"` (tick = `G.L001ba6`) for every OPM write
   - `examples/simple_mdx2wav/main.c`: `MXSECS` overrides the song length (skips the measuring pass, which would also be logged)
2. Build `plugin/opm68/test/render.cpp`; with `OPMTRACE=<file>` it logs `"<sec> p <pitch code>"` and `"<sec> t<slot> <TL>"` (slot 0-3 = M1, M2, C1, C2 in register order) for the current voice.
3. `verify.sh song.mdx [secs]` converts the song with `--opm68`, renders every FM channel through the engine and runs `regcmp.py`.

`regcmp.py` samples both sides once per MDX clock (in the middle of the clock), after searching the time offset
(±0.12 s) that best aligns the pitch and C2 TL; it stops where the converted song ends.
Environment: `MXDRV2WAV` (simple_mdx2wav), `OPMRENDER` (render), `MDX2MID` (converter command, default `npx tsx packages/core/src/cli.ts`).
