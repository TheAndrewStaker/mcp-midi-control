/** Compare drum length bytes old vs new card for slots 20/23/24. Read-only. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { META_OFFSETS, drumBlockIndex } from '../../packages/circuit-tracks/src/ncs/format.js';

const load = (dir: string, slot: number): Buffer => {
  const f = readdirSync(dir).find((x) => x.includes(`project${slot}`))!;
  return readFileSync(join(dir, f));
};
const OLD = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/schism-levels-verify-2026-07-29';
const NEW = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/schism-tailfix-verify-2026-07-29';
for (const slot of [20, 23, 24]) {
  for (const [label, dir] of [['OLD', OLD], ['NEW', NEW]] as const) {
    const b = load(dir, slot);
    const lens = (t: number): string => [...Array(8).keys()].map((p) => b[META_OFFSETS[drumBlockIndex(t, p)]] + 1).join(',');
    console.log(slot, label, [0, 1, 2, 3].map((t) => `d${t + 1}=[${lens(t)}]`).join(' '));
  }
}
