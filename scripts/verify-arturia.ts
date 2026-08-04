// Golden + invariant checks for the Arturia Freak family codec and descriptors.
//
// The goldens are REAL captured frames, not frames this codec generated. Source:
// `samples/arturia-microfreak/re-notes/notes2.md` (MIDI Control Center talking to
// a MicroFreak) plus the 2026-07-25 hardware session recorded in
// `docs/_private/STATE-MICROFREAK.md`. A golden built from our own encoder would
// only prove the encoder is self-consistent.
//
// Run: npx tsx scripts/verify-arturia.ts

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ARTURIA_ID,
  CMD,
  DEVICE_MICROFREAK,
  DIR_FROM_DEVICE,
  DIR_TO_DEVICE,
  MIDI_THRU_DIN_ALIVE,
  NAME_OFFSET,
  OUTPUT_DEST_DIN_ALIVE,
  OUTPUT_DEST_USB_ALIVE,
  buildDumpNext,
  buildDumpStart,
  buildGlobalRead,
  buildGlobalWrite,
  buildNameRequest,
  ccEvidenceNote,
  decodeGlobalReply,
  decodePresetName,
  downstreamMidiConsumersIn,
  findCc,
  findGlobal,
  globalReplyMatcher,
  isArturia,
  nameReplyMatcher,
  toBankIndex,
  MICROFREAK,
  MICROFREAK_CCS,
  MINIFREAK,
  MINIFREAK_CCS,
  createFreakDescriptor,
  type FreakConfig,
  type RigTopology,
} from '@mcp-midi-control/arturia/index.js';
import { MICROFREAK_DESCRIPTOR, MINIFREAK_DESCRIPTOR } from '@mcp-midi-control/arturia/descriptor.js';
import {
  RIG_MANIFEST_ENV,
  clearRigManifestCache,
} from '@mcp-midi-control/core/protocol-generic/openrig/manifest.js';

let failures = 0;
const hex = (a: readonly number[]) =>
  a.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
const parseHex = (s: string): number[] => s.trim().split(/\s+/).map((t) => parseInt(t, 16));

function check(label: string, ok: boolean, detail = '') {
  if (!ok) {
    failures++;
    console.log(`FAIL: ${label}${detail ? `\n  ${detail}` : ''}`);
  }
}

// ── 1. Envelope goldens, byte-exact against captured MCC traffic ───────────
{
  // Captured: "To Arturia MicroFreak  F0 00 20 6B 07 01 00 01 43 20 F7"
  check(
    'buildGlobalRead(seq=0x00, param=0x20) matches the captured MCC read',
    hex(buildGlobalRead(0x00, 0x20)) === 'F0 00 20 6B 07 01 00 01 43 20 F7',
    `got ${hex(buildGlobalRead(0x00, 0x20))}`,
  );
  // Captured: "F0 00 20 6B 07 01 01 01 43 21 F7"
  check(
    'buildGlobalRead(seq=0x01, param=0x21) matches the captured MCC read',
    hex(buildGlobalRead(0x01, 0x21)) === 'F0 00 20 6B 07 01 01 01 43 21 F7',
    `got ${hex(buildGlobalRead(0x01, 0x21))}`,
  );
  // Captured: "To Arturia MicroFreak  F0 00 20 6B 07 01 17 03 19 00 00 00 F7"
  check(
    'buildNameRequest(seq=0x17, slot0=0) matches the captured MCC name request',
    hex(buildNameRequest(0x17, 0)) === 'F0 00 20 6B 07 01 17 03 19 00 00 00 F7',
    `got ${hex(buildNameRequest(0x17, 0))}`,
  );
  // Same shape, trailing flag 1 = start a full dump (STATE-MICROFREAK.md).
  check(
    'buildDumpStart differs from buildNameRequest ONLY in the trailing flag',
    hex(buildDumpStart(0x17, 0)) === 'F0 00 20 6B 07 01 17 03 19 00 00 01 F7',
    `got ${hex(buildDumpStart(0x17, 0))}`,
  );
  check(
    'buildDumpNext matches the documented data-request frame',
    hex(buildDumpNext(0x05)) === 'F0 00 20 6B 07 01 05 01 18 00 F7',
    `got ${hex(buildDumpNext(0x05))}`,
  );
  check(
    'buildGlobalWrite carries len=02, cmd=42, then param + value',
    hex(buildGlobalWrite(0x09, 0x24, 0x01)) === 'F0 00 20 6B 07 01 09 02 42 24 01 F7',
    `got ${hex(buildGlobalWrite(0x09, 0x24, 0x01))}`,
  );
}

// ── 2. Every request carries the to-device direction byte ─────────────────
{
  const requests: Array<[string, number[]]> = [
    ['buildGlobalRead', buildGlobalRead(0x11, 0x20)],
    ['buildGlobalWrite', buildGlobalWrite(0x11, 0x20, 0x02)],
    ['buildNameRequest', buildNameRequest(0x11, 5)],
    ['buildDumpStart', buildDumpStart(0x11, 5)],
    ['buildDumpNext', buildDumpNext(0x11)],
  ];
  for (const [name, frame] of requests) {
    check(`${name} sets byte5 = DIR_TO_DEVICE`, frame[5] === DIR_TO_DEVICE, `got 0x${frame[5].toString(16)}`);
    check(`${name} is a well-formed SysEx frame`, frame[0] === 0xf0 && frame.at(-1) === 0xf7);
    check(`${name} has no byte above 0x7F between the delimiters`,
      frame.slice(1, -1).every((b) => b >= 0 && b <= 0x7f), hex(frame));
    check(`${name} carries the Arturia manufacturer id`,
      frame[1] === ARTURIA_ID[0] && frame[2] === ARTURIA_ID[1] && frame[3] === ARTURIA_ID[2]);
  }
}

