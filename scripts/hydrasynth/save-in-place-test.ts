/**
 * Hydrasynth — standalone Write Request feasibility test.
 *
 * Goal: verify whether `Header → Write Request → Footer` (no patch
 * chunks in between) persists the device's current working memory to
 * flash. If true, this unlocks a `hydra_save_in_place` tool that
 * preserves manual front-panel edits — instead of today's
 * `apply_patch + save:true` flow which silently re-dumps the agent's
 * recipe and clobbers any tweaks the agent doesn't know about.
 *
 * Per `SysexEncoding.txt` lines 314-381, the Write Request `14 00` is
 * the command that triggers flash burn. The chunks before it update
 * RAM; the WR persists "whole bank current memory". The spec doesn't
 * say whether WR works without preceding chunks — that's what we're
 * here to find out.
 *
 * Sequence:
 *   ->  F0 00 20 2B 00 6F 18 00 F7        Header
 *   ->  F0 00 20 2B 00 6F 14 00 F7        Write Request
 *   <-  F0 00 20 2B 00 6F 15 00 F7        WR Response (expected ~3.5s)
 *   ->  F0 00 20 2B 00 6F 1A 00 F7        Footer
 *   <-  F0 00 20 2B 00 6F 1B 00 F7        Footer Response
 *
 * What this script does NOT do:
 *   - Make any front-panel tweak. The operator is expected to make a
 *     visible manual tweak on the device first (filter cutoff knob,
 *     a clearly-different value), then run this script.
 *   - Power-cycle the device. Operator does that after the script
 *     finishes — the persistence check is by hand.
 *
 * Read `walk me through the test now` in the conversation log for the
 * full operator procedure (3 phases: tweak, run script, power-cycle +
 * verify).
 */
import midi, { Input, Output } from "@julusian/midi";

const HYDRA_PORT_NEEDLES = ['hydrasynth', 'asm hydra'];

// Sysex prefix matches sysexEnvelope.ts HEADER constant.
const SYSEX_PREFIX = [0xf0, 0x00, 0x20, 0x2b, 0x00, 0x6f];
const SYSEX_END = 0xf7;

function wrap(inner: number[]): number[] {
  return [...SYSEX_PREFIX, ...inner, SYSEX_END];
}

const HEADER_MSG = wrap([0x18, 0x00]);
const WRITE_REQUEST_MSG = wrap([0x14, 0x00]);
const FOOTER_MSG = wrap([0x1a, 0x00]);

const WR_RESPONSE_INNER = [0x15, 0x00];
const FOOTER_RESPONSE_INNER = [0x1b, 0x00];

// Per spec: Write Request takes 3+ seconds for the device to actually
// burn flash. We wait conservatively before sending the Footer so the
// WR-Response has time to arrive.
const WR_FLASH_WAIT_MS = 4000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function toHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function findPort(io: { getPortCount(): number; getPortName(i: number): string }): {
  index: number;
  name: string;
} | null {
  for (let i = 0; i < io.getPortCount(); i++) {
    const name = io.getPortName(i);
    if (HYDRA_PORT_NEEDLES.some((n) => name.toLowerCase().includes(n))) {
      return { index: i, name };
    }
  }
  return null;
}

function matchesInner(msg: number[], inner: number[]): boolean {
  if (msg.length !== SYSEX_PREFIX.length + inner.length + 1) return false;
  for (let i = 0; i < SYSEX_PREFIX.length; i++) {
    if (msg[i] !== SYSEX_PREFIX[i]) return false;
  }
  for (let i = 0; i < inner.length; i++) {
    if (msg[SYSEX_PREFIX.length + i] !== inner[i]) return false;
  }
  return msg[msg.length - 1] === SYSEX_END;
}

interface InboundLog {
  msAfterStart: number;
  bytes: number[];
}

