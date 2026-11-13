/** Byte-diff two .ncs files. Used to isolate what the DEVICE's own save changed relative to a file
 *  we uploaded — the only oracle that proves a field is read back rather than merely stored. */
import { readFileSync } from 'node:fs';
const [a, b] = process.argv.slice(2);
const A = new Uint8Array(readFileSync(a)), B = new Uint8Array(readFileSync(b));
if (A.length !== B.length) { console.error(`length differs: ${A.length} vs ${B.length}`); process.exit(1); }
const diffs: number[] = [];
for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) diffs.push(i);
console.log(`${diffs.length} byte(s) differ (uploaded -> device save)`);
for (const i of diffs.slice(0, 40)) console.log(`  0x${i.toString(16).padStart(5,'0')}  ${A[i]!.toString().padStart(3)} -> ${B[i]!.toString().padStart(3)}   (0x${A[i]!.toString(16).padStart(2,'0')} -> 0x${B[i]!.toString(16).padStart(2,'0')})`);
if (diffs.length > 40) console.log(`  ... ${diffs.length - 40} more`);