// ── 3. Global reply matcher: accepts the real reply, rejects our own write ─
{
  // Captured: "From Arturia MicroFreak  F0 00 20 6B 07 7F 02 02 42 20 7F F7"
  const realReply = parseHex('F0 00 20 6B 07 7F 02 02 42 20 7F F7');
  check('globalReplyMatcher accepts the captured 0x20 answer', globalReplyMatcher(0x20)(realReply));
  check('decodeGlobalReply reads the captured value 0x7F', decodeGlobalReply(realReply) === 0x7f);
  check('isArturia accepts the captured answer', isArturia(realReply));

  // The captured answer does NOT echo the request seq: MCC sent seq 00,01,02...
  // and the device answered byte6 = 02,04,06... A matcher that checked seq here
  // would reject every genuine answer, which is why it must not.
  check(
    'captured answers use a device-side counter, NOT the echoed seq',
    parseHex('F0 00 20 6B 07 7F 02 02 42 20 7F F7')[6] === 0x02
    && parseHex('F0 00 20 6B 07 7F 04 02 42 21 00 F7')[6] === 0x04
    && parseHex('F0 00 20 6B 07 7F 06 02 42 25 05 F7')[6] === 0x06,
  );

  // THE ECHO GUARD. A global WRITE command and a global READ answer share the
  // shape `02 42 <param> <value>` and differ only in the direction byte. Without
  // the direction check a write looped back on the port would satisfy the
  // matcher and confirm itself, making every write self-verifying and useless.
  const ourWrite = buildGlobalWrite(0x00, 0x20, 0x7f);
  check(
    'globalReplyMatcher REJECTS a host-originated write of the same shape',
    !globalReplyMatcher(0x20)(ourWrite),
    `write frame ${hex(ourWrite)} must not read as a device answer`,
  );
  check('globalReplyMatcher rejects a reply for a different param', !globalReplyMatcher(0x21)(realReply));
  check(
    'globalReplyMatcher rejects a reply from a different device code',
    !globalReplyMatcher(0x20, 0x04)(realReply),
  );
  // The direction bytes being distinct is what makes the guard above possible.
  // It is a compile-time constant, so the type checker already proves it; the
  // runtime assertion would be dead code.
}

// ── 4. Name reply: offset, decode, and the seq-mismatch regression ─────────
{
  // Captured hex dump of the reply for bank 0 / index 0, name "Disrespectful".
  const nameReply = parseHex(
    'F0 00 20 6B 07 01 00 23 52 00 00 00 00 00 00 00 '
    + '00 00 00 08 10 44 69 73 72 65 73 70 65 63 74 66 '
    + '75 6C 00 00 00 00 00 00 00 00 00 00 F7',
  );
  check('captured name reply carries the NAME_REPLY command', nameReply[8] === CMD.NAME_REPLY);
  check('NAME_OFFSET lands on the first name character', nameReply[NAME_OFFSET] === 0x44);
  check(
    'decodePresetName reads "Disrespectful" from the captured reply',
    decodePresetName(nameReply) === 'Disrespectful',
    `got "${decodePresetName(nameReply)}"`,
  );
  check('nameReplyMatcher accepts its own seq/bank/index', nameReplyMatcher(0x00, 0)(nameReply));

  // REGRESSION: matching on the Arturia header alone let a late answer to a
  // PREVIOUS request be misattributed to the current one, which manufactured a
  // phantom "the preset ceiling is 385" result during the decode session.
  check(
    'nameReplyMatcher REJECTS a right-header reply carrying the wrong seq',
    !nameReplyMatcher(0x01, 0)(nameReply),
  );
  check(
    'nameReplyMatcher REJECTS a reply for a different slot',
    !nameReplyMatcher(0x00, 5)(nameReply),
  );

  // Second captured reply: bank 1 / index 127, captured as a maximum-length
  // name. It decodes to 14 characters, which is the longest name seen: the
  // other captured names (Disrespectful 13, NervousKeys 11) all fit under it.
  const maxName = parseHex(
    'F0 00 20 6B 07 01 00 23 52 01 7F 00 10 00 00 00 '
    + '00 7F 00 00 10 41 42 43 44 58 58 58 58 58 58 58 '
    + '58 58 58 00 00 00 00 00 00 00 00 00 F7',
  );
  check(
    'decodePresetName reads the 14-char maximum-length name',
    decodePresetName(maxName) === 'ABCDXXXXXXXXXX',
    `got "${decodePresetName(maxName)}" (${decodePresetName(maxName).length} chars)`,
  );
  check('nameReplyMatcher accepts bank 1 / index 127 as slot0 255', nameReplyMatcher(0x00, 255)(maxName));
}

