/**
 * VE-500 PITCH CORRECT read-back, READ-ONLY. Sends nothing but RQ1 queries.
 *
 * Companion to `ve500-shift-diagnostic.ts`. That script owns SHIFT; this one
 * reports the whole block in display units so a revert can be confirmed without
 * having to trust that the other three knobs were left alone.
 *
 * The four that matter tonight:
 *   TYPE       the character of the correction   (want ELECTRIC)
 *   SPEED      how hard it snaps                 (want 10)
 *   STABILITY  how much it resists wobble        (want +5)
 *   SHIFT      the interval used when NO MIDI note is arriving (want 0)
 *
 * SHIFT was borrowed as a two-state diagnostic and must come back to 0; the
 * other three are the maintainer's chosen sound and must NOT move. Reading them
 * in one pass is what makes "unchanged" a measurement rather than an assumption.
 *
 * Run:  npx tsx scripts/ve500-pcr-readback.ts
 */
import { connect } from '../packages/core/src/midi/transport.js';
import {
  findParam,
  buildGetParam,
  paramReplyMatcher,
  decodeParamReply,
  type Ve500ParamDef,
} from '../packages/roland-midi/src/ve-500/index.js';

/** param -> what the maintainer expects to see, in display units. */
const WANT: Readonly<Record<string, string>> = {
  type: 'ELECTRIC',
  speed: '10',
  stability: '+5',
  shift: '0',
};

const ORDER = ['type', 'speed', 'stability', 'shift'] as const;

/**
 * STABILITY reads 0..20 on the wire and the panel shows it signed, centred on
 * 10, so wire 15 is the panel's "+5". SPEED is a plain 0..10 with no offset.
 * Neither carries enum labels in the catalog, so the display shape is applied
 * here rather than invented at the call site.
 */
function display(param: string, def: Ve500ParamDef, wire: number): string {
  const label = def.enum_values?.[wire];
  if (label !== undefined) return String(label);
  if (param === 'stability') {
    const signed = wire - 10;
    return `${signed >= 0 ? '+' : ''}${signed}`;
  }
  return String(wire);
}

const conn = connect({ needles: ['ve-500', 've500'], notFoundLeadIn: 'VE-500 not found.' });

async function read(def: Ve500ParamDef): Promise<number | undefined> {
  const waiter = conn.receiveSysExMatching(paramReplyMatcher(def), 800).catch(() => undefined);
  conn.send(buildGetParam(def));
  const reply = await waiter;
  if (reply === undefined) return undefined;
  const v = decodeParamReply(def, reply);
  return typeof v === 'number' ? v : undefined;
}

console.log('\n=== VE-500 PITCH CORRECT, read-only ===\n');

let mismatches = 0;
let unread = 0;

for (const param of ORDER) {
  const def = findParam('pitch_correct', param);
  if (!def) {
    console.log(`  ${param.padEnd(10)} NOT IN CATALOG`);
    unread++;
    continue;
  }
  const wire = await read(def);
  if (wire === undefined) {
    console.log(`  ${param.padEnd(10)} NO REPLY  (treat as UNKNOWN, not as unchanged)`);
    unread++;
    continue;
  }
  const shown = display(param, def, wire);
  const want = WANT[param];
  const ok = shown === want;
  if (!ok) mismatches++;
  console.log(
    `  ${param.padEnd(10)} wire ${String(wire).padStart(3)}  =  ${shown.padEnd(10)} want ${want.padEnd(10)} ${ok ? 'OK' : 'MISMATCH'}`,
  );
  await new Promise((r) => setTimeout(r, 120));
}

console.log('');
if (unread > 0) console.log(`  ${unread} param(s) did not answer. Nothing was written either way.`);
console.log(mismatches === 0 && unread === 0 ? '  ALL FOUR AS EXPECTED.\n' : `  ${mismatches} mismatch(es).\n`);

conn.close();
process.exit(mismatches === 0 && unread === 0 ? 0 : 1);
