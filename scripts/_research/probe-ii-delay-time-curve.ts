/**
 * Axe-Fx II delay.time curve characterization (SELF-RESTORING).
 * delay.time (effectId 112, paramId 2) shipped linear but the midpoint sweep
 * showed it strongly non-linear (mid wire -> 375 ms, not 4000). Sweep the wire
 * at several fractions, read the device display, restore. delay time is not an
 * audio level, so the full range is safe. Read display, restore original.
 */
import midi from "@julusian/midi";
import { guardAgainstRunningEditors } from '../_lib/editor-guard.js';
import {
  buildGetBlockParameterValue, isGetBlockParameterResponse, parseGetBlockParameterResponse,
  buildSetBlockParameterValueInteger,
} from 'fractal-midi/gen2/axe-fx-ii';
import { createSysExAssembler } from '../../packages/core/src/midi/transport.js';

const EFF = 112, PID = 2, TIMEOUT = 900;
const find = (io: midi.Input | midi.Output, ns: string[]) => { for (let i = 0; i < io.getPortCount(); i++) if (ns.some((n) => io.getPortName(i).toLowerCase().includes(n))) return i; return -1; };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const parseLabel = (s: string): number | undefined => { const m = s.trim().match(/-?\d+(\.\d+)?/); if (!m) return undefined; let v = parseFloat(m[0]); if (/k/i.test(s)) v *= 1000; return v; };

async function main(): Promise<void> {
  guardAgainstRunningEditors();
  const out = new midi.Output(), inp = new midi.Input();
  const oi = find(out, ['axe-fx ii', 'axefxii', 'xl+', 'axe-fx']); const ii = find(inp, ['axe-fx ii', 'axefxii', 'xl+', 'axe-fx']);
  if (oi < 0 || ii < 0) { console.error('Axe-Fx II port not found'); process.exit(1); }
  out.openPort(oi); inp.openPort(ii); inp.ignoreTypes(false, true, true);
  const frames: number[][] = []; const asm = createSysExAssembler((f) => frames.push(f));
  inp.on('message', (_d, m) => asm(m));
  await sleep(150);

  const get = async (): Promise<{ value: number; label: string } | undefined> => {
    frames.length = 0; out.sendMessage(buildGetBlockParameterValue({ effectId: EFF, paramId: PID }));
    const t0 = Date.now(); while (Date.now() - t0 < TIMEOUT) { const f = frames.find((x) => isGetBlockParameterResponse(x, { effectId: EFF, paramId: PID })); if (f) return parseGetBlockParameterResponse(f); await sleep(20); } return undefined;
  };
  const set = async (w: number): Promise<void> => { out.sendMessage(buildSetBlockParameterValueInteger({ effectId: EFF, paramId: PID }, w)); await sleep(140); };

  const TEMPO_PID = 9; // delay.tempo; wire 0 = NONE (unlocks delay.time)
  const getPid = async (pid: number): Promise<{ value: number; label: string } | undefined> => {
    frames.length = 0; out.sendMessage(buildGetBlockParameterValue({ effectId: EFF, paramId: pid }));
    const t0 = Date.now(); while (Date.now() - t0 < TIMEOUT) { const f = frames.find((x) => isGetBlockParameterResponse(x, { effectId: EFF, paramId: pid })); if (f) return parseGetBlockParameterResponse(f); await sleep(20); } return undefined;
  };
  const setPid = async (pid: number, w: number): Promise<void> => { out.sendMessage(buildSetBlockParameterValueInteger({ effectId: EFF, paramId: pid }, w)); await sleep(140); };

  const origTempo = await getPid(TEMPO_PID);
  const orig = await get();
  if (!orig || !origTempo) { console.error('no GET for delay.time / delay.tempo'); process.exit(1); }
  console.log(`delay.tempo currently "${origTempo.label.trim()}" (wire ${origTempo.value}); setting to NONE (wire 0) to unlock delay.time, will restore.\n`);
  const restoreAll = () => { try { out.sendMessage(buildSetBlockParameterValueInteger({ effectId: EFF, paramId: PID }, orig.value)); out.sendMessage(buildSetBlockParameterValueInteger({ effectId: EFF, paramId: TEMPO_PID }, origTempo.value)); } catch { /**/ } };
  process.on('SIGINT', () => { restoreAll(); process.exit(130); });
  await setPid(TEMPO_PID, 0); // unlock

  const fracs = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  console.log('delay.time curve (wire fraction -> device display):\n');
  const pts: Array<{ f: number; wire: number; disp?: number; label: string }> = [];
  for (const f of fracs) {
    const wire = Math.round(f * 65534);
    await set(wire); await sleep(90);
    const r = await get();
    const disp = r ? parseLabel(r.label) : undefined;
    pts.push({ f, wire, disp, label: r?.label.trim() ?? '?' });
    console.log(`  wire ${String(wire).padStart(5)} (${(f * 100).toFixed(0).padStart(3)}%)  ->  ${r?.label.trim() ?? '?'}`);
    await sleep(90);
  }
  await set(orig.value); // restore time
  await setPid(TEMPO_PID, origTempo.value); // restore tempo
  const chk = await get(); const chkTempo = await getPid(TEMPO_PID);
  const ok = chk && Math.abs(chk.value - orig.value) <= 2 && chkTempo && chkTempo.value === origTempo.value;
  console.log(`\nrestore: time ${orig.value}->${chk?.value}, tempo "${origTempo.label.trim()}"->"${chkTempo?.label.trim()}" -> ${ok ? 'OK' : 'MISMATCH'}`);
  inp.closePort(); out.closePort();

  // Fit check: is display = min*(max/min)^f (log10) or min+(max-min)*f^k (power)?
  const lo = pts[0].disp ?? 1, hi = pts[pts.length - 1].disp ?? 8000;
  console.log(`\nendpoints: display ${lo} .. ${hi}`);
  const mid = pts.find((p) => p.f === 0.5)?.disp;
  if (mid) {
    console.log(`midpoint display ${mid}: linear pred ${((lo + hi) / 2).toFixed(0)}, log10 pred ${Math.sqrt(lo * hi).toFixed(1)}`);
    // power exponent from midpoint: mid = lo + (hi-lo)*0.5^k
    const k = Math.log((mid - lo) / (hi - lo)) / Math.log(0.5);
    console.log(`power-curve exponent k from midpoint: ${k.toFixed(2)} (display = lo + (hi-lo)*frac^k)`);
  }
  // per-point power-k estimate (excluding endpoints)
  console.log('\nper-point power-k (display = lo + (hi-lo)*frac^k):');
  for (const p of pts) { if (p.f > 0 && p.f < 1 && p.disp !== undefined && p.disp > lo) { const k = Math.log((p.disp - lo) / (hi - lo)) / Math.log(p.f); console.log(`  f=${p.f.toFixed(1)} disp=${p.disp} -> k=${k.toFixed(2)}`); } }
}
main().catch((e) => { console.error('ERROR:', e?.message ?? e); process.exit(1); });
