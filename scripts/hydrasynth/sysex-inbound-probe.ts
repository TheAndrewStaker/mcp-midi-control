/**
 * Hydrasynth — SysEx inbound diagnostic.
 *
 * Sole purpose: prove or disprove that node-midi is receiving SysEx
 * traffic from the Hydrasynth at all. We send two well-documented
 * commands that BOTH elicit responses per `SysexEncoding.txt`:
 *
 *   ->  00 00          Handshake          (line 556)
 *   <-  01 00 ...      Handshake Response (line 558 — bank names)
 *
 *   ->  18 00          Header             (line 388)
 *   <-  19 00          Header Response    (line 390)
 *
 * If we send these and get NOTHING back, the inbound pipeline is
 * broken (port quirk, driver, ignoreTypes wiring) — and any earlier
 * test that concluded "no response = no flash" is suspect.
 *
 * Run:  npx tsx scripts/hydrasynth/sysex-inbound-probe.ts
 */
import midi from "@julusian/midi";

const HYDRA_PORT_NEEDLES = ['hydrasynth', 'asm hydra'];
const SYSEX_PREFIX = [0xf0, 0x00, 0x20, 0x2b, 0x00, 0x6f];
const SYSEX_END = 0xf7;

function wrap(inner: number[]): number[] {
  return [...SYSEX_PREFIX, ...inner, SYSEX_END];
}

function toHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function findPort(io: { getPortCount(): number; getPortName(i: number): string }): number {
  for (let i = 0; i < io.getPortCount(); i++) {
    if (HYDRA_PORT_NEEDLES.some((n) => io.getPortName(i).toLowerCase().includes(n))) {
      return i;
    }
  }
  return -1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const out = new midi.Output();
  const inp = new midi.Input();

  const outIdx = findPort(out);
  const inIdx = findPort(inp);
  if (outIdx < 0 || inIdx < 0) {
    console.error('Hydrasynth port not found.');
    process.exit(1);
  }

  inp.ignoreTypes(false, true, true);
  const start = Date.now();
  inp.on('message', (_dt, m) => {
    const ms = Date.now() - start;
    console.log(`<- +${ms}ms  ${toHex([...m])}`);
  });

  inp.openPort(inIdx);
  out.openPort(outIdx);
  console.log(`Output: "${out.getPortName(outIdx)}"`);
  console.log(`Input:  "${inp.getPortName(inIdx)}"`);
  console.log();

  // Tiny pause to make sure the input listener is fully wired before
  // we send anything (Windows MIDI driver sometimes drops the first
  // burst of inbound traffic if the port was just opened).
  await sleep(100);

  console.log('Test 1: Handshake (00 00) — expect Handshake Response (01 00 ...)');
  const handshake = wrap([0x00, 0x00]);
  console.log(`-> +${Date.now() - start}ms  ${toHex(handshake)}`);
  out.sendMessage(handshake);
  await sleep(800);

  console.log();
  console.log('Test 2: Header (18 00) — expect Header Response (19 00)');
  const header = wrap([0x18, 0x00]);
  console.log(`-> +${Date.now() - start}ms  ${toHex(header)}`);
  out.sendMessage(header);
  await sleep(800);

  // Cleanup: send Footer to leave the device in a clean state in case
  // Header put it into a "waiting for chunks" mode.
  console.log();
  console.log('Cleanup: Footer (1A 00)');
  const footer = wrap([0x1a, 0x00]);
  console.log(`-> +${Date.now() - start}ms  ${toHex(footer)}`);
  out.sendMessage(footer);
  await sleep(500);

  out.closePort();
  inp.closePort();

  console.log();
  console.log('--- Done ---');
  console.log('  Expect: 1 inbound message after Handshake (01 00 + bank names)');
  console.log('          1 inbound message after Header    (19 00)');
  console.log('  If you saw 2 inbound messages, the input pipeline is fine.');
  console.log('  If you saw 0, the input pipeline is broken (driver, port,');
  console.log('    or another app holding the port).');
}

main().catch((err) => {
  console.error('FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
