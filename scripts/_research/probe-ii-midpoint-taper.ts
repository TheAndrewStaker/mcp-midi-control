/**
 * Axe-Fx II midpoint-display taper sweep (SELF-RESTORING, midpoint-only writes).
 *
 * For each taper-meaningful knob (positive displayMin, multi-decade range,
 * where linear vs log10 actually differs), set the wire to its MIDPOINT (32767,
 * never an extreme), read the device's own display echo (fn 0x02 GET label),
 * then restore the original wire and verify. The midpoint display tells the
 * taper directly: linear -> ~(min+max)/2, log10 -> ~sqrt(min*max).
 *
 * Safe by construction: only midpoint writes (no max/min, nothing gets blasted),
 * every write restored + verified, editor pre-flight guard, paced, per-tx
 * timeout, abort-restore. Reads the device display, never the editor.
 */
import midi from "@julusian/midi";
import { writeFileSync } from 'node:fs';
import { guardAgainstRunningEditors } from '../_lib/editor-guard.js';
import {
  KNOWN_PARAMS,
  buildGetBlockParameterValue,
  isGetBlockParameterResponse,
  parseGetBlockParameterResponse,
  buildSetBlockParameterValueInteger,
} from 'fractal-midi/gen2/axe-fx-ii';
import { IDS_BY_GROUP } from '../../packages/fractal-midi/src/gen2/axe-fx-ii/blockTypes.js';
import { createSysExAssembler } from '../../packages/core/src/midi/transport.js';

const PACE_MS = 90, SETTLE_MS = 130, TIMEOUT_MS = 900, MID = 32767;
const find = (io: midi.Input | midi.Output, ns: string[]) => { for (let i = 0; i < io.getPortCount(); i++) if (ns.some((n) => io.getPortName(i).toLowerCase().includes(n))) return i; return -1; };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const GROUP_BY_BLOCK: Record<string, string> = { amp: 'AMP', cab: 'CAB', reverb: 'REV', delay: 'DLY', chorus: 'CHO', flanger: 'FLG', phaser: 'PHA', rotary: 'ROT', compressor: 'CPR', drive: 'DRV', wah: 'WAH', pantrem: 'TRM', enhancer: 'ENH', filter: 'FLT', gate: 'GTE', pitch: 'PIT', multidelay: 'MTD', graphiceq: 'GEQ', parametriceq: 'PEQ' };

/** Parse the device's display label to a number (handles k/ms/% and a leading sign). */
function parseLabel(label: string): number | undefined {
  const s = label.trim();
  const m = s.match(/-?\d+(\.\d+)?/);
  if (!m) return undefined;
  let v = parseFloat(m[0]);
  if (/k/i.test(s)) v *= 1000;
  return v;
}

