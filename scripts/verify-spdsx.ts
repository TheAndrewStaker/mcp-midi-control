/**
 * Golden: SPD-SX kit + wave codec round-trips byte-identically against the
 * captured snapshot corpus (samples/spdsx/snap-A, snap-B-import — gitignored).
 *
 * This is the TS equivalent of the proven Python self-tests
 * (scripts/spdsx/spdsx_author.py --selftest, spdsx_wave.py --selftest): it
 * proves the TS port reproduces the device .spd format exactly, so an authored
 * kit/wave is byte-compatible with what the device wrote itself.
 *
 * If the snapshot corpus is absent (fresh clone), it self-tests the pure
 * encoders against in-memory goldens instead and notes the corpus was skipped.
 *
 * Run via:  npx tsx scripts/verify-spdsx.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildKit, buildFullKit, editKitNotes, encodeMinimalKit, encodeFullKit, DEFAULT_FXOFF_HEADER,
  isMinimalKit, nameToCodes, parseMinimalKit, parseFullKit,
} from '@mcp-midi-control/spd-sx/codec/kitXml.js';
import { editPadNotes } from '@mcp-midi-control/spd-sx/storage/authorKit.js';
import { validateKit } from '@mcp-midi-control/spd-sx/codec/verifyKit.js';
import { dataFilename, encodeWavePrm, nameToNm, parseWavePrm } from '@mcp-midi-control/spd-sx/codec/wavePrm.js';
import { addWaves, nextFreeIndex, usedIndices } from '@mcp-midi-control/spd-sx/storage/waveStore.js';
import { padsFromKit, readKit, readWaveNames } from '@mcp-midi-control/spd-sx/storage/inventory.js';
import { normalizeToSpdsx } from '@mcp-midi-control/spd-sx/codec/wav.js';
import { SPD_SX_DESCRIPTOR } from '@mcp-midi-control/spd-sx/descriptor.js';
import { createNullMidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import { openCtx } from '@mcp-midi-control/core/protocol-generic/dispatcher/core.js';
import { DispatchError, type DeviceDescriptor, type DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SNAP_KIT = join(REPO, 'samples', 'spdsx', 'snap-A', 'SPD-SX', 'KIT');
const SNAP_PRM = join(REPO, 'samples', 'spdsx', 'snap-B-import', 'SPD-SX', 'WAVE', 'PRM');

let failures = 0;
const fail = (msg: string) => { console.error(`  FAIL ${msg}`); failures++; };
const ok = (msg: string) => console.log(`  OK   ${msg}`);
function assert(cond: boolean, msg: string) { cond ? ok(msg) : fail(msg); }
const threw = (fn: () => unknown): boolean => { try { fn(); return false; } catch { return true; } };

/** Build a minimal 16-bit PCM WAV (constant sample `value`) for tests. */
function makeTestWav(rate: number, bits: number, channels: number, frames: number, value = 8000): Uint8Array {
  const dataLen = frames * channels * 2;
  const b = new Uint8Array(44 + dataLen);
  const dv = new DataView(b.buffer);
  const a = (o: number, s: string) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  a(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); a(8, 'WAVE');
  a(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, channels, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * channels * 2, true); dv.setUint16(32, channels * 2, true);
  dv.setUint16(34, bits, true); a(36, 'data'); dv.setUint32(40, dataLen, true);
  for (let i = 0; i < frames * channels; i++) dv.setInt16(44 + i * 2, value, true);
  return b;
}

// ── Pure-encoder goldens (always run, no corpus needed) ──────────────────────
console.log('pure encoders:');
assert(
  JSON.stringify(nameToCodes('GGD')) === JSON.stringify([71, 71, 68, 0, 0, 0, 0, 0]),
  'nameToCodes("GGD") NUL-pads to 8',
);
assert(
  JSON.stringify(nameToNm('01_kick')) === JSON.stringify([48, 49, 95, 107, 105, 99, 107, 0, 0, 0, 0, 0]),
  'nameToNm("01_kick") NUL-pads to 12',
);
try { nameToNm('kïck'); fail('nameToNm should reject non-ASCII'); }
catch { ok('nameToNm rejects non-ASCII'); }
// Case-insensitive FAT dedup: a candidate colliding case-folded gets a _NN suffix.
{
  const taken = new Set(['kick.wav']);
  const fn = dataFilename('Kick', (c) => taken.has(c.toLowerCase()));
  assert(fn.toLowerCase() !== 'kick.wav' && fn.endsWith('.wav'), `dataFilename case-folds FAT collisions (Kick → ${fn})`);
}

