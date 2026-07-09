/**
 * Axe-Fx II uncalibrated-knob DISPLAY-RANGE + TAPER sweep (SELF-RESTORING, SAFE).
 *
 * GOAL: capture device-true display ranges and tapers for the Axe-Fx II knobs
 * that are GENUINELY uncalibrated (no codec catalog range, no overlay, no
 * suffix rule — resolveParamKind(...).source === 'unknown'), by reading the
 * device's OWN display echo (fn 0x02 GET label), never the editor.
 *
 * SAFE BY CONSTRUCTION — we never write a loud extreme:
 *   - Amplitude / feedback / level params are EXCLUDED from all writing (name
 *     match on /level|volume|output|master|gain|drive|boost|input|feedback|
 *     regen|repeats|mix.*fb/) and listed separately as "skipped for safety".
 *   - For everything else we read the display at wire 0 (the minimum is always
 *     the quietest, safe) and at interior fractions 0.25 / 0.50 / 0.75 ONLY.
 *     We NEVER write wire 1.0 (max) or anything above 0.75 * 65534.
 *   - Every write is restored to the original wire and the restore is verified
 *     (flagged if |now - orig| > 2).
 *   - Editor pre-flight guard, paced sends, per-GET timeout, SIGINT/error
 *     abort-restore of the in-flight param.
 *   - Only fn 0x02 GET/SET. No save, no preset switch, no scene switch.
 *
 * From the 4 sampled points (f = 0, .25, .5, .75) we classify the taper
 * (linear / log10 / nonlinear) and EXTRAPOLATE the value at f = 1 (displayMax)
 * WITHOUT ever writing it. Output is a review-ready table plus a copy-paste
 * params.ts snippet. This script does NOT modify params.ts.
 *
 * Run:  npx tsx scripts/_research/probe-ii-uncalibrated-ranges.ts
 */
import midi, { type Input as MidiInput, type Output as MidiOutput } from "@julusian/midi";
import { writeFileSync } from 'node:fs';
import * as readline from 'node:readline';
import { guardAgainstRunningEditors } from '../_lib/editor-guard.js';
// Importing the descriptor self-registers the axe-fx-ii param-kind resolver,
// the same way scripts/verify-param-kind.ts does it. Without this import
// resolveParamKind('axe-fx-ii', ...) returns the UNKNOWN envelope for every
// param and the target filter collapses to "everything", which is wrong.
import '@mcp-midi-control/fractal-gen2/descriptor.js';
import { resolveParamKind } from '@mcp-midi-control/core/protocol-generic/paramKind.js';
import {
  KNOWN_PARAMS,
  type AxeFxIIParam,
  buildGetBlockParameterValue,
  isGetBlockParameterResponse,
  parseGetBlockParameterResponse,
  buildSetBlockParameterValueInteger,
} from 'fractal-midi/gen2/axe-fx-ii';
import { IDS_BY_GROUP } from '../../packages/fractal-midi/src/gen2/axe-fx-ii/blockTypes.js';
import { createSysExAssembler } from '../../packages/core/src/midi/transport.js';

const PACE_MS = 90, SETTLE_MS = 130, TIMEOUT_MS = 900;
const WIRE_MAX = 65534;
const SAFE_CEILING = Math.round(0.75 * WIRE_MAX); // hard cap: never exceed this on any write
const FRACTIONS = [0, 0.25, 0.5, 0.75] as const;

// User-facing blocks we sweep, mapped to their wiki group code. We use the
// first registered effectId for the group (IDS_BY_GROUP[group][0]).
const GROUP_BY_BLOCK: Record<string, string> = {
  amp: 'AMP', cab: 'CAB', reverb: 'REV', delay: 'DLY', chorus: 'CHO',
  flanger: 'FLG', phaser: 'PHA', rotary: 'ROT', compressor: 'CPR',
  drive: 'DRV', wah: 'WAH', pantrem: 'TRM', enhancer: 'ENH', filter: 'FLT',
  gate: 'GTE', pitch: 'PIT', multidelay: 'MTD', graphiceq: 'GEQ',
  parametriceq: 'PEQ',
};

// Amplitude / feedback params: EXCLUDED from all writing (can be loud or
// self-oscillate at high values). Collected separately, never written.
const UNSAFE_NAME = /level|volume|output|master|gain|drive|boost|input|feedback|regen|repeats|mix.*fb/i;

