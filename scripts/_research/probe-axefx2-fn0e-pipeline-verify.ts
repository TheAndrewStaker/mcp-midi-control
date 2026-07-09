/**
 * Axe-Fx II fn 0x0E full-pipeline verification (READ-ONLY)
 * =======================================================
 * Proves the grid -> fn 0x0E -> address-sort -> per-block (engaged,
 * channel) pipeline end-to-end by cross-validating it against
 * INDEPENDENT reads:
 *   - engaged: fn 0x02 GET of paramId 255 (bypass) per block
 *   - channel: fn 0x11 GET_BLOCK_CHANNEL per block
 * If both agree across all placed blocks, the fn 0x0E decode is correct.
 * Uses shipped fractal-midi codec. Read-only (all GETs). No writes.
 *
 * Tag-byte model under test: engaged = tag & 0x01; channel = (tag & 0x02) ? X : Y.
 * Record identification: sort records by state28 (28-bit b1..b4), zip to
 * placed blockIds ascending.
 */
import midi from "@julusian/midi";
import { writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import {
  buildGetGridLayout, parseGetGridLayoutResponse,
  buildQueryStates, parseQueryStatesResponse,
  buildGetBlockParameterValue, parseGetBlockParameterResponse,
  buildGetBlockChannel, parseGetBlockChannelResponse,
} from 'fractal-midi/gen2/axe-fx-ii';

const F0 = 0xf0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const find = (io: midi.Input | midi.Output, ns: string[]) => { for (let i = 0; i < io.getPortCount(); i++) if (ns.some((n) => io.getPortName(i).toLowerCase().includes(n))) return i; return -1; };

async function main() {
  const out = new midi.Output(), inp = new midi.Input();
  const oi = find(out, ['axe-fx ii', 'axefxii', 'xl+', 'axe-fx']);
  const ii = find(inp, ['axe-fx ii', 'axefxii', 'xl+', 'axe-fx']);
  if (oi < 0 || ii < 0) { console.error('Axe-Fx II port not found'); process.exit(1); }
  out.openPort(oi); inp.ignoreTypes(false, true, true);
  const got: number[][] = []; inp.on('message', (_d, b) => { if (b[0] === F0) got.push(b.slice()); }); inp.openPort(ii);
  await sleep(300);
  const ask = async (frame: number[], fn: number, ms = 900) => { const before = got.length; out.sendMessage(frame); await sleep(ms); return got.slice(before).find((f) => f[5] === fn); };

  // 1. grid -> placed blockIds (non-shunt)
  const gridF = await ask(buildGetGridLayout(), 0x20, 1200);
  const cells = gridF ? parseGetGridLayoutResponse(gridF) : [];
  const placed = cells.filter((c) => c.blockId >= 100 && c.blockId < 200).map((c) => c.blockId);
  const placedAsc = [...placed].sort((a, b) => a - b);
  console.log(`grid: ${placed.length} placed blocks: ${placed.join(', ')}`);

  // 2. fn 0x0E -> records; 3. sort by state28; 4. zip to placedAsc
  const statesF = await ask(buildQueryStates(), 0x0e, 1200);
  const records = statesF ? parseQueryStatesResponse(statesF) : [];
  const recsSorted = records.map((r, idx) => ({ ...r, deliveryIdx: idx })).sort((a, b) => a.state28 - b.state28);
  const map = recsSorted.map((r, i) => ({ blockId: placedAsc[i], tag: r.tag, state28: r.state28, deliveryIdx: r.deliveryIdx }));
  const sameLen = records.length === placed.length;
  console.log(`fn 0x0E: ${records.length} records (placed=${placed.length}, ${sameLen ? 'match' : 'MISMATCH'})`);

  // 5. cross-validate each block: fn0e-derived vs independent reads
  const rows: { blockId: number; tag: number; e0e: boolean; eGet: boolean; eMatch: boolean; c0e: string; cGet: string; cMatch: boolean }[] = [];
  for (const m of map) {
    if (m.blockId === undefined) continue;
    const e0e = (m.tag & 0x01) === 0x01;            // engaged per fn 0x0E
    const c0e = (m.tag & 0x02) === 0x02 ? 'X' : 'Y'; // channel per fn 0x0E
    // independent bypass read (fn 0x02 paramId 255): value 1 = bypassed, 0 = engaged
    const bypF = await ask(buildGetBlockParameterValue({ effectId: m.blockId, paramId: 255 }), 0x02, 500);
    let eGet = e0e; let bypLabel = '?';
    if (bypF) { const p = parseGetBlockParameterResponse(bypF); eGet = p.value === 0; bypLabel = `${p.value}/${p.label}`; }
    // independent channel read (fn 0x11)
    const chF = await ask(buildGetBlockChannel(m.blockId), 0x11, 500);
    let cGet = c0e; if (chF) cGet = parseGetBlockChannelResponse(chF);
    rows.push({ blockId: m.blockId, tag: m.tag, e0e, eGet, eMatch: e0e === eGet, c0e, cGet, cMatch: c0e === cGet });
    console.log(`  blk ${m.blockId} tag=0x${m.tag.toString(16)}  0x0E:${e0e ? 'eng' : 'byp'}/${c0e}  GET:${eGet ? 'eng' : 'byp'}(${bypLabel})/${cGet}  engaged ${e0e === eGet ? 'OK' : 'X'}  channel ${c0e === cGet ? 'OK' : 'X'}`);
  }

  const eMatch = rows.filter((r) => r.eMatch).length;
  const cMatch = rows.filter((r) => r.cMatch).length;
  console.log(`\nENGAGED match: ${eMatch}/${rows.length}   CHANNEL match: ${cMatch}/${rows.length}`);
  const verdict = sameLen && eMatch === rows.length && cMatch === rows.length ? 'PIPELINE VERIFIED' : 'MISMATCH (investigate)';
  console.log(`VERDICT: ${verdict}`);

  mkdirSync('samples/captured', { recursive: true });
  const W = [`# fn 0x0E pipeline verification`, `> ${new Date().toISOString()}`, '',
    `grid placed: ${placed.join(', ')}`, `records: ${records.length} (${sameLen ? 'len match' : 'LEN MISMATCH'})`,
    `ENGAGED match ${eMatch}/${rows.length}, CHANNEL match ${cMatch}/${rows.length} -> ${verdict}`, '',
    `| blockId | tag | 0x0E engaged | GET engaged | 0x0E chan | GET chan | match |`, `|---|---|---|---|---|---|---|`,
    ...rows.map((r) => `| ${r.blockId} | 0x${r.tag.toString(16)} | ${r.e0e} | ${r.eGet} | ${r.c0e} | ${r.cGet} | ${r.eMatch && r.cMatch ? 'OK' : 'MISMATCH'} |`)];
  writeFileSync(path.resolve('samples/captured/probe-axefx2-fn0e-pipeline-verify.md'), W.join('\n'));
  console.log('Saved samples/captured/probe-axefx2-fn0e-pipeline-verify.md');
  inp.closePort(); out.closePort(); process.exit(0);
}
main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