// ── 5. Bank/index addressing ──────────────────────────────────────────────
{
  check('slot0 0 -> bank 0 index 0', JSON.stringify(toBankIndex(0)) === '{"bank":0,"index":0}');
  check('slot0 127 -> bank 0 index 127', JSON.stringify(toBankIndex(127)) === '{"bank":0,"index":127}');
  // Hardware-proved: reading slot 129 (slot0 128) as bank 1 index 0 returned a
  // distinct valid name, which is what confirmed the addressing rather than
  // assuming the community note was right.
  check('slot0 128 -> bank 1 index 0 (hardware-proved)', JSON.stringify(toBankIndex(128)) === '{"bank":1,"index":0}');
  check('slot0 255 -> bank 1 index 127', JSON.stringify(toBankIndex(255)) === '{"bank":1,"index":127}');
  check('slot0 511 -> bank 3 index 127 (fw5 ceiling)', JSON.stringify(toBankIndex(511)) === '{"bank":3,"index":127}');
}

// ── 6. MicroFreak CC table == Arturia's own Appendix D, exactly ────────────
{
  // Manual fw 5.0.0, Appendix D "CC# Values", pp.145-146. Transcribed from the
  // local extraction at docs/manuals/other-gear/microfreak_Manual_5_0_0_EN.txt.
  // This is the vendor's complete list: the MicroFreak exposes no other CC.
  const APPENDIX_D: ReadonlyArray<readonly [string, number]> = [
    ['Spice', 2], ['Glide', 5], ['Oscillator Type', 9], ['Oscillator Wave', 10],
    ['Oscillator Timbre', 12], ['Oscillator Shape', 13], ['Filter Cutoff', 23],
    ['Cycling Env Amount', 24], ['Filter Amount', 26], ['Cycling Env Hold', 28],
    ['Envelope Sustain', 29], ['Keyboard Hold (toggle)', 64], ['Filter Resonance', 83],
    ['ARP/SEQ rate (free)', 91], ['ARP/SEQ rate (sync)', 92], ['LFO rate (free)', 93],
    ['LFO rate (sync)', 94], ['Cycling env rise', 102], ['Cycling env fall', 103],
    ['Envelope Attack', 105], ['Envelope Decay', 106],
  ];
  check(
    `MicroFreak registers all ${APPENDIX_D.length} Appendix D CCs and no extras`,
    MICROFREAK_CCS.length === APPENDIX_D.length,
    `registered ${MICROFREAK_CCS.length}`,
  );
  const byNumber = new Map(MICROFREAK_CCS.map((c) => [c.cc, c]));
  for (const [label, cc] of APPENDIX_D) {
    const entry = byNumber.get(cc);
    check(`Appendix D CC ${cc} ("${label}") is registered`, entry !== undefined);
    if (entry !== undefined) {
      check(`CC ${cc} keeps the manufacturer's label "${label}"`, entry.label === label,
        `got "${entry.label}"`);
    }
  }
  check(
    'CC 64 (Keyboard Hold) is the only toggle',
    MICROFREAK_CCS.filter((c) => c.toggle === true).map((c) => c.cc).join() === '64',
  );
}

// ── 7. Per-device CC tables must never collide silently ───────────────────
{
  for (const [name, ccs] of [['MicroFreak', MICROFREAK_CCS], ['MiniFreak', MINIFREAK_CCS]] as const) {
    const seen = new Map<number, string>();
    for (const c of ccs) {
      const prev = seen.get(c.cc);
      check(`${name}: CC ${c.cc} is not assigned twice`, prev === undefined,
        `${prev} and ${c.block}.${c.param} both claim CC ${c.cc}`);
      seen.set(c.cc, `${c.block}.${c.param}`);
    }
  }

  // The documented collisions. These are the reason the tables must stay
  // per-device: the SAME CC number addresses a DIFFERENT parameter on each
  // model, so a shared table would silently move the wrong knob.
  const COLLISIONS: ReadonlyArray<readonly [number, string, string]> = [
    [23, 'filter.cutoff', 'fx1.intensity'],
    [83, 'filter.resonance', 'envelope.release'],
    [24, 'cycling_env.amount', 'filter.env_amount'],
    [26, 'filter.amount', 'fx2.time'],
  ];
  for (const [cc, microTarget, miniTarget] of COLLISIONS) {
    const micro = MICROFREAK_CCS.find((c) => c.cc === cc);
    const mini = MINIFREAK_CCS.find((c) => c.cc === cc);
    check(`CC ${cc} maps to ${microTarget} on the MicroFreak`,
      micro !== undefined && `${micro.block}.${micro.param}` === microTarget,
      micro === undefined ? 'missing' : `got ${micro.block}.${micro.param}`);
    check(`CC ${cc} maps to ${miniTarget} on the MiniFreak`,
      mini !== undefined && `${mini.block}.${mini.param}` === miniTarget,
      mini === undefined ? 'missing' : `got ${mini.block}.${mini.param}`);
  }
  // The MicroFreak's cutoff CC must NOT be the MiniFreak's cutoff CC.
  check(
    'cutoff is a different CC on each model (23 vs 74)',
    findCc(MICROFREAK, 'filter', 'cutoff')?.cc === 23
    && findCc(MINIFREAK, 'filter', 'cutoff')?.cc === 74,
  );
}

