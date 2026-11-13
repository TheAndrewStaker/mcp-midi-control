/**
 * Read patch NAMES out of .cpb group files and compare them against the factory corpus.
 * A .cpb group = 8 bodies of 340 bytes at 512-byte stride; the name is bytes 0..15 of each body.
 * Anything whose body is not byte-identical to a factory dump is NOT stock - i.e. it is his.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const BODY = 340, STRIDE = 512;
const clean = (b: Uint8Array) => Array.from(b.slice(0, 16)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();

// factory corpus: body sits at frame offset 9 in each patch_N.syx
const FACT = new Map<string, string>();
const fdir = 'samples/circuit-tracks/pack0/patches';
if (existsSync(fdir)) {
  for (const f of readdirSync(fdir).filter((x) => x.endsWith('.syx'))) {
    const raw = new Uint8Array(readFileSync(join(fdir, f)));
    const body = raw.slice(9, 9 + BODY);
    FACT.set(createHash('sha256').update(body).digest('hex'), `${f}:${clean(body)}`);
  }
}
console.log(`factory corpus: ${FACT.size} distinct patch bodies\n`);

for (const dir of process.argv.slice(2)) {
  if (!existsSync(dir)) { console.log(`${dir}: (absent)`); continue; }
  const files = readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.cpb')).sort();
  console.log(`=== ${dir}  (${files.length} group files)`);
  let stock = 0, custom = 0;
  for (const f of files) {
    const b = new Uint8Array(readFileSync(join(dir, f)));
    const n = Math.floor((b.length - BODY) / STRIDE) + 1;
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const body = b.slice(i * STRIDE, i * STRIDE + BODY);
      if (body.length < BODY) break;
      const h = createHash('sha256').update(body).digest('hex');
      const isFact = FACT.has(h);
      if (isFact) stock++; else custom++;
      out.push(`${clean(body) || '(unnamed)'}${isFact ? '' : ' **CUSTOM**'}`);
    }
    console.log(`  ${f} (${b.length}B, ${out.length} patches): ${out.join(' | ')}`);
  }
  console.log(`  --> ${stock} stock, ${custom} NOT-in-factory-corpus\n`);
}
