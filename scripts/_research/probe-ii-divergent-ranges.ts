/**
 * Axe-Fx II divergent-range resolver (SELF-RESTORING).
 * For the params where fn 0x16 internal extent did NOT scale cleanly to the
 * catalog display range, read the device's OWN display at wire 0 / mid / max
 * to get the true display range + taper, then restore. These are non-audio
 * amp/cab knobs (resonance / cathode / room size), safe to sweep fully.
 */
import midi from "@julusian/midi";
import { writeFileSync } from 'node:fs';
import { guardAgainstRunningEditors } from '../_lib/editor-guard.js';
import {
  buildGetBlockParameterValue, isGetBlockParameterResponse, parseGetBlockParameterResponse,
  buildSetBlockParameterValueInteger,
} from 'fractal-midi/gen2/axe-fx-ii';
import { createSysExAssembler } from '../../packages/core/src/midi/transport.js';

const TIMEOUT = 900;
const find = (io: midi.Input | midi.Output, ns: string[]) => { for (let i = 0; i < io.getPortCount(); i++) if (ns.some((n) => io.getPortName(i).toLowerCase().includes(n))) return i; return -1; };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const parseLabel = (s: string): number | undefined => { const m = s.trim().match(/-?\d+(\.\d+)?/); if (!m) return undefined; let v = parseFloat(m[0]); if (/k/i.test(s)) v *= 1000; return v; };

// catalog (block.name, effectId, paramId, catalog display range)
const TARGETS = [
  { key: 'amp.low_res', eff: 106, pid: 27, cat: '0..10' },
  { key: 'amp.cathode_resist', eff: 106, pid: 93, cat: '0..100' },
  { key: 'cab.room_size', eff: 108, pid: 17, cat: '1..10' },
];

async function main(): Promise<void> {
  guardAgainstRunningEditors();
  const out = new midi.Output(), inp = new midi.Input();
  const oi = find(out, ['axe-fx ii', 'axefxii', 'xl+', 'axe-fx']); const ii = find(inp, ['axe-fx ii', 'axefxii', 'xl+', 'axe-fx']);
  if (oi < 0 || ii < 0) { console.error('Axe-Fx II port not found'); process.exit(1); }
  out.openPort(oi); inp.openPort(ii); inp.ignoreTypes(false, true, true);
  const frames: number[][] = []; const asm = createSysExAssembler((f) => frames.push(f));
  inp.on('message', (_d, m) => asm(m));
  await sleep(150);

  const get = async (eff: number, pid: number): Promise<{ value: number; label: string } | undefined> => {
    frames.length = 0; out.sendMessage(buildGetBlockParameterValue({ effectId: eff, paramId: pid }));
    const t0 = Date.now(); while (Date.now() - t0 < TIMEOUT) { const f = frames.find((x) => isGetBlockParameterResponse(x, { effectId: eff, paramId: pid })); if (f) return parseGetBlockParameterResponse(f); await sleep(20); } return undefined;
  };
  const set = async (eff: number, pid: number, w: number): Promise<void> => { out.sendMessage(buildSetBlockParameterValueInteger({ effectId: eff, paramId: pid }, w)); await sleep(140); };

  let cur: { eff: number; pid: number; orig: number } | undefined;
  process.on('SIGINT', () => { if (cur) { try { out.sendMessage(buildSetBlockParameterValueInteger({ effectId: cur.eff, paramId: cur.pid }, cur.orig)); } catch { /**/ } } process.exit(130); });

  const rows: string[] = ['| param | catalog | device @0 | @mid | @max | taper | verdict |', '|---|---|---|---|---|---|---|'];
  for (const t of TARGETS) {
    const before = await get(t.eff, t.pid);
    if (!before) { rows.push(`| ${t.key} | ${t.cat} | (no GET) | | | | skip |`); continue; }
    cur = { eff: t.eff, pid: t.pid, orig: before.value };
    await set(t.eff, t.pid, 0); const d0 = await get(t.eff, t.pid);
    await set(t.eff, t.pid, 32767); const dm = await get(t.eff, t.pid);
    await set(t.eff, t.pid, 65534); const dh = await get(t.eff, t.pid);
    await set(t.eff, t.pid, before.value); const chk = await get(t.eff, t.pid); // restore
    cur = undefined;
    const lo = d0 ? parseLabel(d0.label) : undefined, mid = dm ? parseLabel(dm.label) : undefined, hi = dh ? parseLabel(dh.label) : undefined;
    let taper = '?';
    if (lo !== undefined && mid !== undefined && hi !== undefined && lo > 0) {
      const lin = (lo + hi) / 2, log = Math.sqrt(lo * hi);
      taper = Math.abs(mid - log) < Math.abs(mid - lin) ? 'log10?' : 'linear?';
    } else if (lo !== undefined && mid !== undefined && hi !== undefined) {
      taper = Math.abs(mid - (lo + hi) / 2) < Math.abs(hi - lo) * 0.1 ? 'linear?' : 'nonlinear';
    }
    const deviceRange = `${lo}..${hi}`;
    const verdict = `${t.cat}` === deviceRange ? 'catalog OK' : `device says ${deviceRange}`;
    const restored = chk && Math.abs(chk.value - before.value) <= 2 ? '' : '  [RESTORE FAIL]';
    rows.push(`| ${t.key} | ${t.cat} | ${d0?.label.trim() ?? '?'} | ${dm?.label.trim() ?? '?'} | ${dh?.label.trim() ?? '?'} | ${taper} | ${verdict}${restored} |`);
    console.log(`  ${t.key}: catalog ${t.cat}, DEVICE ${deviceRange} (mid ${dm?.label.trim()}) -> ${verdict}${restored}`);
  }
  inp.closePort(); out.closePort();
  writeFileSync('samples/captured/probe-ii-divergent-ranges.md', ['# II divergent-range resolution (2026-06-10)', '', ...rows].join('\n'));
  console.log('\nfull table: samples/captured/probe-ii-divergent-ranges.md');
}
main().catch((e) => { console.error('ERROR:', e?.message ?? e); process.exit(1); });