// ── 8. Evidence labelling: the MiniFreak's CCs are second-hand, and say so ──
{
  for (const c of MICROFREAK_CCS) {
    check(`MicroFreak ${c.block}.${c.param} carries no unvalidated warning (Appendix D)`,
      ccEvidenceNote(c) === undefined);
  }
  for (const c of MINIFREAK_CCS) {
    check(`MiniFreak ${c.block}.${c.param} is labelled transcribed-unvalidated`,
      c.evidence === 'transcribed-unvalidated');
    const note = ccEvidenceNote(c);
    check(`MiniFreak ${c.block}.${c.param} surfaces an evidence note`,
      note !== undefined && note.includes('UNVALIDATED'));
  }
  // And it must reach the tool surface, not just the config layer.
  const miniCutoff = MINIFREAK_DESCRIPTOR.blocks.filter?.params.cutoff;
  check('MiniFreak filter.cutoff exposes evidence_note in its schema',
    miniCutoff?.evidence_note !== undefined && miniCutoff.evidence_note.includes('UNVALIDATED'));
  const microCutoff = MICROFREAK_DESCRIPTOR.blocks.filter?.params.cutoff;
  check('MicroFreak filter.cutoff exposes NO evidence_note',
    microCutoff?.evidence_note === undefined);
}

// ── 9. Globals: ids, 0-based channels, and the confirmed enum orders ───────
{
  const g = (name: string) => findGlobal(MICROFREAK, name);
  const IDS: ReadonlyArray<readonly [string, number]> = [
    ['midi_input_channel', 0x20], ['midi_output_channel', 0x21], ['knob_send_ccs', 0x24],
    ['output_dest', 0x25], ['arp_seq_midi_out', 0x2b], ['knob_catch', 0x2d],
    ['sync_source', 0x2e], ['midi_thru', 0x3b],
  ];
  for (const [name, id] of IDS) {
    check(`global ${name} is id 0x${id.toString(16)}`, g(name)?.id === id, `got ${String(g(name)?.id)}`);
  }
  check('findGlobal tolerates a system. prefix', findGlobal(MICROFREAK, 'system.midi_thru')?.id === 0x3b);
  check('sync_source enum order matches the manual',
    g('sync_source')?.values?.join() === 'Int,USB,MIDI,Clock,Auto');
  check('both MIDI channel globals are flagged 0-based',
    g('midi_input_channel')?.channel === true && g('midi_output_channel')?.channel === true);
  check('output_dest is the only usb_critical global',
    MICROFREAK.sysex!.globals.filter((x) => x.usb_critical === true).map((x) => x.param).join() === 'output_dest');
  // Observed on hardware: USB=1, BOTH=5. MIDI=4 and None=0 are inferred and
  // unobservable, so they must NOT be treated as USB-alive.
  check('USB-alive output_dest values are exactly {1,5}',
    [...MICROFREAK.sysex!.output_dest_usb_alive!].sort((a, b) => a - b).join() === '1,5');
}

// ── 10. Display-first conversions at the schema boundary ──────────────────
{
  const sys = MICROFREAK_DESCRIPTOR.blocks.system!;
  const inChan = sys.params.midi_input_channel;
  // Hardware-confirmed: display 3 stored as 2. A writer that sends the displayed
  // number puts the device one channel too high.
  check('MIDI channel display 3 encodes to wire 2 (0-based)', inChan.encode(3) === 2);
  check('MIDI channel wire 2 decodes to display 3', inChan.decode(2) === 3);
  check('MIDI channel 1 encodes to wire 0', inChan.encode(1) === 0);
  check('MIDI channel 16 encodes to wire 15', inChan.encode(16) === 15);
  for (const bad of [0, 17, -1]) {
    let threw = false;
    try { inChan.encode(bad); } catch { threw = true; }
    check(`MIDI channel ${bad} is rejected`, threw);
  }

  const sync = sys.params.sync_source;
  check('sync_source accepts a display string', sync.encode('Auto') === 4);
  check('sync_source is case-insensitive', sync.encode('midi') === 2);
  check('sync_source decodes wire 0 to Int', sync.decode(0) === 'Int');
  let syncThrew = false;
  try { sync.encode('Nonsense'); } catch { syncThrew = true; }
  check('sync_source rejects an unknown label', syncThrew);

  // output_dest stays a raw integer on purpose: the manual implies a 0..3 enum
  // but the observed values are a bitmask, so a fabricated label table would be
  // a lie dressed as a feature.
  check('output_dest is NOT dressed up as an enum', sys.params.output_dest.unit !== 'enum');

  const cutoff = MICROFREAK_DESCRIPTOR.blocks.filter!.params.cutoff;
  check('cutoff is display-first 0..100, not raw 0..127',
    cutoff.display_min === 0 && cutoff.display_max === 100);
  check('cutoff display 100 encodes to wire 127', cutoff.encode(100) === 127);
  check('cutoff display 0 encodes to wire 0', cutoff.encode(0) === 0);
  check('cutoff display 50 encodes mid-scale', cutoff.encode(50) === 64);
  for (const bad of [-1, 101]) {
    let threw = false;
    try { cutoff.encode(bad); } catch { threw = true; }
    check(`cutoff display ${bad} is rejected as out of range`, threw);
  }
  // Round-trip is exact only on values landing on the 128-step grid; that
  // lossiness is the hardware's, so assert the grid points rather than all 101.
  for (const wire of [0, 32, 64, 96, 127]) {
    const back = cutoff.encode(cutoff.decode(wire) as number);
    check(`cutoff wire ${wire} survives a decode/encode round-trip`, back === wire, `got ${back}`);
  }

  const hold = MICROFREAK_DESCRIPTOR.blocks.keyboard!.params.hold;
  check('keyboard.hold accepts "on"', hold.encode('on') === 127);
  check('keyboard.hold accepts "off"', hold.encode('off') === 0);
  check('keyboard.hold treats 64+ as On', hold.decode(127) === 'On' && hold.decode(0) === 'Off');
}

