// probe-am4-dynacab-roster.ts - HW-133 DynaCab roster oracle (BK-104 stage 2).
//
// Enumerates the AM4's stock DynaCab picker by NAME, using the
// CABINET_TYPE1_NAME string register discovered in the Ghidra CABINET
// dispatcher table (catalog id 73; id = pidHigh identity map → 0x49).
// Same register family as the 0x00CE preset-name reads, so the name is
// expected either as plain ASCII or in the HW-122 3-byte-per-2-char
// chunked encoding (both attempted).
//
// Anchor: the session-41 capture + screenshot pin DynaCab TYPE1 (0x41)
// wire float 40.0 ↔ display "41: 4x12 Rumble EV12L". Phase A sets
// TYPE1 = 40 and expects the name read to contain "Rumble"; that
// self-validates the read shape before the sweep trusts it.
//
// Mic roster: the catalog has NO CABINET_MIC*_NAME register, so mic
// NAMES are not readable this way. The mic sweep only measures the
// roster SIZE via write-then-readback clamping; mic names come from a
// single AM4-Edit dropdown screenshot (no scrolling needed).
//
// Touches the WORKING BUFFER ONLY (DynaCab TYPE1 + MIC1 registers on
// the active preset's amp block). Never saves. Original values are
// read first and restored at the end; the buffer-edited bit will still
// be set afterwards - switch presets or reload to discard.
//
// Fully automated read-and-compare (no human observation step), so
// timer pacing is fine per RE-WORKFLOW's probe design rule.
//
// Usage: npx tsx scripts/_research/probe-am4-dynacab-roster.ts
//   (requires an amp block in the active preset - any factory preset works)

import { mkdirSync, writeFileSync } from 'node:fs';
import { connectAM4 } from '@mcp-midi-control/am4/midi.js';
import {
  sendReadAndParseRaw,
  readActiveBufferEditedBit,
} from '@mcp-midi-control/am4/shared/readOps.js';
import { recordInbound } from '@mcp-midi-control/am4/shared/wireOps.js';
import { buildSetFloatParam, buildReadParam } from 'fractal-midi/am4';

const PIDLOW_CABINET = 0x3e;
const PID_DYNACAB_TYPE1 = 0x41; // CABINET_DYNACAB_TYPE1 (catalog id 65)
const PID_DYNACAB_MIC1 = 0x43; // CABINET_DYNACAB_MIC1  (catalog id 67)
const PID_TYPE1_NAME = 0x49; //   CABINET_TYPE1_NAME    (catalog id 73)

/** Anchor from session-41: TYPE1 wire 40 ↔ display "41: 4x12 Rumble EV12L". */
const ANCHOR_INDEX = 40;
const ANCHOR_SUBSTRING = 'rumble';

const SWEEP_MAX_TYPE = 64; // stock roster is ~45; leave headroom
const SWEEP_MAX_MIC = 16;
const SETTLE_MS = 60;
const RECON_WINDOW_MS = 400;
const OUT_JSON = 'samples/captured/decoded/am4-dynacab-roster.json';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── decode helpers ──────────────────────────────────────────────────

/** Plain printable-ASCII run extraction. */
function asciiRuns(bytes: number[], minLen = 3): string[] {
  const runs: string[] = [];
  let cur = '';
  for (const b of bytes) {
    if (b >= 0x20 && b <= 0x7e) {
      cur += String.fromCharCode(b);
    } else {
      if (cur.length >= minLen) runs.push(cur);
      cur = '';
    }
  }
  if (cur.length >= minLen) runs.push(cur);
  return runs;
}

/**
 * HW-122 AM4 name encoding: independent 3-byte groups, 2 chars each.
 *   byte0 = char0 & 0x7F
 *   byte1 = (char0 >> 7) | ((char1 & 0x3F) << 1)
 *   byte2 = (char1 >> 6) & 0x03
 * (Inlined from scripts/_research/decode-am4-preset-name.ts to avoid
 * importing a script that emits files on import.)
 */
function decodeChunked32(wire: number[]): string {
  const chars: number[] = [];
  for (let g = 0; g + 2 < wire.length; g += 3) {
    const b0 = wire[g];
    const b1 = wire[g + 1];
    const b2 = wire[g + 2];
    chars.push((b0 & 0x7f) | ((b1 & 0x01) << 7));
    chars.push(((b1 >> 1) & 0x3f) | ((b2 & 0x03) << 6));
  }
  return String.fromCharCode(...chars.filter((c) => c >= 0x20 && c <= 0x7e)).trimEnd();
}

