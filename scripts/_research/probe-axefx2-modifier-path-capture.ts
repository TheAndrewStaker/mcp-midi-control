/**
 * Passive capture of AxeEdit's modifier-read path (PROBE-II-FN18-REPLY, Option B).
 *
 * fn 0x18 was proven request-only (no direct reply) even with a target set and
 * a modifier assigned. AxeEdit demonstrably HAS the modifier data, so it fetches
 * it some other way. This listens passively (Windows MIDI input is shared-read,
 * coexists with AxeEdit) and logs EVERY device->host SysEx frame with a timestamp
 * and fn byte, so when AxeEdit opens its Edit Modifier dialog we can see exactly
 * which frames carry the modifier envelope.
 *
 * Operator: while this runs, reopen AxeEdit, let it connect, then OPEN the
 * Edit Modifier dialog on Amp 1 Input Drive (and/or toggle the Source dropdown).
 *
 * Output: samples/captured/probe-axefx2-modifier-path.jsonl (one frame per line)
 * + a console summary grouped by fn byte. Read-only.
 *
 * Run: npx tsx scripts/_research/probe-axefx2-modifier-path-capture.ts [seconds]
 */
import midi from "@julusian/midi";
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const II_NEEDLES = ['axe-fx ii', 'axe-fx-ii', 'axefx ii'];
const SECONDS = Number(process.argv[2] ?? 55);

function findPort(io: midi.Input): number {
  for (let i = 0; i < io.getPortCount(); i++) {
    const n = io.getPortName(i).toLowerCase();
    if (II_NEEDLES.some((needle) => n.includes(needle)) && !n.includes('mock')) return i;
  }
  return -1;
}
const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');

async function main(): Promise<void> {
  const input = new midi.Input();
  const idx = findPort(input);
  if (idx < 0) { console.error('Axe-Fx II input not found.'); process.exit(1); }
  input.ignoreTypes(false, true, true);
  const t0 = Date.now();
  const log: { ms: number; fn: number; len: number; bytes: string }[] = [];
  input.on('message', (_dt, msg) => {
    if (msg[0] !== 0xf0 || msg[4] !== 0x07) return;
    log.push({ ms: Date.now() - t0, fn: msg[5], len: msg.length, bytes: hex([...msg]) });
  });
  input.openPort(idx);
  console.log(`Capturing on "${input.getPortName(idx)}" for ${SECONDS}s. Reopen AxeEdit + open the Edit Modifier dialog now.`);
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  input.closePort();

  const outDir = path.resolve(process.cwd(), 'samples', 'captured');
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'probe-axefx2-modifier-path.jsonl');
  writeFileSync(outPath, log.map((l) => JSON.stringify(l)).join('\n'));

  // Summary by fn byte (count, lengths seen, first/last ms).
  const byFn = new Map<number, { count: number; lens: Set<number>; first: number; last: number }>();
  for (const l of log) {
    const r = byFn.get(l.fn) ?? { count: 0, lens: new Set<number>(), first: l.ms, last: l.ms };
    r.count++; r.lens.add(l.len); r.last = l.ms;
    byFn.set(l.fn, r);
  }
  console.log(`\nCaptured ${log.length} frames -> ${outPath}`);
  console.log('fn byte | count | lengths | first..last ms');
  for (const [fn, r] of [...byFn.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  0x${fn.toString(16).padStart(2, '0')} | ${r.count} | [${[...r.lens].sort((a, b) => a - b).join(',')}] | ${r.first}..${r.last}`);
  }
  // Highlight any LARGE / unusual frames (candidate modifier dumps), excluding
  // the high-frequency polling bytes.
  const NOISE = new Set([0x10, 0x12, 0x13, 0x15, 0x64]);
  const candidates = log.filter((l) => !NOISE.has(l.fn) && l.len >= 18);
  console.log(`\nCandidate non-noise frames (len>=18): ${candidates.length}`);
  for (const c of candidates.slice(0, 30)) {
    const show = c.len > 60 ? c.bytes.split(' ').slice(0, 60).join(' ') + ` ...(+${c.len - 60}B)` : c.bytes;
    console.log(`  @${c.ms}ms fn 0x${c.fn.toString(16)} len ${c.len}: ${show}`);
  }
  process.exit(0);
}
main();