async function main(): Promise<void> {
  guardAgainstRunningEditors();
  const out = new midi.Output(), inp = new midi.Input();
  const oi = find(out, ['axe-fx ii', 'axefxii', 'xl+', 'axe-fx']);
  const ii = find(inp, ['axe-fx ii', 'axefxii', 'xl+', 'axe-fx']);
  if (oi < 0 || ii < 0) { console.error('Axe-Fx II port not found'); process.exit(1); }
  out.openPort(oi); inp.openPort(ii); inp.ignoreTypes(false, true, true);
  const frames: number[][] = [];
  const asm = createSysExAssembler((f) => frames.push(f));
  inp.on('message', (_d, m) => asm(m));

  // Taper-meaningful targets: positive min, range spans >= 8x (linear vs log differ).
  const targets = Object.values(KNOWN_PARAMS as Record<string, any>).filter((p) => {
    if (!GROUP_BY_BLOCK[p.block] || p.controlType !== 'knob') return false;
    const { displayMin: lo, displayMax: hi } = p;
    return typeof lo === 'number' && typeof hi === 'number' && lo > 0 && hi / lo >= 8;
  });

  console.log(`II midpoint-display taper sweep (self-restoring, midpoint-only writes)`);
  console.log(`${targets.length} taper-meaningful knobs, ~${Math.round(targets.length * 4 * (PACE_MS + 60) / 1000)}s. Only wire ${MID} writes; each restored.\n`);

  let cur: { eff: number; pid: number; orig: number } | undefined;
  const restore = () => { if (cur) { try { out.sendMessage(buildSetBlockParameterValueInteger({ effectId: cur.eff, paramId: cur.pid }, cur.orig)); } catch { /* best effort */ } } };
  process.on('SIGINT', () => { restore(); inp.closePort(); out.closePort(); process.exit(130); });

  const get = async (eff: number, pid: number): Promise<{ value: number; label: string } | undefined> => {
    frames.length = 0;
    out.sendMessage(buildGetBlockParameterValue({ effectId: eff, paramId: pid }));
    const t0 = Date.now();
    while (Date.now() - t0 < TIMEOUT_MS) { const f = frames.find((x) => isGetBlockParameterResponse(x, { effectId: eff, paramId: pid })); if (f) return parseGetBlockParameterResponse(f); await sleep(20); }
    return undefined;
  };
  const set = async (eff: number, pid: number, wire: number): Promise<void> => { out.sendMessage(buildSetBlockParameterValueInteger({ effectId: eff, paramId: pid }, wire)); await sleep(SETTLE_MS); };

  const rows: string[] = ['| param | catalog range | shipped | mid display | linear pred | log10 pred | verdict |', '|---|---|---|---|---|---|---|'];
  const flags: string[] = [];
  let done = 0;
  for (const p of targets) {
    const eff = IDS_BY_GROUP[GROUP_BY_BLOCK[p.block]]?.[0];
    if (eff === undefined) continue;
    const key = `${p.block}.${p.name}`;
    const before = await get(eff, p.pid ?? p.paramId);
    if (!before) { rows.push(`| ${key} | ${p.displayMin}..${p.displayMax} | | (no GET) | | | skip |`); continue; }
    cur = { eff, pid: p.paramId, orig: before.value };
    await sleep(PACE_MS);
    await set(eff, p.paramId, MID);
    const mid = await get(eff, p.paramId);
    await sleep(PACE_MS);
    await set(eff, p.paramId, before.value); // restore
    const chk = await get(eff, p.paramId);
    cur = undefined;
    const restored = chk && Math.abs(chk.value - before.value) <= 2;
    if (!restored) { flags.push(`RESTORE FAILED on ${key} (orig ${before.value}, now ${chk?.value})`); }
    const midNum = mid ? parseLabel(mid.label) : undefined;
    const lo = p.displayMin, hi = p.displayMax;
    const linPred = (lo + hi) / 2, logPred = Math.sqrt(lo * hi);
    let verdict = 'unclear';
    if (midNum !== undefined) {
      const dLin = Math.abs(midNum - linPred), dLog = Math.abs(midNum - logPred);
      const tol = Math.max(linPred, logPred) * 0.15;
      if (dLog < dLin && dLog < tol) verdict = 'log10';
      else if (dLin < dLog && dLin < tol) verdict = 'linear';
      const shipped = p.displayScale === 'log10' ? 'log10' : 'linear';
      if (verdict !== 'unclear' && verdict !== shipped) flags.push(`TAPER MISMATCH ${key}: shipped ${shipped}, measured ${verdict} (mid ${midNum}, lin ${linPred.toFixed(2)}, log ${logPred.toFixed(2)})`);
    }
    rows.push(`| ${key} | ${lo}..${hi} | ${p.displayScale ?? 'linear'} | ${mid ? mid.label.trim() : '?'} | ${linPred.toFixed(2)} | ${logPred.toFixed(2)} | ${verdict} |`);
    if (++done % 10 === 0) process.stderr.write(`  ...${done}/${targets.length}\n`);
    await sleep(PACE_MS);
  }
  inp.closePort(); out.closePort();

  const report = [`# II midpoint-display taper sweep (2026-06-10)`, ``, `${done} knobs swept, all midpoint-only + restored.`, ``, ...rows, ``, `## Flags`, ...(flags.length ? flags.map((f) => `- ${f}`) : ['- none (all restored, no taper mismatches)'])].join('\n');
  writeFileSync('samples/captured/probe-ii-midpoint-taper.md', report);
  console.log(`\n=== FLAGS ===`);
  for (const f of flags) console.log('  ' + f);
  if (!flags.length) console.log('  none: all writes restored, shipped tapers match measured.');
  console.log(`\nfull table: samples/captured/probe-ii-midpoint-taper.md`);
}
main().catch((e) => { console.error('ERROR:', e?.message ?? e); process.exit(1); });
