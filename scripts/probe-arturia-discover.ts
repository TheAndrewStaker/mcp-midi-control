/**
 * Arturia device DISCOVERY probe. READ-ONLY, and provably so: the only two
 * Arturia opcodes it ever sends are `0x43` (read one global setting) and `0x19`
 * with a trailing 0 (read one preset NAME). It never sends `0x42`, the global
 * WRITE, and never sends a Program Change, a CC, or a note. Nothing it sends
 * can alter the device's memory, its settings, or which preset is loaded.
 *
 * ## What this is for
 *
 * The Arturia SysEx envelope is BRAND-level: `F0 00 20 6B <device> ...`. Every
 * Arturia instrument shares it and differs only by that one `<device>` byte. We
 * know `0x07` is the MicroFreak (hardware-confirmed here), and the community
 * notes give `0x04` MiniBrute and `0x06` MatrixBrute. Every other Arturia
 * instrument, the MiniFreak included, is blocked on nothing more than that
 * single unknown byte.
 *
 * Guessing it is not an option: a wrong byte addresses some OTHER Arturia
 * product. So this probe finds it empirically instead, by sweeping all 128
 * possible device bytes with a harmless read and seeing which one answers.
 *
 * ## Why a sweep is safe here
 *
 * A device ignores any message not addressed to its own device byte, and the
 * two opcodes used are reads. The worst case for the 127 wrong bytes is that
 * nothing happens. This is the same reason the sweep is worth running even on a
 * device nobody has decoded: it cannot break anything.
 *
 * ## Method validation
 *
 * Run it against a MicroFreak first. If it rediscovers `0x07` without being
 * told, the method is proven and its answer on an unknown device can be
 * trusted. That validation is the whole reason to trust a result from a device
 * this project has never seen.
 *
 * Fully automated: it reads and compares its own results with no human
 * observation step, so timed waits are appropriate here (the interactive-probe
 * rule in CLAUDE.md governs probes that ask a person to watch the hardware).
 *
 * ## Usage
 *
 *   npx tsx scripts/probe-arturia-discover.ts                 # auto-find an Arturia port
 *   npx tsx scripts/probe-arturia-discover.ts "MiniFreak"     # match a port by name
 *
 * Paste the whole output into the tracking issue. The "REPORT" block at the end
 * is the part that matters; it is self-contained.
 */
import {
  ARTURIA_ID as ARTURIA,
  buildGlobalRead,
  buildNameRequest,
  CMD,
  NAME_OFFSET,
} from '../packages/arturia/src/codec/sysex.js';
import { connect } from '../packages/core/src/midi/transport.js';

/** Device bytes this project already knows, used only to LABEL a hit. */
const KNOWN: Readonly<Record<number, string>> = {
  0x04: 'MiniBrute (community notes, unverified here)',
  0x06: 'MatrixBrute (community notes, unverified here)',
  0x07: 'MicroFreak (hardware-confirmed by this project)',
};

/** Per-probe listen window. 128 codes at this budget is a few seconds total. */
const SWEEP_TIMEOUT_MS = 45;
/** The identity request deserves longer: it is one message, and some devices are slow. */
const IDENTITY_TIMEOUT_MS = 1500;
/** Confirmation reads are re-checks of a known hit, so they can afford to wait. */
const CONFIRM_TIMEOUT_MS = 400;

const hex = (b: readonly number[]): string =>
  b.map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');

const ascii = (b: readonly number[]): string =>
  b.map((x) => (x >= 0x20 && x <= 0x7e ? String.fromCharCode(x) : '.')).join('');

const isArturiaFrame = (b: readonly number[]): boolean =>
  b[1] === ARTURIA[0] && b[2] === ARTURIA[1] && b[3] === ARTURIA[2];

// The frame builders come from the SHIPPED codec rather than being re-typed
// here. A probe with its own copy of the envelope can silently drift from the
// code it is supposed to be validating, and then a "device does not answer"
// result would mean nothing. `buildNameRequest` is the name READ (trailing 0),
// never `buildDumpStart` (trailing 1), which is why the dump builder is not
// imported at all.

interface Hit {
  sent: number;
  answeredAs: number;
  opcode: string;
  frame: readonly number[];
}

