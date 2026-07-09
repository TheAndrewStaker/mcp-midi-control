/**
 * Axe-Fx II fn 0x0E bypass + scene bit binding (controlled differential)
 * ======================================================================
 * Binds the fn 0x0E QUERY_STATES record bits for BYPASS and SCENE using
 * controlled differentials, mirroring how the channel flag was bound:
 *   - bypass: read 0x0E, bypass AMP, read, engage AMP, read -> the bit
 *     that differs between bypassed and engaged is the bypass bit.
 *   - scene:  read 0x0E on the current scene, switch scene, read -> the
 *     bytes that change are scene-variant; the rest are whole-preset.
 * RESTORES original bypass + scene before exit. Reversible working-buffer
 * writes only; nothing saved to flash. Uses shipped fractal-midi builders.
 */
import midi from "@julusian/midi";
import { writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import {
  buildQueryStates, buildGetGridLayout, buildSetBlockBypass,
  buildSetSceneNumber, buildGetSceneNumber, parseSceneNumberResponse,
} from 'fractal-midi/gen2/axe-fx-ii';

const F0 = 0xf0, AMP = 106;
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const find = (io: midi.Input | midi.Output, ns: string[]) => { for (let i = 0; i < io.getPortCount(); i++) if (ns.some((n) => io.getPortName(i).toLowerCase().includes(n))) return i; return -1; };

function records(frame: number[] | undefined): number[][] {
  if (!frame) return [];
  const sp = frame.slice(6, frame.length - 1); // checksum-less: strip 6B header + F7
  const recs: number[][] = [];
  for (let r = 0; r + 5 <= sp.length; r += 5) recs.push(sp.slice(r, r + 5));
  return recs;
}
function diffRecords(a: number[][], b: number[][]): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ra = a[i] ?? [], rb = b[i] ?? [];
    const changed = ra.some((x, j) => x !== rb[j]) || ra.length !== rb.length;
    if (changed) {
      const bits = ra.map((x, j) => `b${j}:${x.toString(16)}^${(rb[j] ?? 0).toString(16)}=${(x ^ (rb[j] ?? 0)).toString(16)}`).join(' ');
      out.push(`  rec${i}: ${hex(ra)}  ->  ${hex(rb)}   [${bits}]`);
    }
  }
  return out.length ? out : ['  (no record changed)'];
}

async function main() {
  const out = new midi.Output(), inp = new midi.Input();
  const oi = find(out, ['axe-fx ii', 'axefxii', 'xl+', 'axe-fx']);
  const ii = find(inp, ['axe-fx ii', 'axefxii', 'xl+', 'axe-fx']);
  if (oi < 0 || ii < 0) { console.error('Axe-Fx II port not found'); process.exit(1); }
  out.openPort(oi); inp.ignoreTypes(false, true, true);
  const got: number[][] = []; inp.on('message', (_d, b) => { if (b[0] === F0) got.push(b.slice()); }); inp.openPort(ii);
  await sleep(300);

  const ask = async (frame: number[], fn: number, ms = 1200): Promise<number[] | undefined> => {
    const before = got.length; out.sendMessage(frame); await sleep(ms);
    return got.slice(before).find((f) => f[5] === fn);
  };
  const tell = async (frame: number[], ms = 500): Promise<void> => { out.sendMessage(frame); await sleep(ms); };

  // current scene (for restore)
  const sceneResp = await ask(buildGetSceneNumber(), 0x29, 600);
  const scene0 = sceneResp ? parseSceneNumberResponse(sceneResp) : 0;
  console.log(`current scene = ${scene0}`);

  const W: string[] = [`# Axe-Fx II fn 0x0E bypass + scene differential`, `> ${new Date().toISOString()}`, '', `current scene = ${scene0}`, ''];

  // baseline
  const rec0 = records(await ask(buildQueryStates(), 0x0e));
  console.log(`baseline: ${rec0.length} records; rec0(AMP)=${hex(rec0[0] ?? [])}`);
  W.push(`## baseline (${rec0.length} records)`, '```', ...rec0.map((r, i) => `rec${i}: ${hex(r)}`), '```', '');

  // --- BYPASS differential on AMP ---
  console.log('\n[bypass] AMP -> BYPASSED');
  await tell(buildSetBlockBypass(AMP, true));
  const recByp = records(await ask(buildQueryStates(), 0x0e));
  console.log('[bypass] AMP -> ENGAGED');
  await tell(buildSetBlockBypass(AMP, false));
  const recEng = records(await ask(buildQueryStates(), 0x0e));
  W.push('## bypass differential (AMP, eid 106)', '', 'bypassed vs engaged:', '```', ...diffRecords(recByp, recEng), '```', '');
  console.log('bypassed vs engaged diff:'); diffRecords(recByp, recEng).forEach((l) => console.log(l));

  // restore bypass to original (match baseline AMP record)
  const ampBase = hex(rec0[0] ?? []);
  const wasBypassed = ampBase === hex(recByp[0] ?? []);
  console.log(`[restore] AMP baseline=${ampBase} -> ${wasBypassed ? 'BYPASSED' : 'ENGAGED'}`);
  await tell(buildSetBlockBypass(AMP, wasBypassed));
  const recRestoreB = records(await ask(buildQueryStates(), 0x0e));
  W.push(`bypass restore -> ${wasBypassed ? 'bypassed' : 'engaged'}; AMP rec now ${hex(recRestoreB[0] ?? [])} (baseline ${ampBase}) ${hex(recRestoreB[0] ?? []) === ampBase ? 'OK' : 'MISMATCH'}`, '');

  // --- SCENE differential ---
  const sceneAlt = scene0 === 0 ? 1 : 0;
  console.log(`\n[scene] ${scene0} -> ${sceneAlt}`);
  await tell(buildSetSceneNumber(sceneAlt), 700);
  const recScene = records(await ask(buildQueryStates(), 0x0e));
  W.push(`## scene differential (scene ${scene0} -> ${sceneAlt})`, '', '```', ...diffRecords(rec0, recScene), '```', '');
  console.log(`scene ${scene0} vs ${sceneAlt} diff:`); diffRecords(rec0, recScene).forEach((l) => console.log(l));
  // restore scene
  console.log(`[restore] scene -> ${scene0}`);
  await tell(buildSetSceneNumber(scene0), 700);
  const recRestoreS = records(await ask(buildQueryStates(), 0x0e));
  W.push('', `scene restore -> ${scene0}; frame ${hex(recRestoreS[0] ?? []) === ampBase ? 'rec0 matches baseline' : 'rec0=' + hex(recRestoreS[0] ?? [])}`, '');

  mkdirSync('samples/captured', { recursive: true });
  writeFileSync(path.resolve('samples/captured/probe-axefx2-fn0e-bypass-scene-diff.md'), W.join('\n'));
  console.log('\nSaved samples/captured/probe-axefx2-fn0e-bypass-scene-diff.md');
  inp.closePort(); out.closePort(); process.exit(0);
}
main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
