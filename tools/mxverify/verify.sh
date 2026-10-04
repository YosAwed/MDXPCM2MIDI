#!/bin/bash
# verify.sh file.mdx secs : compare OPM68 engine vs MXDRV (portable_mdx) register log per FM channel
f=$1; secs=${2:-30}; b=$(basename $f .mdx); b=${b%.MDX}; o=/tmp/vf/$b; mkdir -p $o
(cd $(dirname $f) && MXLOG=$o/mx.log MXSECS=$secs ${MXDRV2WAV:-simple_mdx2wav} -i $(basename $f) -o $o/mx.wav -r 48000 >/dev/null 2>&1)
(cd $(cd $(dirname $0)/../.. && pwd) && ${MDX2MID:-npx tsx packages/core/src/cli.ts} $f -o $o/x.mid --opm68 --no-pdx >/dev/null 2>&1)
for c in 0 1 2 3 4 5 6 7; do
  python3 $(cd $(dirname $0)/../.. && pwd)/plugin/opm68/test/midi2txt.py $o/x.mid $o/ev$c.txt $c
  [ -s $o/ev$c.txt ] || continue
  grep -q " 14[4-9] \| 15[0-9] " $o/ev$c.txt || continue
  OPMTRACE=$o/t$c.log ${OPMRENDER:-render} $o/x.opm $o/ev$c.txt $o/r$c.raw >/dev/null 2>&1
  [ -s $o/t$c.log ] || continue
  # compare only while the converted song plays (a short looping song ends after --loops repeats)
  end=$(tail -1 $o/ev$c.txt | awk -v s=$secs '{e=$1/48000; print (e<s?e:s)}')
  echo -n "$b ch$c: "; python3 $(dirname $0)/regcmp.py $o/mx.log $o/t$c.log $c $end | tr '\n' ' '; echo
done