async function main(): Promise<void> {
  const portArg = process.argv[2];
  const needles = portArg === undefined ? ['arturia'] : [portArg.toLowerCase()];

  const conn = connect({
    needles,
    notFoundLeadIn: portArg === undefined
      ? 'No Arturia MIDI port found.'
      : `No MIDI port matching "${portArg}" found.`,
    notFoundHints: [
      'Connect the instrument by USB and power it on.',
      'Pass a port-name fragment as the first argument to target a specific device,',
      '  e.g. npx tsx scripts/probe-arturia-discover.ts "MiniFreak"',
      'IMPORTANT: close MIDI Control Center and any Arturia editor first. MIDI ports are',
      '  exclusive on Windows, so an open editor prevents this probe from opening the port',
      '  (and vice versa: this project\'s MCP server blocks the vendor updater the same way).',
    ],
  });

  let seq = 0;
  const nextSeq = (): number => { const s = seq; seq = (seq + 1) & 0x7f; return s; };
  const listen = (timeoutMs: number, match: (b: readonly number[]) => boolean) =>
    conn.receiveSysExMatching(match, timeoutMs).catch(() => undefined);

  console.log('Arturia device discovery probe (READ-ONLY)');
  console.log('='.repeat(64));
  console.log('Sends only read opcodes (0x43 global read, 0x19 name read).');
  console.log('Never writes, never changes a preset, never alters a setting.\n');

  // ── 1. Universal Identity Request ────────────────────────────────────────
  // Standard MIDI, understood by devices regardless of manufacturer, so it
  // works even if the Arturia sweep below finds nothing at all.
  console.log('1. Universal Identity Request  F0 7E 7F 06 01 F7');
  const idWaiter = listen(IDENTITY_TIMEOUT_MS, (b) => b[1] === 0x7e && b[3] === 0x06 && b[4] === 0x02);
  conn.send([0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]);
  const identity = await idWaiter;

  let identityLine = 'no reply (not fatal: some devices do not implement it)';
  if (identity !== undefined) {
    console.log(`   reply: ${hex(identity)}`);
    if (identity[5] === ARTURIA[0] && identity[6] === ARTURIA[1] && identity[7] === ARTURIA[2]) {
      // Layout matches the MicroFreak's captured reply: mfr id, then a 2-byte
      // family, a 2-byte member, then a version field.
      const family = `${identity[8]?.toString(16).padStart(2, '0')} ${identity[9]?.toString(16).padStart(2, '0')}`;
      const member = `${identity[10]?.toString(16).padStart(2, '0')} ${identity[11]?.toString(16).padStart(2, '0')}`;
      const version = hex(identity.slice(12, identity.length - 1));
      // The version field's FIRST byte appears to track the firmware major
      // version. Three MicroFreak data points agree: an early capture read 0x01,
      // this project measured 0x04 on firmware 4.x, and 0x05 after updating the
      // same unit to 5.0.0. Reported as a likely reading rather than a decode,
      // since three points on one model is a lead, not proof, and the remaining
      // bytes are not understood at all.
      const major = identity[12];
      console.log(`   Arturia confirmed. family=[${family}] member=[${member}] version=[${version}]`);
      console.log(`   firmware major looks like ${major} (first version byte; a lead, not a confirmed decode)`);
      identityLine = `${hex(identity)}   (family=[${family}] member=[${member}] version=[${version}], fw major likely ${major})`;
    } else {
      console.log('   Replied, but NOT with the Arturia manufacturer id. Is this an Arturia device?');
      identityLine = `${hex(identity)}   (non-Arturia manufacturer id)`;
    }
  } else {
    console.log('   no reply within the window.');
  }

  // ── 2. Device-code sweep ─────────────────────────────────────────────────
  console.log(`\n2. Device-code sweep, 0x00..0x7F, using the global READ opcode 0x43`);
  console.log('   (param 0x20 is the MicroFreak\'s MIDI Input Chan; on an unknown device it is');
  console.log('    simply "some global", and reading it is harmless either way)\n');

  const hits: Hit[] = [];
  for (let device = 0x00; device <= 0x7f; device++) {
    const waiter = listen(SWEEP_TIMEOUT_MS, (b) => isArturiaFrame(b));
    conn.send(buildGlobalRead(nextSeq(), 0x20, device));
    const reply = await waiter;
    if (reply !== undefined) {
      hits.push({ sent: device, answeredAs: reply[4], opcode: '0x43 global read', frame: reply });
      const label = KNOWN[device] ?? 'UNKNOWN DEVICE, this is a new discovery';
      console.log(`   HIT  sent device 0x${device.toString(16).padStart(2, '0')} -> ${hex(reply)}`);
      console.log(`        ${label}`);
    }
  }

  // The name-read path is a separate opcode: a device could implement one and
  // not the other, so a silent 0x43 sweep is not proof of "no SysEx".
  if (hits.length === 0) {
    console.log('   no answers to the global read. Trying the preset-NAME opcode 0x19 instead.\n');
    for (let device = 0x00; device <= 0x7f; device++) {
      const waiter = listen(SWEEP_TIMEOUT_MS, (b) => isArturiaFrame(b));
      conn.send(buildNameRequest(nextSeq(), 0, device));
      const reply = await waiter;
      if (reply !== undefined) {
        hits.push({ sent: device, answeredAs: reply[4], opcode: '0x19 name read', frame: reply });
        const label = KNOWN[device] ?? 'UNKNOWN DEVICE, this is a new discovery';
        console.log(`   HIT  sent device 0x${device.toString(16).padStart(2, '0')} -> ${hex(reply)}`);
        console.log(`        ${label}`);
      }
    }
  }

  // ── 3. Confirm a hit, and try to read a preset name from it ─────────────
  const confirmations: string[] = [];
  if (hits.length > 0) {
    const device = hits[0].sent;
    console.log(`\n3. Confirming device code 0x${device.toString(16).padStart(2, '0')}`);

    // Re-read the same global. A one-off hit could be a stray; a repeat is not.
    const reWaiter = listen(CONFIRM_TIMEOUT_MS, (b) => isArturiaFrame(b) && b[4] === device);
    conn.send(buildGlobalRead(nextSeq(), 0x20, device));
    const reReply = await reWaiter;
    const repeatable = reReply !== undefined;
    console.log(`   repeat global read: ${repeatable ? `OK  ${hex(reReply)}` : 'no reply (the first hit may have been a stray)'}`);
    confirmations.push(`repeatable global read: ${repeatable ? 'YES' : 'NO'}`);

    // A name answer is the single most useful extra signal: it proves the
    // preset-name path AND shows where the ASCII sits in the payload.
    const nameWaiter = listen(CONFIRM_TIMEOUT_MS, (b) => isArturiaFrame(b) && b[4] === device && b[8] === CMD.NAME_REPLY);
    conn.send(buildNameRequest(nextSeq(), 0, device));
    const nameReply = await nameWaiter;
    if (nameReply !== undefined) {
      console.log(`   preset-name read:   OK  ${hex(nameReply)}`);
      console.log(`   as ASCII:               ${ascii(nameReply)}`);
      // On the MicroFreak the name begins at NAME_OFFSET. Report what this model does.
      const at21 = nameReply[NAME_OFFSET];
      const looksLikeName = at21 !== undefined && at21 >= 0x20 && at21 <= 0x7e;
      console.log(`   byte ${NAME_OFFSET} is ${looksLikeName ? 'printable, matching the MicroFreak name offset' : 'NOT printable, so this model uses a different name offset'}`);
      confirmations.push(`preset-name read: YES, name offset ${NAME_OFFSET} ${looksLikeName ? 'matches' : 'does NOT match'}`);
    } else {
      console.log('   preset-name read:   no reply (this model may not implement it)');
      confirmations.push('preset-name read: NO');
    }
  }

  // ── 4. Paste-ready report ────────────────────────────────────────────────
  console.log(`\n${'='.repeat(64)}`);
  console.log('REPORT  (paste everything below into the tracking issue)');
  console.log('='.repeat(64));
  console.log(`port matched:     ${portArg ?? '(auto: first port containing "arturia")'}`);
  console.log(`identity reply:   ${identityLine}`);
  if (hits.length === 0) {
    console.log('device code:      NOT FOUND');
    console.log('');
    console.log('No device byte answered either read opcode. That is a real result, not a');
    console.log('failure: it means this model does not speak the Arturia global/name SysEx');
    console.log('protocol the MicroFreak uses, so it needs a different decode rather than a');
    console.log('device byte. The identity reply above is still useful, please include it.');
  } else {
    for (const h of hits) {
      const flag = h.sent === h.answeredAs ? '' : `  (WARNING: answered as 0x${h.answeredAs.toString(16)})`;
      console.log(`device code:      0x${h.sent.toString(16).padStart(2, '0')} via ${h.opcode}${flag}`);
      console.log(`  raw reply:      ${hex(h.frame)}`);
      console.log(`  known as:       ${KNOWN[h.sent] ?? 'NEW, not previously known to this project'}`);
    }
    for (const c of confirmations) console.log(`  ${c}`);
    if (hits.length > 1) {
      console.log('  NOTE: more than one device byte answered. Include all of them; that is');
      console.log('        itself a finding (possibly a second Arturia device on the same port).');
    }
  }
  console.log('='.repeat(64));

  conn.close();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