// ── 11. Capability shape: what each descriptor honestly claims ────────────
{
  for (const d of [MICROFREAK_DESCRIPTOR, MINIFREAK_DESCRIPTOR]) {
    check(`${d.display_name} declares no save path`, d.capabilities.supports_save === false);
    check(`${d.display_name} declares no scenes`, d.capabilities.has_scenes === false);
    check(`${d.display_name} declares no channels`, d.capabilities.has_channels === false);
    check(`${d.display_name} has a verification string`, (d.capabilities.verification ?? '').length > 100);
  }
  // Every surface the MicroFreak descriptor SHIPS is hardware-confirmed on the
  // maintainer's own unit. What it lacks (preset-param reads, save) is missing
  // because the device cannot do it or the protocol is undecoded, not because
  // the evidence is thin, and the tier rates confidence in what ships.
  check('MicroFreak ships verified', MICROFREAK_DESCRIPTOR.capabilities.support_tier === 'verified');
  // The whole point of a per-device tier: same factory, genuinely weaker
  // evidence, so the MiniFreak must NOT inherit its sibling's standing.
  check('MiniFreak ships generic-only (weaker tier, not shared)',
    MINIFREAK_DESCRIPTOR.capabilities.support_tier === 'generic-only');
  check('the two Freaks do NOT share a tier',
    MICROFREAK_DESCRIPTOR.capabilities.support_tier !== MINIFREAK_DESCRIPTOR.capabilities.support_tier);

  // The port matchers must stay model-specific. A broad /arturia/i would capture
  // the other model and drive it with CC numbers that mean different things.
  // `pattern` is `string | RegExp` on the shared descriptor type; both forms
  // mean "does this port name match", so normalise before testing.
  const matches = (patterns: ReadonlyArray<string | RegExp>, port: string): boolean =>
    patterns.some((p) => (typeof p === 'string' ? port.toLowerCase().includes(p.toLowerCase()) : p.test(port)));
  const micro = MICROFREAK_DESCRIPTOR.port_match.map((p) => p.pattern);
  const mini = MINIFREAK_DESCRIPTOR.port_match.map((p) => p.pattern);
  check('MicroFreak matcher accepts "Arturia MicroFreak"', matches(micro, 'Arturia MicroFreak'));
  check('MicroFreak matcher REJECTS "Arturia MiniFreak"', !matches(micro, 'Arturia MiniFreak'));
  check('MiniFreak matcher accepts "Arturia MiniFreak"', matches(mini, 'Arturia MiniFreak'));
  check('MiniFreak matcher REJECTS "Arturia MicroFreak"', !matches(mini, 'Arturia MicroFreak'));
}

// ── 12. No SysEx device code => the whole SysEx surface is ABSENT ─────────
{
  check('MiniFreak config declares no sysex block', MINIFREAK.sysex === undefined);
  check('MiniFreak descriptor exposes NO system block',
    MINIFREAK_DESCRIPTOR.blocks.system === undefined);
  check('MicroFreak descriptor DOES expose a system block',
    MICROFREAK_DESCRIPTOR.blocks.system !== undefined);
  check('findGlobal returns nothing for a device without sysex',
    findGlobal(MINIFREAK, 'midi_thru') === undefined);
  // Same factory, same code path: the difference is data, not a second branch.
  check('MiniFreak still exposes its CC blocks',
    MINIFREAK_DESCRIPTOR.blocks.filter !== undefined && MINIFREAK_DESCRIPTOR.blocks.fx1 !== undefined);
}

// ── 13. The family-factory device-code regression ─────────────────────────
{
  // A second Freak with a DIFFERENT device code must produce frames addressed to
  // ITS code, and reply matchers keyed to ITS code. The bug this guards: a
  // matcher that defaults to the MicroFreak's 0x07 while the request goes out
  // addressed elsewhere, so nothing ever matches and every global write on the
  // second device reports itself unconfirmed. Only ever visible on device two.
  const FAKE_CODE = 0x2a;
  const fake: FreakConfig = {
    ...MICROFREAK,
    id: 'fake-freak',
    display_name: 'Fake Freak',
    port_match: [/fake\s*freak/i],
    sysex: { ...MICROFREAK.sysex!, device_code: FAKE_CODE },
  };
  const desc = createFreakDescriptor(fake);
  check('a second Freak builds without a second descriptor', desc.id === 'fake-freak');

  const frame = buildGlobalRead(0x01, 0x20, FAKE_CODE);
  check('frames for a second Freak carry ITS device code', frame[4] === FAKE_CODE, hex(frame));
  check('isArturia is device-code aware', isArturia(frame, FAKE_CODE) && !isArturia(frame, DEVICE_MICROFREAK));

  const reply = parseHex('F0 00 20 6B 2A 7F 02 02 42 20 05 F7');
  check('a matcher keyed to the second device accepts its reply',
    globalReplyMatcher(0x20, FAKE_CODE)(reply));
  check('a MicroFreak-keyed matcher REJECTS the second device reply',
    !globalReplyMatcher(0x20)(reply));

  // The writer must thread the config's device code into its read-back matcher.
  const src = readFileSync('packages/arturia/src/descriptor/writer.ts', 'utf8');
  check('writer.ts read-back passes a device code to globalReplyMatcher',
    /globalReplyMatcher\(\s*id\s*,\s*device\s*\)/.test(src),
    'readBackGlobal must not let the device code default to the MicroFreak',
  );
}