const find = (io: MidiInput | MidiOutput, ns: string[]): number => {
  for (let i = 0; i < io.getPortCount(); i++) if (ns.some((n) => io.getPortName(i).toLowerCase().includes(n))) return i;
  return -1;
};
const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

/** Parse the device's display label to a number (handles k/ms/% and a leading sign). */
function parseLabel(label: string): number | undefined {
  const s = label.trim();
  const m = s.match(/-?\d+(\.\d+)?/);
  if (!m) return undefined;
  let v = parseFloat(m[0]);
  if (/k/i.test(s)) v *= 1000;
  return v;
}

interface Taper {
  taper: 'linear' | 'log10' | 'nonlinear' | 'flat' | 'unclear';
  extrapMax: number | undefined;
  fit: string; // confidence: how well .25/.5 match the model implied by d0 + d75
}

/**
 * Classify the taper from the 4 sampled displays (f = 0, .25, .5, .75) and
 * extrapolate the value at f = 1 (the displayMax) WITHOUT writing it.
 *   - LINEAR: displays sit on a line through d0; predict d.25/.5 from d0 + slope.
 *   - LOG10: geometric, display(f) ~= d0 * r^f  (only when d0 > 0).
 *   - d0 == 0 makes log undefined, so it's a linear candidate only.
 * `fit` reports the worst relative residual of the .25/.5 interior points
 * against whichever model won.
 */
function classifyTaper(d0: number, d25: number, d50: number, d75: number): Taper {
  const span = Math.abs(d75 - d0);
  // Flat / dead param: no meaningful movement across the sweep.
  if (span < 1e-9 || span < Math.max(Math.abs(d0), Math.abs(d75)) * 1e-4) {
    return { taper: 'flat', extrapMax: d0, fit: 'n/a (flat)' };
  }

  // LINEAR model: line through (0, d0) with slope = (d75 - d0) / 0.75.
  const slope = (d75 - d0) / 0.75;
  const linPred = (f: number): number => d0 + slope * f;
  const linMax = d0 + slope; // value at f = 1
  const linRes = Math.max(
    Math.abs(d25 - linPred(0.25)),
    Math.abs(d50 - linPred(0.5)),
  ) / (span || 1);

  // LOG10 model (geometric): display(f) = d0 * r^f, r = d75 / d0, needs d0 > 0
  // and d75 same sign / positive. Skip when d0 <= 0.
  let logRes = Infinity;
  let logMax: number | undefined;
  if (d0 > 0 && d75 > 0) {
    const r = d75 / d0;               // = r^0.75 in f-space; fold the .75 exponent in below
    const logPred = (f: number): number => d0 * Math.pow(r, f / 0.75);
    logMax = d0 * Math.pow(r, 1 / 0.75); // value at f = 1
    logRes = Math.max(
      Math.abs(d25 - logPred(0.25)),
      Math.abs(d50 - logPred(0.5)),
    ) / (span || 1);
  }

  const TOL = 0.06; // 6% of span: interior points must track the model this well
  if (logRes < linRes && logRes <= TOL) {
    return { taper: 'log10', extrapMax: logMax, fit: `log10 residual ${(logRes * 100).toFixed(1)}%` };
  }
  if (linRes <= TOL) {
    return { taper: 'linear', extrapMax: linMax, fit: `linear residual ${(linRes * 100).toFixed(1)}%` };
  }
  // Neither model fits the interior points well: nonlinear curve we can't name
  // from 4 points. Report the better residual but do NOT extrapolate a max
  // (extrapolating off a model that doesn't fit would be a guess).
  const better = Math.min(linRes, logRes);
  const which = logRes < linRes ? 'log10' : 'linear';
  return { taper: 'nonlinear', extrapMax: undefined, fit: `best ${which} ${(better * 100).toFixed(1)}% (> ${(TOL * 100)}%)` };
}

