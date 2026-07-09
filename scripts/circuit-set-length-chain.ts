/**
 * Post-process a packed .ncs to set every drum pattern's LENGTH to 32 steps and
 * optionally bake a pattern CHAIN so a multi-pattern groove auto-advances on
 * load. The byte layout lives in the codec (`circuit-tracks/ncs/chain.ts`);
 * this is the CLI front-end.
 *
 *   npx tsx scripts/circuit-set-length-chain.ts <in.ncs> <out.ncs> [full|chop|<start>-<end>]
 *
 *   full       chain patterns 1->2 (range [0,1]) — the hardware-confirmed case
 *   chop       lengths only, no chain (single patterns)
 *   <a>-<b>    chain the 0-based pattern range [a,b] (DECODED-BETA, untested
 *              beyond [0,1] — see chain.ts / docs/design/circuit-chain-range.md)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { setAllDrumLengths, setDrumChain } from '@mcp-midi-control/circuit-tracks/ncs/chain.js';

const inPath = process.argv[2];
const outPath = process.argv[3] ?? inPath;
const mode = process.argv[4] ?? 'full';

const buf = new Uint8Array(readFileSync(inPath));
setAllDrumLengths(buf, 32);

let chainNote = '';
if (mode !== 'chop') {
  const m = mode.match(/^(\d+)-(\d+)$/);
  const range = m ? { start: Number(m[1]), end: Number(m[2]) } : { start: 0, end: 1 }; // 'full' = [0,1]
  setDrumChain(buf, range);
  chainNote = ` + chain [${range.start},${range.end}]${range.start === 0 && range.end === 1 ? '' : ' (BETA, untested range)'}`;
}

writeFileSync(outPath, buf);
console.log(`${outPath}: drum patterns set to 32 steps${chainNote}.`);
