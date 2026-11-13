/** Re-mine for the stored FX-send bytes. A send must be 0..127 in EVERY file and should VARY
 *  across a corpus where some projects have reverb dialled in. Scan a wide window around the
 *  known mixer block and keep only offsets that stay <=127 everywhere. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const ROOTS = ['C:/Users/Steph/mcp-midi-backups','C:/dev/mcp-midi-tools/samples/circuit-ncs',
  'C:/dev/mcp-midi-tools/samples/circuit-restore','C:/dev/mcp-midi-tools/samples/circuit-tracks'];
const FROM = 0x27010, TO = 0x27034;   // mixer block + the region just past the pans
const files: string[] = [];
function walk(d: string) {
  let e: string[]; try { e = readdirSync(d); } catch { return; }
  for (const n of e) { const p = join(d, n); let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p); else if (n.toLowerCase().endsWith('.ncs') && st.size === 160780) files.push(p); }
}
for (const r of ROOTS) walk(r);
const vals = new Map<number, Map<number, number>>();   // offset -> value -> count
for (const f of files) {
  const b = new Uint8Array(readFileSync(f));
  for (let o = FROM; o < TO; o++) {
    if (!vals.has(o)) vals.set(o, new Map());
    const m = vals.get(o)!; m.set(b[o], (m.get(b[o]) ?? 0) + 1);
  }
}
console.log(`${files.length} .ncs files scanned\n`);
console.log('off      max  distinct  midi-safe  values (count)');
for (const [o, m] of [...vals].sort((a,b)=>a[0]-b[0])) {
  const keys = [...m.keys()];
  const max = Math.max(...keys);
  const safe = max <= 127;
  const shown = [...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6).map(([v,c])=>`${v}(${c})`).join(' ');
  console.log(`0x${o.toString(16)}  ${String(max).padStart(3)}  ${String(keys.length).padStart(3)}      ${safe?'YES':'no '}      ${shown}`);
}
