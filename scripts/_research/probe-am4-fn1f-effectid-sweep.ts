/**
 * AM4 fn 0x1F effectId sweep.
 *
 * The original HW-AM4-FN1F probe tested 3 effectIds: 0 (NACK), 1 (163-
 * ushort chunk), 106 (100-ushort chunk). A follow-up write-probe found
 * that writing amp.gain didn't change any position in the effectId=106
 * chunk — implying 106 is NOT amp1 (the value was borrowed from II,
 * which is a different device family).
 *
 * This sweep checks every effectId in 1..255 and records: chunk size,
 * NACK, or silent. The mapping (effectId → block) decodes from there.
 *
 * Run:
 *   close AM4-Edit; AM4 powered + USB connected
 *   npx tsx scripts/_research/probe-am4-fn1f-effectid-sweep.ts
 *
 * Output:
 *   samples/captured/decoded/am4-fn1f-effectid-sweep.md (markdown summary)
 *   samples/captured/decoded/am4-fn1f-effectid-sweep.json (raw data)
 */
import midi from "@julusian/midi";
import { writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildGetAllParams } from 'fractal-midi/am4';

const AM4_MODEL = 0x15;
const SYSEX_START = 0xf0;
const SWEEP_FROM = 1;
const SWEEP_TO = 255;
const PROBE_WAIT_MS = 350;

interface ProbeResult {
  effectId: number;
  verdict: 'state_broadcast_triple' | 'multipurpose_nack' | 'silent' | 'unknown';
  chunkUshorts?: number;
  nackResultCode?: number;
  rawHeaderHex?: string;
}

function decode14(lo: number, hi: number): number {
  return (lo & 0x7f) | ((hi & 0x7f) << 7);
}

function hex(b: number[]): string {
  return b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
}

function isAm4Fn(bytes: number[], fn: number): boolean {
  return (
    bytes.length >= 7
    && bytes[0] === SYSEX_START
    && bytes[1] === 0x00
    && bytes[2] === 0x01
    && bytes[3] === 0x74
    && bytes[4] === AM4_MODEL
    && bytes[5] === fn
  );
}

function pickPort(instance: midi.Input | midi.Output, label: string): number {
  const n = instance.getPortCount();
  for (let i = 0; i < n; i++) {
    if (/AM4|Fractal.*AM4/i.test(instance.getPortName(i))) return i;
  }
  const names = Array.from({ length: n }, (_, i) => instance.getPortName(i));
  throw new Error(`No AM4 ${label} port: available ${names.join(' | ') || '(none)'}`);
}

async function main(): Promise<void> {
  const input = new midi.Input();
  const output = new midi.Output();
  input.ignoreTypes(false, true, true);
  input.openPort(pickPort(input, 'input'));
  output.openPort(pickPort(output, 'output'));
  console.log('AM4 ports opened. Sweeping effectIds…');

  const frames: number[][] = [];
  let captureActive = false;
  input.on('message', (_dt, msg) => {
    if (captureActive) frames.push([...msg]);
  });

  const results: ProbeResult[] = [];
  for (let eid = SWEEP_FROM; eid <= SWEEP_TO; eid++) {
    captureActive = true;
    frames.length = 0;
    const req = buildGetAllParams(eid);
    output.sendMessage(req);
    await sleep(PROBE_WAIT_MS);
    captureActive = false;
    const taken = [...frames];

    const nack = taken.find((f) => isAm4Fn(f, 0x64) && f[6] === 0x1f);
    const header = taken.find((f) => isAm4Fn(f, 0x74));
    const chunk = taken.find((f) => isAm4Fn(f, 0x75));

    if (nack) {
      results.push({ effectId: eid, verdict: 'multipurpose_nack', nackResultCode: nack[7] });
    } else if (header && chunk) {
      const itemCount = decode14(chunk[6], chunk[7]);
      results.push({
        effectId: eid,
        verdict: 'state_broadcast_triple',
        chunkUshorts: itemCount,
        rawHeaderHex: hex(header),
      });
      console.log(`eid=${eid.toString().padStart(3)} → ${itemCount} ushorts  header=${hex(header)}`);
    } else if (taken.length === 0) {
      results.push({ effectId: eid, verdict: 'silent' });
    } else {
      results.push({ effectId: eid, verdict: 'unknown' });
    }
  }

  input.closePort();
  output.closePort();

  // Group: which effectIds returned triples?
  const hits = results.filter((r) => r.verdict === 'state_broadcast_triple');
  const nacks = results.filter((r) => r.verdict === 'multipurpose_nack');
  const silent = results.filter((r) => r.verdict === 'silent');

  console.log('\n=== Summary ===');
  console.log(`Triple hits:  ${hits.length}`);
  console.log(`NACKs:        ${nacks.length} (rc 0x06 = invalid effectId)`);
  console.log(`Silent:       ${silent.length}`);
  console.log('\nHit chunk-sizes:');
  const sizeBuckets = new Map<number, number[]>();
  for (const h of hits) {
    const arr = sizeBuckets.get(h.chunkUshorts!) ?? [];
    arr.push(h.effectId);
    sizeBuckets.set(h.chunkUshorts!, arr);
  }
  for (const [size, eids] of [...sizeBuckets.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${size.toString().padStart(4)} ushorts → effectIds [${eids.join(', ')}]`);
  }

  mkdirSync('samples/captured/decoded', { recursive: true });
  const outPath = 'samples/captured/decoded/am4-fn1f-effectid-sweep.json';
  writeFileSync(outPath, JSON.stringify({ run: new Date().toISOString(), sweepFrom: SWEEP_FROM, sweepTo: SWEEP_TO, results }, null, 2));
  console.log(`\nJSON: ${outPath}`);

  const md: string[] = [];
  md.push('# AM4 fn 0x1F effectId sweep');
  md.push('');
  md.push(`Run: ${new Date().toISOString()}`);
  md.push(`Range: effectId ${SWEEP_FROM}..${SWEEP_TO}`);
  md.push('');
  md.push(`- Triple hits: ${hits.length}`);
  md.push(`- NACKs (rc=0x06 invalid effectId): ${nacks.length}`);
  md.push(`- Silent: ${silent.length}`);
  md.push('');
  md.push('## Hit chunk-sizes');
  md.push('');
  md.push('| Chunk ushorts | effectIds |');
  md.push('|---|---|');
  for (const [size, eids] of [...sizeBuckets.entries()].sort((a, b) => a[0] - b[0])) {
    md.push(`| ${size} | ${eids.join(', ')} |`);
  }
  const mdPath = 'samples/captured/decoded/am4-fn1f-effectid-sweep.md';
  writeFileSync(mdPath, md.join('\n'));
  console.log(`Markdown: ${mdPath}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