/** Round an extrapolated display value to a sensible precision for review. */
function roundSensible(v: number): number {
  const a = Math.abs(v);
  if (a >= 1000) return Math.round(v / 10) * 10;
  if (a >= 100) return Math.round(v);
  if (a >= 10) return Math.round(v * 10) / 10;
  return Math.round(v * 100) / 100;
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
  await sleep(150);

  // ── Target selection ────────────────────────────────────────────────
  // Keep a param IF: it is a knob in a user-facing block AND the param-kind
  // resolver reports source === 'unknown' (no catalog range, no overlay, no
  // suffix rule). Then split into safe-to-sweep vs skipped-for-safety.
  const allParams = Object.values(KNOWN_PARAMS as Record<string, AxeFxIIParam>);
  const candidates = allParams.filter((p) => {
    if (!GROUP_BY_BLOCK[p.block]) return false;
    if (p.controlType !== 'knob') return false;
    const kind = resolveParamKind('axe-fx-ii', p.block, p.name);
    return kind.source === 'unknown';
  });

  const targets = candidates.filter((p) => !UNSAFE_NAME.test(p.name));
  const skipped = candidates.filter((p) => UNSAFE_NAME.test(p.name));

  console.log('Axe-Fx II uncalibrated-range + taper sweep (SAFE, self-restoring).');
  console.log('Safe-measurement approach: read display at wire 0 (always the quietest)');
  console.log('and at interior fractions 0.25 / 0.50 / 0.75 ONLY. We NEVER write wire');
  console.log(`max or anything above ${SAFE_CEILING} (0.75 * ${WIRE_MAX}). Every write is`);
  console.log('restored + verified. Amplitude/feedback params are skipped-for-safety.');
  console.log(`Targets to sweep: ${targets.length}.  Skipped-for-safety: ${skipped.length}.`);
  console.log(`Estimated wire time: ~${Math.round(targets.length * 5 * (PACE_MS + SETTLE_MS) / 1000)}s.\n`);

  // ── In-flight restore plumbing (SIGINT / error abort) ────────────────
  let cur: { eff: number; pid: number; orig: number } | undefined;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const restoreInFlight = (): void => {
    if (cur) {
      try { out.sendMessage(buildSetBlockParameterValueInteger({ effectId: cur.eff, paramId: cur.pid }, cur.orig)); } catch { /* best effort */ }
    }
  };
  const closePorts = (): void => { try { rl.close(); } catch { /**/ } try { inp.closePort(); } catch { /**/ } try { out.closePort(); } catch { /**/ } };
  process.on('SIGINT', () => { restoreInFlight(); closePorts(); process.exit(130); });

  const get = async (eff: number, pid: number): Promise<{ value: number; label: string } | undefined> => {
    frames.length = 0;
    out.sendMessage(buildGetBlockParameterValue({ effectId: eff, paramId: pid }));
    const t0 = Date.now();
    while (Date.now() - t0 < TIMEOUT_MS) {
      const f = frames.find((x) => isGetBlockParameterResponse(x, { effectId: eff, paramId: pid }));
      if (f) return parseGetBlockParameterResponse(f);
      await sleep(20);
    }
    return undefined;
  };
  const set = async (eff: number, pid: number, wire: number): Promise<void> => {
    // Absolute safety clamp: never let any write exceed the 0.75 ceiling.
    const w = Math.max(0, Math.min(SAFE_CEILING, Math.round(wire)));
    out.sendMessage(buildSetBlockParameterValueInteger({ effectId: eff, paramId: pid }, w));
    await sleep(SETTLE_MS);
  };

  const rows: string[] = [
    '| param | device d0 | d25 | d50 | d75 | taper | extrapolated max | fit | restored? |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  const snippetLines: string[] = [];
  const flags: string[] = [];
  let done = 0;

  try {
    for (const p of targets) {
      const eff = IDS_BY_GROUP[GROUP_BY_BLOCK[p.block]]?.[0];
      const key = `${p.block}.${p.name}`;
      if (eff === undefined) { rows.push(`| ${key} | (no effectId) | | | | | | | n/a |`); continue; }

      const before = await get(eff, p.paramId);
      if (!before) { rows.push(`| ${key} | (no GET) | | | | | | | skip |`); continue; }
      cur = { eff, pid: p.paramId, orig: before.value };

      // Sample the 4 safe fractions (0, .25, .5, .75). Never 1.0.
      const displays: (number | undefined)[] = [];
      const labels: (string | undefined)[] = [];
      for (const frac of FRACTIONS) {
        await sleep(PACE_MS);
        await set(eff, p.paramId, frac * WIRE_MAX);
        const r = await get(eff, p.paramId);
        labels.push(r?.label.trim());
        displays.push(r ? parseLabel(r.label) : undefined);
      }

      // Restore + verify.
      await sleep(PACE_MS);
      await set(eff, p.paramId, before.value);
      const chk = await get(eff, p.paramId);
      cur = undefined;
      const restored = !!chk && Math.abs(chk.value - before.value) <= 2;
      if (!restored) flags.push(`RESTORE FAILED on ${key} (orig ${before.value}, now ${chk?.value ?? '?'})`);

      const [d0, d25, d50, d75] = displays;
      let taperStr = 'no-read', extrapStr = '', fitStr = '';
      if (d0 !== undefined && d25 !== undefined && d50 !== undefined && d75 !== undefined) {
        const t = classifyTaper(d0, d25, d50, d75);
        taperStr = t.taper;
        fitStr = t.fit;
        if (t.extrapMax !== undefined) {
          const maxR = roundSensible(t.extrapMax);
          const minR = roundSensible(d0);
          extrapStr = String(maxR);
          // Build a copy-paste params.ts line (keyed by block.name). log10 gets
          // displayScale; linear omits it. Only emit when we trust the fit.
          const scale = t.taper === 'log10' ? `, displayScale: "log10"` : '';
          snippetLines.push(`  // "${key}": measured device sweep f=0/.25/.5/.75 -> ${d0}/${d25}/${d50}/${d75} (${t.fit})`);
          snippetLines.push(`  "${key}": { displayMin: ${minR}, displayMax: ${maxR}${scale} },`);
        }
      }

      rows.push(
        `| ${key} | ${labels[0] ?? '?'} | ${labels[1] ?? '?'} | ${labels[2] ?? '?'} | ${labels[3] ?? '?'} | ${taperStr} | ${extrapStr || '-'} | ${fitStr || '-'} | ${restored ? 'yes' : 'NO'} |`,
      );

      if (++done % 10 === 0) process.stderr.write(`  ...${done}/${targets.length}\n`);
      await sleep(PACE_MS);
    }
  } catch (err) {
    // Abort-restore the in-flight param, then re-throw to the top handler.
    restoreInFlight();
    cur = undefined;
    closePorts();
    throw err;
  }

  closePorts();

  // ── Report ───────────────────────────────────────────────────────────
  const skippedList = skipped.length
    ? skipped.map((p) => `- \`${p.block}.${p.name}\` (paramId ${p.paramId})`)
    : ['- none'];

  const report = [
    '# Axe-Fx II uncalibrated-range + taper sweep',
    '',
    'Device-true display ranges and tapers for the GENUINELY uncalibrated II',
    'knobs (resolveParamKind source === `unknown`), read from the device\'s own',
    'display echo. Safe-measurement: displays sampled at wire fractions',
    `0 / 0.25 / 0.50 / 0.75 ONLY (never max, never above ${SAFE_CEILING}); every`,
    'write restored and verified. The displayMax column is EXTRAPOLATED from the',
    'fitted taper at f = 1, never written to the device.',
    '',
    `Swept ${done}/${targets.length} target knobs. Skipped-for-safety: ${skipped.length}.`,
    '',
    '## Measured ranges',
    '',
    ...rows,
    '',
    '## Skipped for safety (amplitude / feedback — never written)',
    '',
    ...skippedList,
    '',
    '## Summary',
    '',
    `- Targets swept: ${done}`,
    `- Skipped for safety: ${skipped.length}`,
    `- Restore failures: ${flags.filter((f) => f.startsWith('RESTORE FAILED')).length}`,
    `- Candidate params.ts additions emitted: ${snippetLines.filter((l) => !l.trim().startsWith('//')).length}`,
    '',
    '## Flags',
    '',
    ...(flags.length ? flags.map((f) => `- ${f}`) : ['- none (all writes restored)']),
    '',
    '## Candidate params.ts additions (REVIEW before applying — copy/paste)',
    '',
    'One line per param keyed by `block.name`. `displayMin` is the device d0,',
    '`displayMax` is the extrapolated value at f = 1. `displayScale: "log10"` is',
    'emitted only where the sweep fit a geometric taper. Review each against the',
    'manual / front panel before pasting into `params.ts`. This script does NOT',
    'modify `params.ts`.',
    '',
    '```ts',
    ...(snippetLines.length ? snippetLines : ['  // (no confident extrapolations — all targets were flat/nonlinear/unread)']),
    '```',
    '',
  ].join('\n');

  writeFileSync('samples/captured/probe-ii-uncalibrated-ranges.md', report);

  console.log('\n=== FLAGS ===');
  if (flags.length) for (const f of flags) console.log('  ' + f);
  else console.log('  none: all writes restored.');
  console.log(`\nSwept ${done} knobs, skipped ${skipped.length} for safety.`);
  console.log('full table + paste-ready snippet: samples/captured/probe-ii-uncalibrated-ranges.md');
}

main().catch((e) => { console.error('ERROR:', e?.message ?? e); process.exit(1); });