// ── normalize-on-upload: resample/requantize any WAV to 44.1k/16 ─────────────
console.log('\nwav normalize (resample on import):');
{
  // Build a tiny PCM WAV with a given rate / bit depth / channel count.
  const makeWav = (rate: number, bits: number, channels: number, frames: number, fmt = 1): Uint8Array => {
    const bytesPer = bits >> 3;
    const dataLen = frames * channels * bytesPer;
    const b = new Uint8Array(44 + dataLen);
    const dv = new DataView(b.buffer);
    const a = (o: number, s: string) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
    a(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); a(8, 'WAVE');
    a(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, fmt, true);
    dv.setUint16(22, channels, true); dv.setUint32(24, rate, true);
    dv.setUint32(28, rate * channels * bytesPer, true); dv.setUint16(32, channels * bytesPer, true);
    dv.setUint16(34, bits, true); a(36, 'data'); dv.setUint32(40, dataLen, true);
    for (let i = 0; i < frames * channels; i++) {
      if (fmt === 3 && bits === 32) dv.setFloat32(44 + i * 4, 0.25, true);
      else if (bits === 16) dv.setInt16(44 + i * 2, 8000, true);
      else if (bits === 24) { const p = 44 + i * 3; b[p] = 0; b[p + 1] = 0; b[p + 2] = 0x10; }
    }
    return b;
  };
  const head = (w: Uint8Array) => ({
    rate: new DataView(w.buffer).getUint32(24, true),
    bits: new DataView(w.buffer).getUint16(34, true),
    channels: new DataView(w.buffer).getUint16(22, true),
  });

  // 48k/16/mono → 44.1k/16/mono, converted, frame count scaled by 44100/48000.
  const r1 = normalizeToSpdsx(makeWav(48000, 16, 1, 4800), 'a');
  const h1 = head(r1.bytes);
  assert(r1.converted && h1.rate === 44100 && h1.bits === 16 && h1.channels === 1,
    `48k/16 mono → 44.1k/16 mono, converted (${r1.note})`);
  const outFrames = (r1.bytes.length - 44) / 2;
  assert(Math.abs(outFrames - Math.round(4800 * 44100 / 48000)) <= 1, `resampled frame count ≈ ${Math.round(4800 * 44100 / 48000)} (got ${outFrames})`);

  // Stereo is PRESERVED (not folded to mono, unlike Circuit).
  const r2 = normalizeToSpdsx(makeWav(48000, 24, 2, 1000), 'b');
  assert(head(r2.bytes).channels === 2 && head(r2.bytes).bits === 16, '48k/24 stereo → 44.1k/16 STEREO (channels preserved)');

  // float32 input is accepted (audioFormat 3).
  const r3 = normalizeToSpdsx(makeWav(48000, 32, 1, 100, 3), 'c');
  assert(r3.converted && head(r3.bytes).bits === 16, 'float32 WAV accepted → 44.1k/16');

  // Already 44.1k/16 → not converted (only chunk-stripped).
  const r4 = normalizeToSpdsx(makeWav(44100, 16, 1, 100), 'd');
  assert(r4.converted === false, 'already 44.1k/16 → converted:false (chunk-strip only)');

  // decodeChannels branch coverage with value checks (8-bit unsigned, 32-bit int).
  const firstSample16 = (w: Uint8Array) => new DataView(normalizeToSpdsx(w, 'x').bytes.buffer).getInt16(44, true);
  const wav1 = (bits: number, fmt: number, put: (dv: DataView, b: Uint8Array, o: number) => void): Uint8Array => {
    const bp = bits >> 3, b = new Uint8Array(44 + bp), dv = new DataView(b.buffer);
    const a = (o: number, s: string) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
    a(0, 'RIFF'); dv.setUint32(4, 36 + bp, true); a(8, 'WAVE'); a(12, 'fmt '); dv.setUint32(16, 16, true);
    dv.setUint16(20, fmt, true); dv.setUint16(22, 1, true); dv.setUint32(24, 44100, true);
    dv.setUint32(28, 44100 * bp, true); dv.setUint16(32, bp, true); dv.setUint16(34, bits, true);
    a(36, 'data'); dv.setUint32(40, bp, true); put(dv, b, 44); return b;
  };
  const s8 = firstSample16(wav1(8, 1, (_dv, b, o) => { b[o] = 192; }));        // (192-128)/128 = +0.5
  assert(Math.abs(s8 - 16383) <= 2, `8-bit unsigned decodes (192 → ${s8}, expect ~16383)`);
  const s32 = firstSample16(wav1(32, 1, (dv, _b, o) => dv.setInt32(o, Math.round(0.5 * 2147483648), true)));
  assert(Math.abs(s32 - 16383) <= 2, `32-bit int decodes (+0.5 → ${s32}, expect ~16383)`);

  // float WAV must be 32-bit; a mislabeled 16-bit float is rejected (not misread as int16).
  let badFloatThrew = false;
  try { normalizeToSpdsx(makeWav(44100, 16, 1, 10, 3), 'bf'); } catch { badFloatThrew = true; }
  assert(badFloatThrew, 'float WAV with non-32-bit depth is rejected');
}