async function main(): Promise<void> {
  const out = new midi.Output();
  const inp = new midi.Input();

  console.log('MIDI output ports:');
  for (let i = 0; i < out.getPortCount(); i++) {
    console.log(`  [${i}] ${out.getPortName(i)}`);
  }
  console.log('MIDI input ports:');
  for (let i = 0; i < inp.getPortCount(); i++) {
    console.log(`  [${i}] ${inp.getPortName(i)}`);
  }
  console.log();

  const outPort = findPort(out);
  const inPort = findPort(inp);
  if (!outPort || !inPort) {
    console.error('FAILED: Hydrasynth port(s) not found.');
    console.error('  output port:', outPort);
    console.error('  input port: ', inPort);
    process.exit(1);
  }

  console.log(`Using output [${outPort.index}] "${outPort.name}"`);
  console.log(`Using input  [${inPort.index}] "${inPort.name}"`);
  console.log();

  // node-midi ignores SysEx by default. Enable it.
  inp.ignoreTypes(false, true, true);

  const inbound: InboundLog[] = [];
  const startMs = Date.now();
  inp.on('message', (_dt, message) => {
    inbound.push({ msAfterStart: Date.now() - startMs, bytes: [...message] });
  });

  inp.openPort(inPort.index);
  out.openPort(outPort.index);

  console.log('--- Sending standalone Write Request sequence ---');
  console.log(`-> ${toHex(HEADER_MSG)}   Header (18 00)`);
  out.sendMessage(HEADER_MSG);
  await sleep(80);

  console.log(`-> ${toHex(WRITE_REQUEST_MSG)}   Write Request (14 00)`);
  out.sendMessage(WRITE_REQUEST_MSG);
  console.log(`   waiting ${WR_FLASH_WAIT_MS}ms for flash burn + WR Response (15 00)...`);
  await sleep(WR_FLASH_WAIT_MS);

  console.log(`-> ${toHex(FOOTER_MSG)}   Footer (1A 00)`);
  out.sendMessage(FOOTER_MSG);
  await sleep(500);

  out.closePort();
  inp.closePort();

  console.log();
  console.log(`--- Inbound MIDI captured (${inbound.length} message${inbound.length === 1 ? '' : 's'}) ---`);
  for (const m of inbound) {
    const tag =
      matchesInner(m.bytes, WR_RESPONSE_INNER)
        ? '  ✓ WR Response (15 00)'
        : matchesInner(m.bytes, FOOTER_RESPONSE_INNER)
          ? '  ✓ Footer Response (1B 00)'
          : '';
    console.log(`  +${m.msAfterStart}ms  ${toHex(m.bytes)}${tag}`);
  }

  const sawWrResp = inbound.some((m) => matchesInner(m.bytes, WR_RESPONSE_INNER));
  const sawFooterResp = inbound.some((m) => matchesInner(m.bytes, FOOTER_RESPONSE_INNER));

  console.log();
  console.log('--- Verdict ---');
  console.log(`  WR Response (15 00) seen:     ${sawWrResp ? 'YES' : 'NO'}`);
  console.log(`  Footer Response (1B 00) seen: ${sawFooterResp ? 'YES' : 'NO'}`);
  console.log();
  if (sawWrResp && sawFooterResp) {
    console.log('✓ Device accepted the standalone Write Request protocol.');
    console.log('  Now power-cycle the device and verify that your manual');
    console.log('  filter-cutoff tweak survived. If it did → save-in-place');
    console.log('  is feasible, green-light the tool. If not → device may');
    console.log('  silently no-op standalone WRs.');
  } else if (!sawWrResp) {
    console.log('✗ No WR Response. Device rejected the standalone WR or did');
    console.log('  not consider it a valid command. Save-in-place via this');
    console.log('  protocol is NOT feasible — fall back to chunk-required flow.');
  } else {
    console.log('? Mixed: WR Response seen but no Footer Response. Device may');
    console.log('  be in a half-state. Avoid further operations until power-cycle.');
  }
}

main().catch((err) => {
  console.error('FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