interface NameCandidate {
  method: 'ascii' | 'chunked3per2';
  payloadOffset: number;
  text: string;
}

/** Try every plausible decode of one inbound frame; return non-empty candidates. */
function candidateNames(frame: number[]): NameCandidate[] {
  const out: NameCandidate[] = [];
  // header layouts vary by response family - try a few payload starts
  for (const off of [10, 12, 14, 16]) {
    const payload = frame.slice(off, frame.length - 2); // strip checksum + F7
    for (const run of asciiRuns(payload, 4)) {
      out.push({ method: 'ascii', payloadOffset: off, text: run });
    }
    const chunked = decodeChunked32(payload);
    if (chunked.length >= 4 && /[a-zA-Z]{3}/.test(chunked)) {
      out.push({ method: 'chunked3per2', payloadOffset: off, text: chunked });
    }
  }
  // dedupe by text, keep the first occurrence
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.text) ? false : (seen.add(c.text), true)));
}

const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');

// ── wire helpers ────────────────────────────────────────────────────

type Conn = ReturnType<typeof connectAM4>;

async function readU32(conn: Conn, pidHigh: number): Promise<number> {
  const { parsed } = await sendReadAndParseRaw(conn, PIDLOW_CABINET, pidHigh);
  return parsed.asUInt32LE();
}

async function writeIndex(conn: Conn, pidHigh: number, index: number): Promise<void> {
  // Captured TYPE/MIC writes carry the index as a plain packed float
  // (session-41: 0x41 = float 40.0 while display showed "41: ...").
  conn.send(buildSetFloatParam({ pidLow: PIDLOW_CABINET, pidHigh }, index));
  await sleep(SETTLE_MS);
}

/**
 * Fire a name-register read and capture EVERY inbound frame for
 * RECON_WINDOW_MS (response shape unknown, so no matcher).
 */
async function readNameRaw(conn: Conn, readType: number): Promise<number[][]> {
  const cap = recordInbound(conn);
  try {
    conn.send(buildReadParam({ pidLow: PIDLOW_CABINET, pidHigh: PID_TYPE1_NAME }, readType));
    await sleep(RECON_WINDOW_MS);
    return cap.observed.map((o) => o.bytes);
  } finally {
    cap.unsubscribe();
  }
}