// ── Negative corpus: filesystem robustness (temp tree, no device) ────────────
console.log('\nwave-store robustness (temp tree):');
{
  const tmp = mkdtempSync(join(tmpdir(), 'spdsx-test-'));
  try {
    // empty PRM tree → nextFreeIndex must THROW (never start at 0 and clobber wave 0).
    mkdirSync(join(tmp, 'WAVE', 'PRM'), { recursive: true });
    try { nextFreeIndex(tmp); fail('nextFreeIndex must throw on an empty PRM tree'); }
    catch { ok('nextFreeIndex throws on an empty PRM tree (no clobber-at-0)'); }

    // Populate bucket 04 with valid slots + noise (AppleDouble, .DS_Store, non-numeric).
    const b04 = join(tmp, 'WAVE', 'PRM', '04');
    mkdirSync(b04, { recursive: true });
    for (const f of ['61.spd', '62.spd', '._62.spd', '.DS_Store', 'notes.txt', 'README.spd']) {
      writeFileSync(join(b04, f), '<WvPrm></WvPrm>');
    }
    // A non-numeric bucket dir must be ignored too.
    mkdirSync(join(tmp, 'WAVE', 'PRM', 'TMP'), { recursive: true });
    writeFileSync(join(tmp, 'WAVE', 'PRM', 'TMP', '00.spd'), '<WvPrm></WvPrm>');

    const used = usedIndices(tmp);
    assert(used.has(461) && used.has(462) && used.size === 2, `usedIndices skips AppleDouble/non-numeric noise (got ${[...used].sort().join(',')})`);
    assert(nextFreeIndex(tmp) === 463, `nextFreeIndex = 463 after 461,462 (got ${nextFreeIndex(tmp)})`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── upload-time duplicate detection (byte-identical + name collision) ────────
console.log('\nduplicate detection (addWaves):');
{
  // Manually seed wave 0 'tone' (addWaves refuses an empty pool by design — the
  // flaky-link guard; a real device always has factory waves). The seed DATA is
  // the NORMALIZED form so a re-upload of the same source is byte-identical.
  const seedPool = (root: string, name: string, src: Uint8Array) => {
    mkdirSync(join(root, 'WAVE', 'DATA', '00'), { recursive: true });
    mkdirSync(join(root, 'WAVE', 'PRM', '00'), { recursive: true });
    writeFileSync(join(root, 'WAVE', 'DATA', '00', `${name}.wav`), normalizeToSpdsx(src, name).bytes);
    writeFileSync(join(root, 'WAVE', 'PRM', '00', '00.spd'), encodeWavePrm(nameToNm(name), `00/${name}.wav`, 0));
  };
  const wavA = makeTestWav(44100, 16, 1, 200, 7000);
  const wavB = makeTestWav(44100, 16, 1, 200, 3000); // same length, DIFFERENT audio

  const tmp = mkdtempSync(join(tmpdir(), 'spdsx-dup-'));
  try {
    seedPool(tmp, 'tone', wavA); // wave 0 = 'tone' (audio A)

    // Re-import the IDENTICAL audio under a different name → byte-identical dup of 0.
    const [dup] = addWaves(tmp, [{ wav: wavA, name: 'tone_copy' }]);
    assert(dup.duplicateOf?.index === 0, `byte-identical re-upload flagged as duplicate of wave 0 (got ${JSON.stringify(dup.duplicateOf)})`);
    assert(!!dup.warning && /byte-identical/.test(dup.warning), 'duplicate carries a byte-identical warning');

    // Import DIFFERENT audio under the SAME name 'tone' → name collision, not a dup.
    const [coll] = addWaves(tmp, [{ wav: wavB, name: 'tone' }]);
    assert(coll.nameCollisionWith?.index === 0 && !coll.duplicateOf,
      `same-name different-audio flagged as name collision, not duplicate (got ${JSON.stringify({ dup: coll.duplicateOf, name: coll.nameCollisionWith })})`);

    // A genuinely new wave (different audio + name) → neither flag.
    const [fresh] = addWaves(tmp, [{ wav: makeTestWav(44100, 16, 1, 123, 99), name: 'fresh' }]);
    assert(!fresh.duplicateOf && !fresh.nameCollisionWith, 'a novel wave triggers no duplicate/collision warning');

    // Cache invalidation: a wave added EXTERNALLY (the on-disk index set changes)
    // is picked up on the next upload — the cached index rebuilds, never stale.
    const extWav = makeTestWav(44100, 16, 1, 77, 55);
    writeFileSync(join(tmp, 'WAVE', 'DATA', '00', 'extwave.wav'), normalizeToSpdsx(extWav, 'extwave').bytes);
    writeFileSync(join(tmp, 'WAVE', 'PRM', '00', '05.spd'), encodeWavePrm(nameToNm('extwave'), '00/extwave.wav', 0));
    const [extDup] = addWaves(tmp, [{ wav: extWav, name: 'ext_copy' }]);
    assert(extDup.duplicateOf?.index === 5,
      `externally-added wave seen on next upload (cache rebuilt on index-set change; got ${JSON.stringify(extDup.duplicateOf)})`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // Intra-batch: two identical waves in one call → the second flags the first.
  const tmp2 = mkdtempSync(join(tmpdir(), 'spdsx-dup2-'));
  try {
    seedPool(tmp2, 'base', makeTestWav(44100, 16, 1, 50, 1000)); // distinct seed
    const batch = addWaves(tmp2, [{ wav: wavA, name: 'a1' }, { wav: wavA, name: 'a2' }]);
    assert(!batch[0].duplicateOf && batch[1].duplicateOf?.index === batch[0].index,
      'intra-batch: 1st is novel, 2nd identical wave flags the 1st');

    // Intra-batch SAME-NAME, DIFFERENT audio → name collision flagged on the 2nd.
    const nb = addWaves(tmp2, [
      { wav: makeTestWav(44100, 16, 1, 60, 10), name: 'kick' },
      { wav: makeTestWav(44100, 16, 1, 60, 20), name: 'kick' }, // same length+name, different samples
    ]);
    assert(!nb[0].nameCollisionWith && !nb[1].duplicateOf && nb[1].nameCollisionWith?.index === nb[0].index,
      'intra-batch same-name different-audio → 2nd flagged as name collision (not duplicate)');
  } finally {
    rmSync(tmp2, { recursive: true, force: true });
  }

  // Graceful degradation: an existing wave whose DATA file is missing must not
  // crash dedup — the import still succeeds (that wave just drops from the check).
  const tmp4 = mkdtempSync(join(tmpdir(), 'spdsx-dup4-'));
  try {
    mkdirSync(join(tmp4, 'WAVE', 'PRM', '00'), { recursive: true });
    // PRM with NO matching DATA file (the "unreadable/missing DATA" case).
    writeFileSync(join(tmp4, 'WAVE', 'PRM', '00', '00.spd'), encodeWavePrm(nameToNm('ghost'), '00/ghost.wav', 0));
    const [r] = addWaves(tmp4, [{ wav: makeTestWav(44100, 16, 1, 100, 42), name: 'real' }]);
    assert(r.index === 1 && !r.duplicateOf, 'import succeeds when an existing wave DATA is missing (dedup skips it, no crash)');
  } finally {
    rmSync(tmp4, { recursive: true, force: true });
  }
}
{
  const v = validateKit(buildKit('Test', [461, 462, 463]), 463);
  assert(v.ok && v.name === 'Test' && v.assigned === 3, 'validateKit accepts a well-formed authored kit');
  const bad = validateKit(buildKit('Test', [999]), 500);
  assert(!bad.ok, 'validateKit rejects a pad referencing a wave > maxWave');
}

// ── Full-kit encoder (per-pad note / voice / mute group / dynamics) ──────────
console.log('\nfull kit (per-pad MIDI/voice properties):');
{
  // buildFullKit always emits the FULL format (the minimal-vs-full DECISION is in
  // the storage authorKit, asserted in the hybrid-descriptor section below).
  assert(!isMinimalKit(buildFullKit('K', [{ wv: 1 }, { wv: 2 }])), 'buildFullKit emits the full kit format');
  const fk = buildFullKit('Roll', [
    { wv: 5, voice: 'poly', note: 62, dynamics: true },
    { wv: 6, voice: 'mono', note: 64, muteGroup: 3, dynamics: false, level: 80 },
  ]);
  assert(!isMinimalKit(fk), 'buildFullKit with per-pad props emits the FULL kit');
  const fp = parseFullKit(fk);
  assert(fp.pads.length === 15, 'full kit has all 15 PadPrm blocks');
  // VoiceAsgn 1 = POLY, 0 = MONO (corpus-confirmed); Dynamics 1/0; MuteGrp passthrough.
  assert(fp.pads[0].voiceAsgn === 1 && fp.pads[0].noteNum === 62 && fp.pads[0].dynamics === 1 && fp.pads[0].muteGrp === 0,
    'pad 0: poly→VoiceAsgn 1, note 62, dynamics on, mute 0');
  assert(fp.pads[1].voiceAsgn === 0 && fp.pads[1].noteNum === 64 && fp.pads[1].dynamics === 0 && fp.pads[1].muteGrp === 3,
    'pad 1: mono→VoiceAsgn 0, note 64, dynamics off, mute group 3');
  // Per-pad level (WvLevel): explicit on pad 1, default 100 on pad 0.
  assert(fp.pads[0].wvLevel === 100, 'pad 0: level omitted → WvLevel 100 (default)');
  assert(fp.pads[1].wvLevel === 80, 'pad 1: level 80 → WvLevel 80');
  // Empty trailing pads carry the ascending default note + empty wave.
  assert(fp.pads[2].wv === -1 && fp.pads[2].noteNum === 62 && fp.pads[2].voiceAsgn === 1,
    'empty pad 3: wave -1, default note 62 (60 + index), poly default');
  // Validation accepts the full kit (Wv/SubWv ranges checked via parseMinimalKit path).
  assert(validateKit(buildFullKit('Roll', [{ wv: 5, voice: 'poly' }]), 10).ok, 'validateKit accepts a full kit');

  // LOOP pad reproduces the device loop-pad signature (mined from snap-A: every
  // one of the 156 corpus loop pads carries PlayMode=2/Loop=1/TrigType=1 and is
  // MONO). A loop pad defaults to MONO (a re-trigger restarts the bed); a plain
  // one-shot pad keeps PlayMode=-1/Loop=0/TrigType=0/POLY.
  const lk = parseFullKit(buildFullKit('LOOP', [
    { wv: 8, loop: true },                 // loop bed (default mono)
    { wv: 9 },                             // one-shot (default poly)
    { wv: 10, loop: true, voice: 'poly' }, // explicit poly-loop override
  ]));
  assert(lk.pads[0].playMode === 2 && lk.pads[0].loop === 1 && lk.pads[0].trigType === 1 && lk.pads[0].voiceAsgn === 0,
    'loop pad → PlayMode 2 / Loop 1 / TrigType 1 / MONO (device loop-pad signature)');
  assert(lk.pads[1].playMode === -1 && lk.pads[1].loop === 0 && lk.pads[1].trigType === 0 && lk.pads[1].voiceAsgn === 1,
    'one-shot pad → PlayMode -1 / Loop 0 / TrigType 0 / POLY (unchanged default)');
  assert(lk.pads[2].loop === 1 && lk.pads[2].voiceAsgn === 1,
    'explicit voice overrides the loop mono-default (poly-loop still Loop=1)');
}

// ── Corpus round-trips (skipped if the gitignored snapshot is absent) ────────
if (existsSync(SNAP_KIT)) {
  console.log('\nminimal kit round-trips (snap-A):');
  let tested = 0;
  for (const f of readdirSync(SNAP_KIT).filter((n) => /^kit\d+\.spd$/.test(n)).sort()) {
    const text = readFileSync(join(SNAP_KIT, f), 'utf-8');
    if (!isMinimalKit(text)) continue;
    tested++;
    const { nm, subnm, pads } = parseMinimalKit(text);
    if (encodeMinimalKit(nm, subnm, pads) === text) ok(`${f} round-trips byte-identical (${pads.length} pads)`);
    else fail(`${f} round-trip MISMATCH`);
  }
  console.log(`  (${tested} minimal kit(s) tested)`);

  // build_kit reproduces a real <8-char NUL-padded kit (kit035 "Yurt 1").
  const k035 = join(SNAP_KIT, 'kit035.spd');
  if (existsSync(k035)) {
    const text = readFileSync(k035, 'utf-8');
    const wvs = parseMinimalKit(text).pads.map((p) => p[0]).filter((w) => w !== -1);
    assert(buildKit('Yurt 1', wvs) === text, 'buildKit("Yurt 1", ...) reproduces kit035 byte-identical');
  }

  // FULL kit encoder proves byte-identity against a real FX-off device kit
  // (kit016: Level=100/Tempo=1200, both FX off, all Fx prms 0 = DEFAULT_FXOFF_HEADER).
  // This is the evidence the full PadPrm + FX-off header are byte-shaped like the
  // device's own files. (Note acceptance of a SERVER-authored full kit is still a
  // hardware-confirm item — the format is proven, the write is community-beta.)
  console.log('\nfull kit round-trip (snap-A FX-off skeleton):');
  const k016 = join(SNAP_KIT, 'kit016.spd');
  if (existsSync(k016)) {
    const text = readFileSync(k016, 'utf-8');
    const { nm, subnm, pads } = parseFullKit(text);
    assert(encodeFullKit(nm, subnm, DEFAULT_FXOFF_HEADER, pads) === text,
      'encodeFullKit reproduces kit016 (FX-off full kit) byte-identical');
  } else {
    console.log('  (kit016 absent — full-kit round-trip skipped)');
  }
} else {
  console.log('\n(snapshot KIT corpus absent — corpus round-trip skipped)');
}

if (existsSync(SNAP_PRM)) {
  console.log('\nwave-PRM round-trips (snap-B-import):');
  const prms: string[] = [];
  for (const bucket of readdirSync(SNAP_PRM).sort()) {
    const bdir = join(SNAP_PRM, bucket);
    try { for (const f of readdirSync(bdir).sort()) if (/^\d+\.spd$/.test(f)) prms.push(join(bdir, f)); }
    catch { /* not a dir */ }
  }
  let okCount = 0;
  for (const p of prms.slice(0, 60)) {
    const t = readFileSync(p, 'utf-8');
    const { nm, path, tag } = parseWavePrm(t);
    if (encodeWavePrm(nm, path, tag) === t) okCount++;
    else fail(`${p} PRM round-trip mismatch`);
  }
  assert(okCount === Math.min(60, prms.length) && prms.length > 0, `${okCount} PRM file(s) round-trip byte-identical`);
} else {
  console.log('\n(snapshot PRM corpus absent — wave-PRM round-trip skipped)');
}

// ── hybrid descriptor: storage-surface reader/writer + mode guards ───────────
// Build a synthetic mounted SPD-SX tree (PRM files + one kit), then drive the
// descriptor's storage methods directly through a storage-shaped DispatchCtx.
await (async () => {
  console.log('\nhybrid descriptor (storage surface):');
  const tmp = mkdtempSync(join(tmpdir(), 'spdsx-hybrid-'));
  const root = join(tmp, 'Roland', 'SPD-SX');
  try {
    // Wave pool: indices 0 ('kick') and 1 ('snare') in bucket 00.
    mkdirSync(join(root, 'WAVE', 'PRM', '00'), { recursive: true });
    writeFileSync(join(root, 'WAVE', 'PRM', '00', '00.spd'), encodeWavePrm(nameToNm('kick'), '00/kick.wav', 0));
    writeFileSync(join(root, 'WAVE', 'PRM', '00', '01.spd'), encodeWavePrm(nameToNm('snare'), '00/snare.wav', 0));
    // Kit 1 (file kit000.spd) maps pad 1→wave 0, pad 2→wave 1.
    mkdirSync(join(root, 'KIT'), { recursive: true });
    writeFileSync(join(root, 'KIT', 'kit000.spd'), buildKit('TestKit', [0, 1]));

    const conn = createNullMidiConnection(SPD_SX_DESCRIPTOR.display_name);
    const storageCtx = { conn, storage: { root }, descriptor: SPD_SX_DESCRIPTOR } as DispatchCtx;
    const midiCtx = { conn, descriptor: SPD_SX_DESCRIPTOR } as DispatchCtx; // no storage = MIDI surface

    const { reader, writer } = SPD_SX_DESCRIPTOR;

    // transport is declared hybrid (so openCtx resolves per call).
    assert(SPD_SX_DESCRIPTOR.transport?.kind === 'hybrid', 'descriptor declares transport.kind = hybrid');

    // scan_locations lists kits over the range, flagging empties.
    const scan = await reader.scanLocations!(storageCtx, 1, 2);
    assert(scan.scanned.length === 2 && scan.scanned[0].name === 'TestKit' && scan.scanned[0].is_empty === false,
      'scanLocations reads kit 1 name + non-empty');
    assert(scan.scanned[1].is_empty === true, 'scanLocations flags absent kit 2 as empty');

    // get_preset(location) returns the kit's pad→wave map as snapshot slots.
    const snap = await reader.getPreset!(storageCtx, { location: 1 });
    assert(snap.name === 'TestKit' && snap.slots.length === 15, 'getPreset(kit 1) returns 15 pad slots + name');
    assert(snap.slots[0].block_type === 'pad' && (snap.slots[0].params as Record<string, unknown>).wave === 0,
      'getPreset pad 1 → wave 0');
    assert(snap.slots[2].block_type === 'none', 'getPreset unassigned pad → block_type none');

    // list_samples reads the wave pool, and reports it as append-only/unbounded
    // (so occupied == total is not misread as "100% full").
    const dir = await reader.readSampleDirectory!(storageCtx);
    assert(dir.occupied === 2 && dir.slots[0].name === 'kick' && dir.slots[1].name === 'snare',
      'readSampleDirectory lists the wave pool by name');
    assert(dir.unbounded === true && typeof dir.capacity_note === 'string',
      'readSampleDirectory marks the pool unbounded (append-only, not a fixed ceiling)');

    // export_preset(location) dumps a kit's .spd; an absent kit reports empty.
    const dump = await reader.dumpStoredPresetBinary!(1, storageCtx);
    assert(dump.format === 'spd-sx-kit' && dump.file_extension === 'spd' && dump.byte_length > 0 && !dump.empty,
      'dumpStoredPresetBinary(kit 1) returns the .spd bytes');
    const dumpEmpty = await reader.dumpStoredPresetBinary!(2, storageCtx);
    assert(dumpEmpty.empty === true && dumpEmpty.byte_length === 0, 'dumpStoredPresetBinary(absent kit) → empty');

    // author_kit resolves wave names + indices; dry_run validates without writing.
    const authored = await writer.authorKit!(storageCtx, 3, 'New', ['kick', 1], { dryRun: true });
    assert(authored.dry_run === true && authored.assigned === 2 && authored.location === 3,
      'authorKit dry_run resolves names + indices, writes nothing');
    // Minimal-vs-full DECISION: bare waves → minimal kit; any per-pad property → full.
    assert(/\bminimal kit\b/.test(authored.info), 'authorKit with bare waves writes the MINIMAL kit (byte-confirmed path)');
    const authoredFull = await writer.authorKit!(storageCtx, 3, 'Roll',
      [{ wave: 'kick', voice: 'poly', note: 62 }, { wave: 1, voice: 'mono', mute_group: 3 }], { dryRun: true });
    assert(/\bfull kit\b/.test(authoredFull.info) && authoredFull.assigned === 2,
      'authorKit with per-pad note/voice/mute switches to the FULL kit + resolves wave names');
    assert(!!authoredFull.warning && /community-beta|hardware-confirm/i.test(authoredFull.warning),
      'full-kit author flags the format as not-yet-hardware-confirmed');
    // A loop-only pad property is enough to switch to the full-kit format.
    const authoredLoop = await writer.authorKit!(storageCtx, 3, 'Loop',
      [{ wave: 'kick', loop: true }, { wave: 1 }], { dryRun: true });
    assert(/\bfull kit\b/.test(authoredLoop.info) && authoredLoop.assigned === 2,
      'authorKit with a loop-only pad switches to the FULL kit');
    let unknownThrew = false;
    try { await writer.authorKit!(storageCtx, 3, 'X', ['nope'], { dryRun: true }); }
    catch { unknownThrew = true; }
    assert(unknownThrew, 'authorKit rejects an unknown wave name');
    let overwriteThrew = false;
    try { await writer.authorKit!(storageCtx, 1, 'Clobber', [0]); } // kit 1 exists, no confirm
    catch { overwriteThrew = true; }
    assert(overwriteThrew, 'authorKit refuses to overwrite an occupied kit without confirm');

    // pure builder: kit recall PC bytes (ch10 → status 0xC9, kit 1 → PC 0).
    assert(JSON.stringify(writer.buildSwitchPreset!(1)) === JSON.stringify([0xc9, 0]),
      'buildSwitchPreset(kit 1) → [0xC9, 0]');

    // Mode guards: a storage method on a MIDI-surface ctx refuses; a MIDI method
    // on a storage-surface ctx refuses. Both name the mode to switch to.
    let storageGuard = false;
    try { await reader.scanLocations!(midiCtx, 1, 2); } catch { storageGuard = true; }
    assert(storageGuard, 'storage method on MIDI-surface ctx → capability_not_supported (mode guard)');
    let midiGuard = false;
    try { await writer.switchPreset!(storageCtx, 1); } catch { midiGuard = true; }
    assert(midiGuard, 'MIDI method on storage-surface ctx → capability_not_supported (mode guard)');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
})();

// ── get_preset pad-note read: padsFromKit + readKit + readWaveNames ──────────
// Full kits carry per-pad NoteNum/PadMidiCh (noteSource 'kit'); minimal kits do
// NOT (the device fills its own default → noteSource 'device-default', note
// undefined). readKit reads ONE kit; readWaveNames resolves names for only a
// kit's pad waves (the fast path that avoids the whole-pool scan).
{
  console.log('\nget_preset pad-note read (padsFromKit / readKit / readWaveNames):');

  // Full kit with explicit notes on 3 pads (kick/snare/hat = 60/61/62).
  const fullText = buildFullKit('NOTES', [{ wv: 10, note: 60 }, { wv: 11, note: 61 }, { wv: 12, note: 62 }]);
  const full = padsFromKit(fullText);
  assert(full.minimal === false, 'full kit: minimal=false');
  assert(full.pads[0].noteNum === 60 && full.pads[1].noteNum === 61 && full.pads[2].noteNum === 62,
    'full kit: per-pad NoteNum surfaces (60/61/62)');
  assert(full.pads.slice(0, 3).every((p) => p.noteSource === 'kit'), "full kit: noteSource='kit'");
  assert(full.pads[0].padMidiCh === -1, 'full kit: padMidiCh -1 (GLOBAL) by default');
  assert(full.pads[0].wave === 10 && full.pads[3].wave === -1, 'full kit: wave indices + empty pads correct');
  assert(full.pads[0].wvLevel === 100, 'full kit: per-pad WvLevel surfaces (100 default)');
  assert(full.level === 100 && full.fxOn === false, 'full kit: kit master Level=100 + FX off surface');

  // Minimal kit (Wv-only): note NOT in the file → device-default, noteNum undefined.
  const min = padsFromKit(buildKit('MINI', [20, 21, 22]));
  assert(min.minimal === true, 'minimal kit: minimal=true');
  assert(min.pads.every((p) => p.noteSource === 'device-default'), "minimal kit: noteSource='device-default'");
  assert(min.pads.every((p) => p.noteNum === undefined), 'minimal kit: noteNum undefined (not stored)');
  assert(min.pads[0].wave === 20 && min.pads[1].wave === 21, 'minimal kit: Wv still read');

  // readKit + readWaveNames against a temp Roland tree (scoped, fast name lookup).
  const tmp = mkdtempSync(join(tmpdir(), 'spdsx-read-'));
  try {
    mkdirSync(join(tmp, 'KIT'), { recursive: true });
    mkdirSync(join(tmp, 'WAVE', 'PRM', '00'), { recursive: true });
    writeFileSync(join(tmp, 'KIT', 'kit004.spd'), buildFullKit('READK', [{ wv: 3, note: 60 }, { wv: 7, note: 64 }]));
    writeFileSync(join(tmp, 'WAVE', 'PRM', '00', '3.spd'), encodeWavePrm(nameToNm('kick'), '00/kick.wav', 0));
    writeFileSync(join(tmp, 'WAVE', 'PRM', '00', '7.spd'), encodeWavePrm(nameToNm('clap'), '00/clap.wav', 0));

    const k = readKit(tmp, 5); // kit004.spd → device kit 5
    assert(k !== undefined && k.kit === 5 && k.name === 'READK', 'readKit: reads kit004.spd as kit 5');
    assert(k?.pads[0].noteNum === 60 && k?.pads[1].noteNum === 64, 'readKit: surfaces pad notes');
    const names = readWaveNames(tmp, [3, 7, -1]);
    assert(names.get(3) === 'kick' && names.get(7) === 'clap' && names.size === 2,
      'readWaveNames: resolves ONLY the requested indices (ignores -1)');
    assert(readKit(tmp, 99) === undefined, 'readKit: absent kit → undefined');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── non-destructive note edit: editKitNotes + editPadNotes ───────────────────
// Patching a pad note must change ONLY that pad's <NoteNum> (everything else
// byte-identical), and refuse a minimal kit (which has no note to edit).
{
  console.log('\nnon-destructive note edit (editKitNotes / editPadNotes):');

  const before = buildFullKit('EDIT', [{ wv: 5, note: 60 }, { wv: 6, note: 61 }, { wv: 7, note: 62 }]);
  const after = editKitNotes(before, new Map([[0, 72], [2, 74]])); // pad 1 → 72, pad 3 → 74
  const pa = parseFullKit(after);
  assert(pa.pads[0].noteNum === 72 && pa.pads[2].noteNum === 74, 'editKitNotes: patched pads got the new notes');
  assert(pa.pads[1].noteNum === 61, 'editKitNotes: an untouched pad keeps its note');
  // Byte-identical except the two NoteNum lines that changed (60→72, 62→74).
  const diffLines = before.split('\n').filter((ln, i) => ln !== after.split('\n')[i]);
  assert(diffLines.length === 2 && diffLines.every((l) => /<NoteNum>/.test(l)),
    'editKitNotes: ONLY the two NoteNum lines changed (non-destructive)');
  // Waves + levels preserved (the diff-is-only-NoteNum check above already proves this; assert wave explicitly).
  assert(pa.pads[0].wv === 5 && pa.pads[0].wvLevel === 100, 'editKitNotes: wave + level preserved');

  // editPadNotes against a temp tree: full kit patches; minimal kit refuses.
  const tmp = mkdtempSync(join(tmpdir(), 'spdsx-edit-'));
  try {
    mkdirSync(join(tmp, 'KIT'), { recursive: true });
    writeFileSync(join(tmp, 'KIT', 'kit009.spd'), buildFullKit('FULLK', [{ wv: 1, note: 60 }, { wv: 2, note: 61 }]));
    writeFileSync(join(tmp, 'KIT', 'kit010.spd'), buildKit('MINK', [1, 2, 3])); // minimal

    const r = editPadNotes(tmp, 10, new Map([[0, 65]])); // kit009.spd = device kit 10
    assert(r.written && r.kit === 10 && r.patched[0].pad === 1 && r.patched[0].note === 65,
      'editPadNotes: full kit patched (pad 1 → 65)');
    assert(r.backedUp !== undefined, 'editPadNotes: prior kit backed up to .spd.bak');
    const reread = readKit(tmp, 10);
    assert(reread?.pads[0].noteNum === 65 && reread?.pads[1].noteNum === 61,
      'editPadNotes: written kit reads back the patched + preserved notes');

    assert(threw(() => editPadNotes(tmp, 11, new Map([[0, 65]]))), 'editPadNotes: MINIMAL kit (11) refused');
    assert(threw(() => editPadNotes(tmp, 10, new Map([[0, 200]]))), 'editPadNotes: out-of-range note refused');
    assert(threw(() => editPadNotes(tmp, 99, new Map([[0, 65]]))), 'editPadNotes: absent kit refused');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── openCtx: hybrid device connected on NEITHER surface ──────────────────────
// A hybrid device with no mounted drive AND no MIDI port must error with a
// message naming BOTH surfaces (not a bare MIDI port-not-found that mis-directs
// a storage op). Synthetic descriptor → deterministic regardless of env.
{
  console.log('\nopenCtx hybrid (neither surface connected):');
  const fakeHybrid = {
    id: 'fake-hybrid',
    display_name: 'Fake Hybrid',
    connection_label: 'fake-hybrid-no-such-midi-port-zzz', // matches no real port → ensureConnection throws
    transport: { kind: 'hybrid', resolveRoot: () => undefined, notMountedHint: 'PUT IT IN DISK MODE.' },
  } as unknown as DeviceDescriptor;

  let err: unknown;
  try { openCtx(fakeHybrid); } catch (e) { err = e; }
  const msg = err instanceof Error ? err.message : String(err);
  assert(err instanceof DispatchError && err.code === 'device_not_mounted',
    `hybrid + disconnected → DispatchError device_not_mounted (got ${err instanceof DispatchError ? err.code : typeof err})`);
  assert(/either surface/i.test(msg) && /PUT IT IN DISK MODE/.test(msg) && /MIDI/.test(msg),
    'error names BOTH surfaces (storage notMountedHint + the MIDI path)');
}

console.log(failures === 0 ? '\nAll SPD-SX codec goldens passed.' : `\n${failures} SPD-SX codec golden(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