// ── 14. Preset addressing limits the writer must enforce ──────────────────
{
  check('MicroFreak advertises the fw5 ceiling of 512 presets', MICROFREAK.preset_count === 512);
  check('plain Program Change reaches only the first 128', MICROFREAK.pc_max_preset === 128);
  // Hardware-confirmed 0-based: PC 4 loaded preset 5, undocumented in the manual.
  const pc = MICROFREAK_DESCRIPTOR.writer.buildSwitchPreset!(5);
  check('switch_preset(5) sends PC 4 (0-based, hardware-confirmed)',
    pc[0] === 0xc0 && pc[1] === 4, hex(pc));
  check('switch_preset(1) sends PC 0', MICROFREAK_DESCRIPTOR.writer.buildSwitchPreset!(1)[1] === 0);
  check('the location format accepts a plain number',
    MICROFREAK_DESCRIPTOR.capabilities.preset_location_format!.test('129'));
}

// ── 15. The DIN leg: which rig topologies count as a downstream consumer ───
// The MicroFreak's 5-pin MIDI Out is a path this server never travels over, so
// nothing it reads can tell it whether that leg is carrying. The rig manifest is
// the only place a user has declared the cable. These cases pin exactly which
// declarations count, because a guard that over-fires is a guard people ignore.
{
  const rig = (over: Partial<RigTopology> = {}): RigTopology => ({
    nodes: [
      {
        id: 'microfreak',
        name: 'Arturia MicroFreak',
        server_device_id: 'microfreak',
        ports: [
          { id: 'midi_in', kind: 'midi_din_in' },
          { id: 'midi_out', kind: 'midi_din_out' },
          { id: 'out_lr', kind: 'audio_out' },
        ],
      },
      { id: 've500', name: 'Boss VE-500 Vocal Performer', server_device_id: 've-500', ports: [{ id: 'midi_in', kind: 'midi_din_in' }] },
    ],
    edges: [
      {
        id: 'microfreak-to-ve500-m2pcr',
        from: { node: 'microfreak', port: 'midi_out' },
        to: { node: 've500', port: 'midi_in' },
        signal: { kind: 'midi' },
        enabled: true,
      },
    ],
    ...over,
  });

  const found = downstreamMidiConsumersIn(rig(), 'microfreak');
  check('an enabled MIDI edge out of the DIN port finds the consumer', found.length === 1, JSON.stringify(found));
  check('the consumer resolves to its registered device id', found[0]?.device === 've-500', JSON.stringify(found[0]));
  check('the consumer carries a human name for the warning', found[0]?.name.includes('VE-500'));
  check('the consumer cites the manifest edge it came from', found[0]?.edge === 'microfreak-to-ve500-m2pcr');

  // A [planned] cable is not a patched cable. Warning about a consumer the user
  // has told us is NOT connected is the fastest way to train them to ignore the
  // warning that matters.
  const planned = rig({ edges: [{ ...rig().edges[0], enabled: false }] });
  check('a DISABLED edge (a planned cable) is not a consumer', downstreamMidiConsumersIn(planned, 'microfreak').length === 0);

  // Audio out of the same device must not count: killing MIDI Thru does nothing
  // to an audio cable.
  const audio = rig({
    edges: [{
      id: 'microfreak-audio',
      from: { node: 'microfreak', port: 'out_lr' },
      to: { node: 've500', port: 'midi_in' },
      signal: { kind: 'audio' },
    }],
  });
  check('an AUDIO edge is not a MIDI consumer', downstreamMidiConsumersIn(audio, 'microfreak').length === 0);

  // A MIDI edge leaving a port that is not a physical MIDI out (here the audio
  // jack) is a manifest error, not a DIN leg. Do not warn on it.
  const wrongPort = rig({
    edges: [{
      id: 'bogus',
      from: { node: 'microfreak', port: 'out_lr' },
      to: { node: 've500', port: 'midi_in' },
      signal: { kind: 'midi' },
    }],
  });
  check('a MIDI edge from a non-DIN port is not counted', downstreamMidiConsumersIn(wrongPort, 'microfreak').length === 0);

  // USB is the server's OWN path and is already covered by the usb_critical
  // refusal; counting it here would double-warn about a different failure.
  const usb = rig({
    nodes: [
      { id: 'microfreak', name: 'Arturia MicroFreak', server_device_id: 'microfreak', ports: [{ id: 'usb', kind: 'usb_midi' }] },
      { id: 'host', name: 'Laptop', server_device_id: null, ports: [{ id: 'usb', kind: 'usb_midi' }] },
    ],
    edges: [{ id: 'usb-link', from: { node: 'microfreak', port: 'usb' }, to: { node: 'host', port: 'usb' }, signal: { kind: 'midi' } }],
  });
  check('a USB MIDI edge is NOT treated as the DIN leg', downstreamMidiConsumersIn(usb, 'microfreak').length === 0);

  // Opaque gear has no server_device_id; the node id must still resolve, both as
  // the source and as the consumer.
  const opaque = rig({
    nodes: [
      { id: 'microfreak', name: 'MicroFreak', ports: [{ id: 'midi_out', kind: 'midi_din_out' }] },
      { id: 'thrubox', name: 'Kenton Thru-5', server_device_id: null, ports: [{ id: 'in', kind: 'midi_din_in' }] },
    ],
    edges: [{ id: 'to-thrubox', from: { node: 'microfreak', port: 'midi_out' }, to: { node: 'thrubox', port: 'in' }, signal: { kind: 'midi' } }],
  });
  const viaNodeId = downstreamMidiConsumersIn(opaque, 'microfreak');
  check('a node with no server_device_id still matches by node id', viaNodeId.length === 1);
  check('an opaque consumer falls back to its node id', viaNodeId[0]?.device === 'thrubox', JSON.stringify(viaNodeId[0]));

  check('a device absent from the rig has no consumers', downstreamMidiConsumersIn(rig(), 'minifreak').length === 0);

  const dangling = rig({
    edges: [{ id: 'dangling', from: { node: 'microfreak', port: 'midi_out' }, to: { node: 'ghost', port: 'in' }, signal: { kind: 'midi' } }],
  });
  check('an edge to a missing node is skipped, not crashed on', downstreamMidiConsumersIn(dangling, 'microfreak').length === 0);
}

