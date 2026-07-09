/**
 * Golden: pattern realizers against a FAKE MidiConnection (no hardware).
 *
 * Asserts the live-stream realizer emits the right Note On/Off bytes in
 * time order, and the record-capture realizer's two-phase arm flow (phase 1
 * sends nothing + asks to arm; phase 2 streams). Uses a high BPM / tiny
 * grid so the real setTimeout scheduler completes in well under a second.
 *
 * Run via:  npx tsx scripts/verify-pattern-realize-sim.ts
 */

import type { MidiConnection } from '../packages/core/src/midi/transport.js';
import type { DeviceCapabilities } from '../packages/core/src/protocol-generic/types.js';
import {
  charGridToSteps,
  compileToPlan,
  realizeLiveStream,
  realizeRecordCapture,
  type NeutralPattern,
} from '../packages/core/src/protocol-generic/patterns/index.js';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  OK    ${label}`);
  else { failed++; console.error(`  FAIL  ${label}${detail ? `, ${detail}` : ''}`); }
}

function fakeConn(): { conn: MidiConnection; sent: number[][] } {
  const sent: number[][] = [];
  const conn = { send: (b: number[]) => { sent.push([...b]); } } as unknown as MidiConnection;
  return { conn, sent };
}

const caps: DeviceCapabilities = {
  slot_model: 'linear', has_scenes: false, has_channels: false, supports_save: false, supports_lineage: false,
  pattern_realizers: ['live_stream', 'record_capture'],
  voice_map: { kick: { channel: 10, note: 60 } },
};
// 4-step kick "x.x." at a high BPM → fast cycle (≈250 ms) for a snappy test.
const pattern: NeutralPattern = { name: 'sim', steps: 4, voices: { kick: { steps: charGridToSteps('x.x.') } } };

async function main(): Promise<void> {
  // ── live_stream ──
  {
    const { conn, sent } = fakeConn();
    const plan = compileToPlan(pattern, caps, { bpm: 960, mode: 'live_stream', repeat: 1 });
    const res = await realizeLiveStream(conn, plan);
    const ons = sent.filter((m) => (m[0] & 0xf0) === 0x90);
    const offs = sent.filter((m) => (m[0] & 0xf0) === 0x80);
    check('live_stream: 2 Note Ons sent', res.notes_sent === 2 && ons.length === 2, `notes_sent=${res.notes_sent} ons=${ons.length}`);
    check('live_stream: matching Note Offs sent', offs.length === 2, String(offs.length));
    check('live_stream: ons are ch10 note60', ons.every((m) => m[0] === 0x99 && m[1] === 60), JSON.stringify(ons));
    check('live_stream: first message is a Note On at t0', sent.length > 0 && (sent[0][0] & 0xf0) === 0x90);
    check('live_stream: status=played, source=played', res.status === 'played' && res.source === 'played');
  }

  // ── record_capture phase 1 (not armed): no sends, awaiting_arm ──
  {
    const { conn, sent } = fakeConn();
    const plan = compileToPlan(pattern, caps, { bpm: 960, mode: 'record_capture', repeat: 1, armed: false });
    const res = await realizeRecordCapture(conn, plan);
    check('record_capture phase 1: status=awaiting_arm', res.status === 'awaiting_arm', res.status);
    check('record_capture phase 1: NOTHING sent', sent.length === 0, String(sent.length));
  }

  // ── record_capture phase 2 (armed): streams, honest unverified ──
  {
    const { conn, sent } = fakeConn();
    const plan = compileToPlan(pattern, caps, { bpm: 960, mode: 'record_capture', repeat: 1, armed: true });
    const res = await realizeRecordCapture(conn, plan);
    const ons = sent.filter((m) => (m[0] & 0xf0) === 0x90);
    check('record_capture phase 2: 2 Note Ons streamed', res.notes_sent === 2 && ons.length === 2, `notes_sent=${res.notes_sent}`);
    check('record_capture phase 2: status=streamed_unverified (no fabricated success)',
      res.status === 'streamed_unverified' && res.source === 'streamed_unverified', res.status);
  }

  console.log('');
  if (failed > 0) { console.error(`x ${failed} realize-sim check(s) FAILED.`); process.exit(1); }
  console.log('OK verify-pattern-realize-sim: live-stream + record-capture realizers verified against a fake connection.');
}

main().catch((err) => { console.error(err); process.exit(1); });