// ── main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const conn = connectAM4();
  const startedDirty = await readActiveBufferEditedBit(conn).catch(() => undefined);
  console.log('=== HW-133 DynaCab roster probe (working buffer only, never saves) ===');
  if (startedDirty) {
    console.log('NOTE: buffer already has unsaved edits. Probe restores what it changes,');
    console.log('      but consider reloading the preset afterwards anyway.\n');
  }

  // Baseline (read-before-write, restored at the end).
  let origType1: number;
  let origMic1: number;
  try {
    origType1 = await readU32(conn, PID_DYNACAB_TYPE1);
    origMic1 = await readU32(conn, PID_DYNACAB_MIC1);
  } catch (e) {
    console.error('Baseline read of DynaCab TYPE1/MIC1 failed - is an amp block placed?');
    console.error('Switch to any factory preset with an amp (e.g. A01) and re-run.');
    conn.close();
    throw e;
  }
  console.log(`Baseline: TYPE1=${origType1} MIC1=${origMic1}\n`);

  // ── Phase A: anchor + name-read recon at TYPE1 = 40 (expect "Rumble") ──
  console.log(`Phase A: setting TYPE1 = ${ANCHOR_INDEX} (expect "41: 4x12 Rumble EV12L")`);
  await writeIndex(conn, PID_DYNACAB_TYPE1, ANCHOR_INDEX);
  const landed = await readU32(conn, PID_DYNACAB_TYPE1);
  console.log(`  readback TYPE1 = ${landed} ${landed === ANCHOR_INDEX ? '(landed)' : '(!! did not land)'}`);

  let nameReadType: number | undefined;
  const reconLog: Array<{ readType: number; frames: string[]; candidates: NameCandidate[] }> = [];
  for (const readType of [0x0e, 0x0d]) {
    console.log(`\n  name-read recon: action 0x${readType.toString(16).padStart(2, '0')} on 0x3e/0x49`);
    const frames = await readNameRaw(conn, readType);
    const cands = frames.flatMap(candidateNames);
    reconLog.push({ readType, frames: frames.map(hex), candidates: cands });
    if (frames.length === 0) console.log('    (no response)');
    for (const f of frames) console.log(`    frame[${f.length}]: ${hex(f).slice(0, 120)}${f.length > 40 ? ' …' : ''}`);
    for (const c of cands) console.log(`    candidate (${c.method} @${c.payloadOffset}): "${c.text}"`);
    if (cands.some((c) => c.text.toLowerCase().includes(ANCHOR_SUBSTRING))) {
      nameReadType = readType;
      console.log(`    ✅ anchor "${ANCHOR_SUBSTRING}" found - name read WORKS via action 0x${readType.toString(16)}`);
      break;
    }
  }

  const roster: Record<number, string> = {};
  let micAcceptedMax = -1;

  if (nameReadType === undefined) {
    console.log('\n❌ Name register did not yield the anchor name under either read action.');
    console.log('   Hypothesis dead (or encoding differs). Raw recon frames are in the JSON -');
    console.log('   fall back to the AM4-Edit dropdown screenshots (HW-133 fallback) and');
    console.log('   paste this output back into the session.');
  } else {
    // ── Phase B: TYPE1 sweep 0..N with clamp + repeat detection ──
    console.log(`\nPhase B: sweeping TYPE1 0..${SWEEP_MAX_TYPE - 1}`);
    let lastName = '';
    let repeats = 0;
    for (let i = 0; i < SWEEP_MAX_TYPE; i++) {
      await writeIndex(conn, PID_DYNACAB_TYPE1, i);
      const rb = await readU32(conn, PID_DYNACAB_TYPE1);
      if (rb !== i) {
        console.log(`  index ${i}: readback ${rb} → device clamped; roster ends at ${rb}`);
        break;
      }
      const frames = await readNameRaw(conn, nameReadType);
      const cand = frames
        .flatMap(candidateNames)
        .find((c) => c.text.length >= 4);
      const name = cand?.text ?? '(no decode)';
      roster[i] = name;
      console.log(`  ${String(i).padStart(2)} → "${name}"`);
      if (name === lastName) {
        repeats++;
        if (repeats >= 2) {
          console.log('  (same name three times running - treating as roster end)');
          break;
        }
      } else {
        repeats = 0;
        lastName = name;
      }
    }

    // ── Phase C: MIC1 size probe (no name register for mics) ──
    console.log(`\nPhase C: MIC1 clamp probe 0..${SWEEP_MAX_MIC - 1} (size only; names via dropdown)`);
    for (let i = 0; i < SWEEP_MAX_MIC; i++) {
      await writeIndex(conn, PID_DYNACAB_MIC1, i);
      const rb = await readU32(conn, PID_DYNACAB_MIC1);
      if (rb !== i) {
        console.log(`  mic index ${i}: readback ${rb} → clamped; mic roster spans 0..${micAcceptedMax}`);
        break;
      }
      micAcceptedMax = i;
    }
    if (micAcceptedMax === SWEEP_MAX_MIC - 1) {
      console.log(`  (no clamp seen up to ${SWEEP_MAX_MIC - 1} - widen SWEEP_MAX_MIC and re-run)`);
    }
  }

  // ── Restore ──
  console.log(`\nRestoring TYPE1=${origType1} MIC1=${origMic1}`);
  await writeIndex(conn, PID_DYNACAB_TYPE1, origType1);
  await writeIndex(conn, PID_DYNACAB_MIC1, origMic1);
  const rbT = await readU32(conn, PID_DYNACAB_TYPE1);
  const rbM = await readU32(conn, PID_DYNACAB_MIC1);
  console.log(`  readback: TYPE1=${rbT} MIC1=${rbM} ${rbT === origType1 && rbM === origMic1 ? '(restored)' : '(!! restore mismatch)'}`);

  mkdirSync('samples/captured/decoded', { recursive: true });
  writeFileSync(
    OUT_JSON,
    JSON.stringify(
      {
        probe: 'probe-am4-dynacab-roster',
        device: 'AM4',
        anchor: { index: ANCHOR_INDEX, expected: '4x12 Rumble EV12L' },
        name_read_action: nameReadType !== undefined ? `0x${nameReadType.toString(16)}` : null,
        dynacab_type1_roster: roster,
        mic1_accepted_max_index: micAcceptedMax,
        recon: reconLog,
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${OUT_JSON}`);
  console.log('Working buffer was touched (edited bit set). Switch presets or reload to discard.');
  conn.close();
}

void main();
