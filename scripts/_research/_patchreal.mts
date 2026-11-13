/** Is an unnamed .cpb patch real content, or an init/blank the probes left behind? */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const BODY = 340, STRIDE = 512;
const clean = (b: Uint8Array) => Array.from(b.slice(0, 16)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();
const bodies: { src: string; name: string; body: Uint8Array }[] = [];
for (const dir of process.argv.slice(2)) {
  for (const f of readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.cpb')).sort()) {
    const b = new Uint8Array(readFileSync(join(dir, f)));
    for (let i = 0; i * STRIDE + BODY <= b.length; i++) {
      const body = b.slice(i * STRIDE, i * STRIDE + BODY);
      bodies.push({ src: `${dir.split(/[\/]/).slice(-2).join('/')}/${f}#${i}`, name: clean(body) || '(unnamed)', body });
    }
  }
}
// An init patch: compare every body against the most common one (probes save init repeatedly).
const tally = new Map<string, number>();
for (const x of bodies) { const h = createHash('sha256').update(x.body).digest('hex'); tally.set(h, (tally.get(h) ?? 0) + 1); }
const modal = [...tally].sort((a, b) => b[1] - a[1])[0];
console.log(`${bodies.length} bodies, ${tally.size} distinct. Most repeated body appears ${modal[1]}x (likely INIT).\n`);
for (const x of bodies) {
  const h = createHash('sha256').update(x.body).digest('hex');
  // entropy proxy: distinct byte values in the parameter region (after the 16-byte name)
  const params = x.body.slice(16);
  const distinct = new Set(params).size;
  const zeros = params.filter((v) => v === 0).length;
  const dup = tally.get(h)!;
  const verdict = dup === modal[1] && modal[1] > 2 ? 'INIT/blank (modal body)'
    : distinct < 12 ? 'near-empty'
      : 'REAL';
  console.log(`  ${x.name.padEnd(18)} ${String(distinct).padStart(3)} distinct bytes, ${String(zeros).padStart(3)}/${params.length} zero, ${dup}x  -> ${verdict}   ${x.src}`);
}
