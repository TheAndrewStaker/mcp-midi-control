/**
 * Axe-Fx II fn 0x0E record -> block mapping + b1..b4 meaning (differential)
 * ========================================================================
 * For each placed block (from fn 0x20 grid), toggle its bypass and find
 * which fn 0x0E record's engaged bit (tag 0x01) flips -> that record IS
 * that block. Builds record-index -> blockId map, then determines the
 * record-ordering basis (grid-cell? blockId? effectId?) and decodes the
 * invariant 28-bit b1..b4 value per record to test what it encodes.
 * RESTORES each block's bypass to baseline. Reversible; nothing saved.
 */
import midi from "@julusian/midi";
import { writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { buildQueryStates, buildGetGridLayout, buildSetBlockBypass } from 'fractal-midi/gen2/axe-fx-ii';

const F0 = 0xf0;
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const find = (io: midi.Input | midi.Output, ns: string[]) => { for (let i = 0; i < io.getPortCount(); i++) if (ns.some((n) => io.getPortName(i).toLowerCase().includes(n))) return i; return -1; };

function records(frame: number[] | undefined): number[][] {
  if (!frame) return [];
  const sp = frame.slice(6, frame.length - 1);
  const recs: number[][] = [];
  for (let r = 0; r + 5 <= sp.length; r += 5) recs.push(sp.slice(r, r + 5));
  return recs;
}
// 28-bit LSB-septet value from bytes b1..b4 of a record
const b28 = (rec: number[]) => (rec[1] & 0x7f) + (rec[2] & 0x7f) * 128 + (rec[3] & 0x7f) * 16384 + (rec[4] & 0x7f) * 2097152;

async function main() {
  const out = new midi.Output(), inp = new midi.Input();
  const oi = find(out, ['axe-fx ii', 'axefxii', 'xl+', 'axe-fx']);
  const ii = find(inp, ['axe-fx ii', 'axefxii', 'xl+', 'axe-fx']);
  if (oi < 0 || ii < 0) { console.error('Axe-Fx II port not found'); process.exit(1); }
  out.openPort(oi); inp.ignoreTypes(false, true, true);
  const got: number[][] = []; inp.on('message', (_d, b) => { if (b[0] === F0) got.push(b.slice()); }); inp.openPort(ii);
  await sleep(300);
  const ask = async (frame: number[], fn: number, ms = 1000) => { const before = got.length; out.sendMessage(frame); await sleep(ms); return got.slice(before).find((f) => f[5] === fn); };
  const tell = async (frame: number[], ms = 450) => { out.sendMessage(frame); await sleep(ms); };

  // grid -> placed blocks in cell order
  const gridF = await ask(buildGetGridLayout(), 0x20, 1200);
  const gp = gridF ? gridF.slice(6, gridF.length - 2) : [];
  const blocks: { cell: number; blockId: number }[] = [];
  for (let c = 0; c < gp.length - 3; c += 4) {
    const bid = (gp[c] & 0x7f) | ((gp[c + 1] & 0x7f) << 7);
    if (bid > 0 && bid < 200) blocks.push({ cell: c / 4, blockId: bid });
  }
  console.log(`grid: ${blocks.length} placed blocks: ${blocks.map((b) => `c${b.cell}:${b.blockId}`).join(' ')}`);

  const base = records(await ask(buildQueryStates(), 0x0e));
  console.log(`baseline ${base.length} records`);

  // map: for each block, toggle bypass both ways, find the record whose tag 0x01 flips
  const map: { rec: number; blockId: number; cell: number }[] = [];
  for (const blk of blocks) {
    await tell(buildSetBlockBypass(blk.blockId, true));
    const rByp = records(await ask(buildQueryStates(), 0x0e));
    await tell(buildSetBlockBypass(blk.blockId, false));
    const rEng = records(await ask(buildQueryStates(), 0x0e));
    let recIdx = -1;
    for (let i = 0; i < rByp.length; i++) if ((rByp[i]?.[0] ?? 0) !== (rEng[i]?.[0] ?? 0)) { recIdx = i; break; }
    // restore to baseline state for this block
    const wasEngaged = ((base[recIdx]?.[0] ?? 0) & 0x01) === 0x01;
    await tell(buildSetBlockBypass(blk.blockId, !wasEngaged ? true : false));
    map.push({ rec: recIdx, blockId: blk.blockId, cell: blk.cell });
    console.log(`  block ${blk.blockId} (cell ${blk.cell}) -> record ${recIdx}`);
  }

  // restore-verify
  const after = records(await ask(buildQueryStates(), 0x0e));
  const restoreOk = after.length === base.length && after.every((r, i) => hex(r) === hex(base[i] ?? []));
  console.log(`\nrestore ${restoreOk ? 'OK (frame matches baseline)' : 'MISMATCH'}`);

  // analysis
  const byRec = [...map].sort((a, b) => a.rec - b.rec);
  const W: string[] = [`# fn 0x0E record -> block map`, `> ${new Date().toISOString()}`, '',
    `grid (cell order): ${blocks.map((b) => b.blockId).join(', ')}`,
    `restore: ${restoreOk ? 'OK' : 'MISMATCH'}`, '',
    `| record | blockId | grid cell | b1..b4 (28-bit) | b28 == blockId? |`, `|---|---|---|---|---|`];
  console.log('\nrecord | blockId | cell | b1..b4(28bit) | ==blockId?');
  for (const m of byRec) {
    const val = b28(base[m.rec] ?? []);
    const eq = val === m.blockId ? 'YES' : '';
    console.log(`  ${m.rec}\t${m.blockId}\t${m.cell}\t${val}\t${eq}`);
    W.push(`| ${m.rec} | ${m.blockId} | ${m.cell} | ${val} | ${eq} |`);
  }
  const recOrderBlockIds = byRec.map((m) => m.blockId);
  const byIdAsc = [...recOrderBlockIds].sort((a, b) => a - b);
  const byCellOrder = [...map].sort((a, b) => a.cell - b.cell).map((m) => m.blockId);
  const cmp = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  W.push('', `## ordering basis`,
    `record order (blockIds): ${recOrderBlockIds.join(', ')}`,
    `blockId ascending:       ${byIdAsc.join(', ')}  ${cmp(recOrderBlockIds, byIdAsc) ? '<= MATCH' : ''}`,
    `grid-cell order:         ${byCellOrder.join(', ')}  ${cmp(recOrderBlockIds, byCellOrder) ? '<= MATCH' : ''}`);
  console.log(`\nrecord-order blockIds: ${recOrderBlockIds.join(', ')}`);
  console.log(`blockId ascending:     ${byIdAsc.join(', ')} ${cmp(recOrderBlockIds, byIdAsc) ? 'MATCH' : ''}`);
  console.log(`grid-cell order:       ${byCellOrder.join(', ')} ${cmp(recOrderBlockIds, byCellOrder) ? 'MATCH' : ''}`);

  mkdirSync('samples/captured', { recursive: true });
  writeFileSync(path.resolve('samples/captured/probe-axefx2-fn0e-record-map.md'), W.join('\n'));
  console.log('\nSaved samples/captured/probe-axefx2-fn0e-record-map.md');
  inp.closePort(); out.closePort(); process.exit(0);
}
main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