// ── 16. The DIN-leg guard fires ONLY when a consumer is declared ───────────
// The failure this closes: system.midi_thru = Off and system.output_dest set
// USB-only each silence the 5-pin MIDI Out, and NOTHING in a read shows it,
// because every read travels over USB. On the maintainer's rig that leg carries
// note targets into a VE-500's pitch correction, so the vocal chain dies while
// the synth reports perfect health.
{
  const MANIFEST: RigTopology = {
    nodes: [
      {
        id: 'microfreak',
        name: 'Arturia MicroFreak',
        server_device_id: 'microfreak',
        ports: [{ id: 'midi_out', kind: 'midi_din_out' }],
      },
      { id: 've500', name: 'Boss VE-500 Vocal Performer', server_device_id: 've-500', ports: [{ id: 'midi_in', kind: 'midi_din_in' }] },
    ],
    edges: [{
      id: 'microfreak-to-ve500-m2pcr',
      from: { node: 'microfreak', port: 'midi_out' },
      to: { node: 've500', port: 'midi_in' },
      signal: { kind: 'midi' },
      enabled: true,
    }],
  };

  const dir = mkdtempSync(join(tmpdir(), 'verify-arturia-rig-'));
  const manifestPath = join(dir, 'rig.json');
  writeFileSync(manifestPath, JSON.stringify(MANIFEST), 'utf8');
  const savedEnv = process.env[RIG_MANIFEST_ENV];

  /**
   * A MicroFreak that answers the writer's read-back with whatever it was last
   * written, which is what the real device does. Using the written value keeps
   * the write path `acked`, so a warning cannot be confused for a failed write.
   */
  function mockCtx() {
    const sent: number[][] = [];
    let held = 0;
    const ctx = {
      conn: {
        lastSendError: undefined,
        send: (b: number[]) => {
          sent.push(b);
          if (b[8] === CMD.GLOBAL_WRITE) held = b[10];
        },
        receiveSysExMatching: (match: (b: readonly number[]) => boolean) => {
          const reply = [0xf0, ...ARTURIA_ID, DEVICE_MICROFREAK, DIR_FROM_DEVICE, 0x02, 0x02, CMD.GLOBAL_WRITE, 0x00, held, 0xf7];
          // Answer for whichever param the matcher wants (it checks byte 9).
          for (let p = 0; p <= 0x7f; p++) {
            reply[9] = p;
            if (match(reply)) return Promise.resolve([...reply]);
          }
          return Promise.reject(new Error('timeout'));
        },
      },
    } as never;
    return { sent, ctx };
  }

  const setGlobal = async (name: string, value: number) => {
    const { sent, ctx } = mockCtx();
    const r = await MICROFREAK_DESCRIPTOR.writer.setParam!(ctx, 'system', name, value);
    return { r, sent };
  };

  // ── with the consumer declared ────────────────────────────────────────────
  process.env[RIG_MANIFEST_ENV] = manifestPath;
  clearRigManifestCache();

  {
    const { r, sent } = await setGlobal('midi_thru', 0);
    check('midi_thru = Off still WRITES (the user may mean it)', sent.some((f) => f[8] === CMD.GLOBAL_WRITE && f[9] === 0x3b && f[10] === 0));
    check('midi_thru = Off is acked, not reported as a failure', r.acked === true, JSON.stringify(r));
    check('midi_thru = Off warns when a consumer is declared', r.warning !== undefined, JSON.stringify(r));
    check('the warning NAMES the device that just went quiet',
      (r.warning ?? '').includes('Boss VE-500 Vocal Performer'), r.warning);
    check('the warning cites the manifest edge, so the user can find the cable',
      (r.warning ?? '').includes('microfreak-to-ve500-m2pcr'), r.warning);
    check('the warning says the read path will keep looking healthy',
      /still answers over USB|different path/.test(r.warning ?? ''), r.warning);
    check('the warning says how to put it back', (r.warning ?? '').includes('set system.midi_thru to 1'), r.warning);
  }

  {
    const { r } = await setGlobal('midi_thru', 1);
    check('midi_thru = On does NOT warn', r.warning === undefined, r.warning);
  }

  {
    // THE case from the brief: USB-only passes the usb_critical refusal (USB is
    // alive) and silences the DIN leg. Exactly the write nothing else catches.
    const { r } = await setGlobal('output_dest', 1);
    check('output_dest = USB-only is allowed through the USB guard', r.acked === true, JSON.stringify(r));
    check('output_dest = USB-only warns about the DIN leg', (r.warning ?? '').includes('Boss VE-500'), r.warning);
    check('the output_dest warning names a DIN-alive value to restore',
      (r.warning ?? '').includes('set system.output_dest to 4 or 5'), r.warning);
  }

  {
    const { r } = await setGlobal('output_dest', 5);
    check('output_dest = BOTH does NOT warn', r.warning === undefined, r.warning);
  }

  {
    // Ordering regression: the USB refusal must still fire FIRST for a value
    // that kills both legs. A warning would imply the write went through.
    let refused = '';
    await MICROFREAK_DESCRIPTOR.writer.setParam!(mockCtx().ctx, 'system', 'output_dest', 4)
      .catch((e: Error) => { refused = e.message; });
    check('output_dest = MIDI-only is still REFUSED (severs our own transport)', refused !== '');
    check('the USB refusal, not the DIN warning, is what fires',
      refused.includes('does not include USB'), refused);
  }

  {
    const { r } = await setGlobal('sync_source', 2);
    check('a global that cannot touch the DIN leg never warns', r.warning === undefined, r.warning);
  }

  // ── with NO consumer declared: the guard must go silent ───────────────────
  delete process.env[RIG_MANIFEST_ENV];
  clearRigManifestCache();

  {
    const { r, sent } = await setGlobal('midi_thru', 0);
    check('with no rig manifest, midi_thru = Off does NOT warn', r.warning === undefined, r.warning);
    check('with no rig manifest, the write still happens', sent.some((f) => f[8] === CMD.GLOBAL_WRITE && f[9] === 0x3b));
  }
  {
    const { r } = await setGlobal('output_dest', 1);
    check('with no rig manifest, output_dest = USB-only does NOT warn', r.warning === undefined, r.warning);
  }

  // A manifest that declares the MicroFreak with NOTHING on its MIDI Out is the
  // common case, and it must be as quiet as no manifest at all.
  const lonely: RigTopology = { nodes: [MANIFEST.nodes[0]], edges: [] };
  const lonelyPath = join(dir, 'lonely.json');
  writeFileSync(lonelyPath, JSON.stringify(lonely), 'utf8');
  process.env[RIG_MANIFEST_ENV] = lonelyPath;
  clearRigManifestCache();
  {
    const { r } = await setGlobal('midi_thru', 0);
    check('a manifest with an EMPTY MIDI Out does not warn either', r.warning === undefined, r.warning);
  }

  // Config-level invariant: exactly the two globals that can silence the leg
  // declare din_alive. A third one appearing silently would be a real gap.
  const dinCritical = MICROFREAK.sysex!.globals.filter((g) => g.din_alive !== undefined).map((g) => g.param);
  check('exactly output_dest and midi_thru declare din_alive',
    dinCritical.sort().join() === 'midi_thru,output_dest', dinCritical.join());
  check('output_dest DIN-alive values are {4,5} (the bitmask MIDI bit)',
    [...OUTPUT_DEST_DIN_ALIVE].sort((a, b) => a - b).join() === '4,5');
  check('midi_thru DIN-alive is On only', [...MIDI_THRU_DIN_ALIVE].join() === '1');
  // The two axes must stay separate: USB-alive and DIN-alive disagree on 1 and 4,
  // which is the entire reason a single "is this safe" flag would not work.
  check('USB-alive and DIN-alive are genuinely different sets',
    OUTPUT_DEST_USB_ALIVE.has(1) && !OUTPUT_DEST_DIN_ALIVE.has(1)
    && OUTPUT_DEST_DIN_ALIVE.has(4) && !OUTPUT_DEST_USB_ALIVE.has(4));

  // The agent needs to be told this exists, or it will report a warned write as
  // a plain success.
  check('the MicroFreak guidance covers the DIN leg',
    /midi_thru/.test(MICROFREAK.agent_guidance.midi_out_leg ?? ''),
    'agent_guidance.midi_out_leg must explain the silent DIN failure');

  if (savedEnv === undefined) delete process.env[RIG_MANIFEST_ENV];
  else process.env[RIG_MANIFEST_ENV] = savedEnv;
  clearRigManifestCache();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0
  ? 'verify-arturia: all checks passed'
  : `verify-arturia: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
