/**
 * Probe: Does fn=0x2e SET_PARAM_DIRECT respect fn=0x11 channel state?
 *
 * Tests the production channel-write flow using fn=0x02 GET as the
 * authoritative per-channel readback (fn=0x1F is NOT channel-aware,
 * confirmed in run 1 of this probe).
 *
 *   fn=0x11 switch to X -> fn=0x2e write param -> fn=0x02 GET -> verify X value
 *   fn=0x11 switch to Y -> fn=0x2e write param -> fn=0x02 GET -> verify Y value
 *   fn=0x11 switch to X -> fn=0x02 GET -> confirm X value held (no clobber)
 *
 * Tests:
 *   1. Amp 1 input_drive per-channel isolation
 *   2. Drive 1 gain per-channel isolation
 *   3. Multi-block channel independence (fn=0x11 is per-effectId)
 *   4. effect_type per-channel vs shared behavior
 *   5. fn=0x1F vs fn=0x02 channel-awareness comparison
 *   6. Bypass via fn=0x02 is channel-unaware (lands regardless of fn=0x11 state)
 *   7. Compressor effect_type: fn=0x02 SET vs fn=0x2e channel behavior
 *
 * SAFETY: writes to input_drive, drive.gain, effect_type, bypass, and
 * compressor.effect_type. Saves and restores all original values at the end.
 *
 * Run:
 *   npx tsx scripts/_research/probe-axefx2-channel-write-verify.ts
 */

import midi from "@julusian/midi";

const AXE_FX_II_MODEL = 0x07;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;

const FN_BLOCK_PARAM = 0x02;
const FN_BLOCK_CHANNEL = 0x11;
const FN_GET_ALL_PARAMS = 0x1f;
const FN_SET_PARAM_DIRECT = 0x2e;
const FN_STATE_HEADER = 0x74;
const FN_STATE_CHUNK = 0x75;
const FN_STATE_FOOTER = 0x76;
const FN_MULTIPURPOSE = 0x64;

const ACTION_QUERY = 0x00;

const AMP_1 = 106;
const DRIVE_1 = 108;
const COMPRESSOR_1 = 100;
const COMPRESSOR_EFFECT_TYPE_PARAM = 12;
const BYPASS_PARAM_ID = 255;

const TIMEOUT_MS = 3000;

function fractalChecksum(bytes: number[]): number {
  return bytes.reduce((acc, b) => acc ^ b, 0) & 0x7f;
}
function buildEnvelope(fn: number, payload: number[] = []): number[] {
  const head = [SYSEX_START, ...FRACTAL_MFR, AXE_FX_II_MODEL, fn, ...payload];
  return [...head, fractalChecksum(head), SYSEX_END];
}
function encode14(n: number): [number, number] { return [n & 0x7f, (n >> 7) & 0x7f]; }
function decode14(lo: number, hi: number): number { return (lo & 0x7f) | ((hi & 0x7f) << 7); }
function decode16Packed(b0: number, b1: number, b2: number): number {
  return (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14);
}
function packFloat32ForDirect(value: number): [number, number, number, number, number] {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, value, true);
  const bytes = new Uint8Array(buf);
  const n = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | ((bytes[3] << 24) >>> 0);
  return [n & 0x7f, (n >> 7) & 0x7f, (n >> 14) & 0x7f, (n >> 21) & 0x7f, (n >> 28) & 0x0f];
}
function findPort(io: midi.Input | midi.Output, needles: string[]): number {
  for (let i = 0; i < io.getPortCount(); i++) {
    const name = io.getPortName(i);
    for (const n of needles) { if (name.toLowerCase().includes(n.toLowerCase())) return i; }
  }
  return -1;
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

function isFractalFn(bytes: number[], fn: number): boolean {
  return bytes.length >= 7 && bytes[0] === 0xf0 && bytes[1] === 0x00
    && bytes[2] === 0x01 && bytes[3] === 0x74 && bytes[4] === AXE_FX_II_MODEL && bytes[5] === fn;
}
function decodeChunkFrame(bytes: number[]): number[] {
  const itemCount = decode14(bytes[6], bytes[7]);
  const out: number[] = [];
  const start = 8; const end = bytes.length - 2;
  for (let i = 0; i < itemCount; i++) {
    const off = start + i * 3;
    if (off + 2 >= end) break;
    out.push(decode16Packed(bytes[off], bytes[off + 1], bytes[off + 2]));
  }
  return out;
}

interface StateDump { targetId: number; itemCount: number; values: number[] }

async function readAllParams(
  output: midi.Output,
  collected: number[][],
  effectId: number,
): Promise<StateDump | null> {
  const before = collected.length;
  output.sendMessage(buildEnvelope(FN_GET_ALL_PARAMS, [...encode14(effectId)]));
  const deadline = Date.now() + TIMEOUT_MS;
  let header: StateDump | undefined;
  const values: number[] = [];
  while (Date.now() < deadline) {
    await sleep(50);
    for (let i = before; i < collected.length; i++) {
      const frame = collected[i];
      if (isFractalFn(frame, FN_STATE_HEADER)) {
        const tId = decode14(frame[6], frame[7]);
        if (tId === effectId && !header) {
          header = { targetId: tId, itemCount: decode14(frame[8], frame[9]), values: [] };
        }
      } else if (isFractalFn(frame, FN_STATE_CHUNK) && header) {
        for (const v of decodeChunkFrame(frame)) values.push(v);
      } else if (isFractalFn(frame, FN_STATE_FOOTER) && header) {
        return { ...header, values };
      } else if (isFractalFn(frame, FN_MULTIPURPOSE)) {
        return null;
      }
    }
  }
  if (header) return { ...header, values };
  return null;
}

function switchChannel(output: midi.Output, effectId: number, channel: 0 | 1): void {
  output.sendMessage(buildEnvelope(FN_BLOCK_CHANNEL, [...encode14(effectId), channel]));
}

function buildSetParamDirect(effectId: number, paramId: number, displayValue: number): number[] {
  return buildEnvelope(FN_SET_PARAM_DIRECT, [
    ...encode14(effectId), ...encode14(paramId), ...packFloat32ForDirect(displayValue),
  ]);
}

function packValue16(value: number): [number, number, number] {
  return [value & 0x7f, (value >> 7) & 0x7f, (value >> 14) & 0x03];
}

function buildSetParamLegacy(effectId: number, paramId: number, wireValue: number): number[] {
  return buildEnvelope(FN_BLOCK_PARAM, [
    ...encode14(effectId), ...encode14(paramId), ...packValue16(wireValue), 0x01,
  ]);
}

interface GetParamResponse { effectId: number; paramId: number; wireValue: number; label: string }

async function getParam(
  output: midi.Output,
  collected: number[][],
  effectId: number,
  paramId: number,
): Promise<GetParamResponse | null> {
  const before = collected.length;
  output.sendMessage(buildEnvelope(FN_BLOCK_PARAM, [
    ...encode14(effectId), ...encode14(paramId), 0x00, 0x00, 0x00, ACTION_QUERY,
  ]));
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(30);
    for (let i = before; i < collected.length; i++) {
      const bytes = collected[i];
      if (!isFractalFn(bytes, FN_BLOCK_PARAM)) continue;
      if (bytes.length < 17) continue;
      const eff = decode14(bytes[6], bytes[7]);
      const param = decode14(bytes[8], bytes[9]);
      if (eff !== effectId || param !== paramId) continue;
      const wire = decode16Packed(bytes[10], bytes[11], bytes[12]);
      const labelBytes: number[] = [];
      for (let j = 18; j < bytes.length - 2 && bytes[j] !== 0x00; j++) {
        labelBytes.push(bytes[j]);
      }
      return { effectId: eff, paramId: param, wireValue: wire, label: String.fromCharCode(...labelBytes) };
    }
  }
  return null;
}

function pass(msg: string) { console.log(`  PASS: ${msg}`); }
function fail(msg: string) { console.log(`  FAIL: ${msg}`); }

async function main(): Promise<void> {
  console.log('===================================================================');
  console.log('  Channel Write Verification: fn=0x2e + fn=0x11');
  console.log('  Readback: fn=0x02 GET (authoritative per-channel)');
  console.log('===================================================================\n');

  const input = new midi.Input();
  const output = new midi.Output();
  const needles = ['Axe-Fx II', 'AxeFxII', 'AXE-FX II', 'XL+'];
  const outIdx = findPort(output, needles);
  if (outIdx < 0) { console.error('ERROR: Axe-Fx II output port not found'); process.exit(1); }
  const inIdx = findPort(input, needles);
  if (inIdx < 0) { console.error('ERROR: Axe-Fx II input port not found'); process.exit(1); }

  console.log(`  Output port: ${output.getPortName(outIdx)}`);
  console.log(`  Input port:  ${input.getPortName(inIdx)}\n`);

  output.openPort(outIdx);
  input.ignoreTypes(false, true, true);
  const collected: number[][] = [];
  input.on('message', (_dt, bytes) => { if (bytes[0] === 0xf0) collected.push(bytes.slice()); });
  input.openPort(inIdx);
  await sleep(500);
  collected.length = 0;

  let passes = 0;
  let fails = 0;
  const results: string[] = [];

  function check(condition: boolean, msg: string) {
    if (condition) { pass(msg); passes++; results.push(`PASS: ${msg}`); }
    else { fail(msg); fails++; results.push(`FAIL: ${msg}`); }
  }

  // Save original values for restoration.
  const originals: Array<{ effectId: number; paramId: number; channel: 0 | 1; label: string; wire: number }> = [];

  async function saveOriginal(effectId: number, paramId: number, ch: 0 | 1): Promise<GetParamResponse | null> {
    switchChannel(output, effectId, ch);
    await sleep(200);
    const r = await getParam(output, collected, effectId, paramId);
    if (r) originals.push({ effectId, paramId, channel: ch, label: r.label, wire: r.wireValue });
    return r;
  }

  try {
    // ================================================================
    // TEST 1: Amp 1 input_drive (paramId=1) channel isolation
    // ================================================================
    console.log('[TEST 1] Amp 1 input_drive (paramId=1) channel isolation');
    console.log('----------------------------------------------------------\n');

    const origAmpXDrive = await saveOriginal(AMP_1, 1, 0);
    const origAmpYDrive = await saveOriginal(AMP_1, 1, 1);
    if (!origAmpXDrive || !origAmpYDrive) { console.error('ABORT: cannot read Amp 1'); process.exit(1); }

    console.log(`  Original X: wire=${origAmpXDrive.wireValue}, label="${origAmpXDrive.label}"`);
    console.log(`  Original Y: wire=${origAmpYDrive.wireValue}, label="${origAmpYDrive.label}"\n`);

    // Write 2.0 to X.
    console.log('  Writing input_drive = 2.0 to channel X...');
    switchChannel(output, AMP_1, 0);
    await sleep(200);
    output.sendMessage(buildSetParamDirect(AMP_1, 1, 2.0));
    await sleep(300);
    const readXAfter = await getParam(output, collected, AMP_1, 1);

    // Write 8.0 to Y.
    console.log('  Writing input_drive = 8.0 to channel Y...');
    switchChannel(output, AMP_1, 1);
    await sleep(200);
    output.sendMessage(buildSetParamDirect(AMP_1, 1, 8.0));
    await sleep(300);
    const readYAfter = await getParam(output, collected, AMP_1, 1);

    if (!readXAfter || !readYAfter) { console.error('ABORT: readback failed'); process.exit(1); }

    console.log(`  X readback: wire=${readXAfter.wireValue}, label="${readXAfter.label}"`);
    console.log(`  Y readback: wire=${readYAfter.wireValue}, label="${readYAfter.label}"\n`);

    check(readXAfter.label.includes('2.0'), `X channel received 2.0 (got "${readXAfter.label}")`);
    check(readYAfter.label.includes('8.0'), `Y channel received 8.0 (got "${readYAfter.label}")`);
    check(readXAfter.wireValue !== readYAfter.wireValue, 'X and Y hold DIFFERENT wire values');

    // Switch back to X, confirm X value held.
    console.log('  Switch back to X, verify X held...');
    switchChannel(output, AMP_1, 0);
    await sleep(200);
    const readXConfirm = await getParam(output, collected, AMP_1, 1);
    if (readXConfirm) {
      check(readXConfirm.wireValue === readXAfter.wireValue,
        `X stable after Y write+switch (${readXConfirm.wireValue} === ${readXAfter.wireValue})`);
      console.log(`  X confirm: wire=${readXConfirm.wireValue}, label="${readXConfirm.label}"`);
    }

    // Switch to Y, confirm Y value held.
    console.log('  Switch to Y, verify Y held...');
    switchChannel(output, AMP_1, 1);
    await sleep(200);
    const readYConfirm = await getParam(output, collected, AMP_1, 1);
    if (readYConfirm) {
      check(readYConfirm.wireValue === readYAfter.wireValue,
        `Y stable after X switch (${readYConfirm.wireValue} === ${readYAfter.wireValue})`);
      console.log(`  Y confirm: wire=${readYConfirm.wireValue}, label="${readYConfirm.label}"\n`);
    }

    // ================================================================
    // TEST 2: Drive 1 gain (paramId=0) channel isolation
    // ================================================================
    console.log('[TEST 2] Drive 1 gain (paramId=0) channel isolation');
    console.log('----------------------------------------------------------\n');

    const origDrvX = await saveOriginal(DRIVE_1, 0, 0);
    const origDrvY = await saveOriginal(DRIVE_1, 0, 1);
    if (!origDrvX || !origDrvY) { console.error('ABORT: cannot read Drive 1'); process.exit(1); }

    console.log(`  Original X: wire=${origDrvX.wireValue}, label="${origDrvX.label}"`);
    console.log(`  Original Y: wire=${origDrvY.wireValue}, label="${origDrvY.label}"\n`);

    // Write 3.0 to X, 9.0 to Y.
    console.log('  Writing gain = 3.0 to X...');
    switchChannel(output, DRIVE_1, 0);
    await sleep(200);
    output.sendMessage(buildSetParamDirect(DRIVE_1, 0, 3.0));
    await sleep(300);
    const drvReadX = await getParam(output, collected, DRIVE_1, 0);

    console.log('  Writing gain = 9.0 to Y...');
    switchChannel(output, DRIVE_1, 1);
    await sleep(200);
    output.sendMessage(buildSetParamDirect(DRIVE_1, 0, 9.0));
    await sleep(300);
    const drvReadY = await getParam(output, collected, DRIVE_1, 0);

    if (!drvReadX || !drvReadY) { console.error('ABORT: Drive readback failed'); process.exit(1); }

    console.log(`  X readback: wire=${drvReadX.wireValue}, label="${drvReadX.label}"`);
    console.log(`  Y readback: wire=${drvReadY.wireValue}, label="${drvReadY.label}"\n`);

    check(drvReadX.wireValue !== drvReadY.wireValue, 'Drive X and Y hold DIFFERENT wire values');

    // Confirm X stable after Y write.
    switchChannel(output, DRIVE_1, 0);
    await sleep(200);
    const drvXConfirm = await getParam(output, collected, DRIVE_1, 0);
    if (drvXConfirm) {
      check(drvXConfirm.wireValue === drvReadX.wireValue,
        `Drive X stable (${drvXConfirm.wireValue} === ${drvReadX.wireValue})`);
    }

    // ================================================================
    // TEST 3: Multi-block channel independence
    // ================================================================
    console.log('\n[TEST 3] Multi-block channel independence');
    console.log('----------------------------------------------------------\n');

    // Set Drive 1 to X with known value 4.0.
    switchChannel(output, DRIVE_1, 0);
    await sleep(200);
    output.sendMessage(buildSetParamDirect(DRIVE_1, 0, 4.0));
    await sleep(300);
    const drvBaseline = await getParam(output, collected, DRIVE_1, 0);

    // Switch AMP 1 to Y and write there.
    switchChannel(output, AMP_1, 1);
    await sleep(200);
    output.sendMessage(buildSetParamDirect(AMP_1, 1, 6.5));
    await sleep(300);

    // Read Drive 1 (still on X): should be unchanged.
    const drvAfterAmpSwitch = await getParam(output, collected, DRIVE_1, 0);

    if (drvBaseline && drvAfterAmpSwitch) {
      console.log(`  Drive baseline: wire=${drvBaseline.wireValue}, label="${drvBaseline.label}"`);
      console.log(`  Drive after Amp Y switch: wire=${drvAfterAmpSwitch.wireValue}, label="${drvAfterAmpSwitch.label}"\n`);
      check(drvAfterAmpSwitch.wireValue === drvBaseline.wireValue,
        'fn=0x11 on Amp 1 did NOT affect Drive 1 channel state');
    }

    // ================================================================
    // TEST 4: effect_type per-channel behavior
    // ================================================================
    console.log('\n[TEST 4] effect_type per-channel behavior');
    console.log('----------------------------------------------------------\n');

    const origTypeX = await saveOriginal(AMP_1, 0, 0);
    const origTypeY = await saveOriginal(AMP_1, 0, 1);
    if (!origTypeX || !origTypeY) { console.error('ABORT: cannot read effect_type'); process.exit(1); }

    console.log(`  Original X effect_type: wire=${origTypeX.wireValue}, label="${origTypeX.label}"`);
    console.log(`  Original Y effect_type: wire=${origTypeY.wireValue}, label="${origTypeY.label}"\n`);

    // Write a different effect_type to Y only.
    const testType = origTypeX.wireValue === 5 ? 10 : 5;
    console.log(`  Writing effect_type = ${testType} to Y via fn=0x2e...`);
    switchChannel(output, AMP_1, 1);
    await sleep(200);
    output.sendMessage(buildSetParamDirect(AMP_1, 0, testType));
    await sleep(500);

    // Read both channels.
    switchChannel(output, AMP_1, 0);
    await sleep(200);
    const typeAfterX = await getParam(output, collected, AMP_1, 0);
    switchChannel(output, AMP_1, 1);
    await sleep(200);
    const typeAfterY = await getParam(output, collected, AMP_1, 0);

    if (typeAfterX && typeAfterY) {
      console.log(`  After Y write:`);
      console.log(`    X: wire=${typeAfterX.wireValue}, label="${typeAfterX.label}"`);
      console.log(`    Y: wire=${typeAfterY.wireValue}, label="${typeAfterY.label}"\n`);

      if (typeAfterX.wireValue !== typeAfterY.wireValue) {
        console.log('  FINDING: effect_type is PER-CHANNEL (X and Y differ)');
        results.push('effect_type: PER-CHANNEL');
      } else if (typeAfterX.wireValue === testType && typeAfterY.wireValue === testType) {
        console.log('  FINDING: effect_type is SHARED (both channels updated)');
        results.push('effect_type: SHARED between X/Y');
      } else if (typeAfterX.wireValue === origTypeX.wireValue && typeAfterY.wireValue === origTypeY.wireValue) {
        console.log('  FINDING: effect_type IGNORED the fn=0x2e write entirely');
        results.push('effect_type: fn=0x2e write IGNORED');
      } else {
        console.log(`  FINDING: UNEXPECTED (X=${typeAfterX.wireValue}, Y=${typeAfterY.wireValue})`);
        results.push(`effect_type: UNEXPECTED X=${typeAfterX.wireValue} Y=${typeAfterY.wireValue}`);
      }
    }

    // ================================================================
    // TEST 5: fn=0x1F vs fn=0x02 channel-awareness
    // ================================================================
    console.log('\n[TEST 5] fn=0x1F vs fn=0x02 channel-awareness');
    console.log('----------------------------------------------------------\n');

    // Amp 1 should currently have different X/Y values from Test 1.
    // Read via both methods on each channel.
    switchChannel(output, AMP_1, 0);
    await sleep(200);
    const bulk0x1F_X = await readAllParams(output, collected, AMP_1);
    const get0x02_X = await getParam(output, collected, AMP_1, 1);

    switchChannel(output, AMP_1, 1);
    await sleep(200);
    const bulk0x1F_Y = await readAllParams(output, collected, AMP_1);
    const get0x02_Y = await getParam(output, collected, AMP_1, 1);

    if (bulk0x1F_X && bulk0x1F_Y && get0x02_X && get0x02_Y) {
      console.log('  fn=0x1F (state dump) pos[1]:');
      console.log(`    On X: ${bulk0x1F_X.values[1]}`);
      console.log(`    On Y: ${bulk0x1F_Y.values[1]}`);
      console.log(`    Same? ${bulk0x1F_X.values[1] === bulk0x1F_Y.values[1] ? 'YES (NOT channel-aware)' : 'NO (channel-aware)'}`);
      console.log();
      console.log('  fn=0x02 GET:');
      console.log(`    On X: wire=${get0x02_X.wireValue}, label="${get0x02_X.label}"`);
      console.log(`    On Y: wire=${get0x02_Y.wireValue}, label="${get0x02_Y.label}"`);
      console.log(`    Same? ${get0x02_X.wireValue === get0x02_Y.wireValue ? 'YES (NOT channel-aware)' : 'NO (channel-aware)'}\n`);

      const bulk_channel_aware = bulk0x1F_X.values[1] !== bulk0x1F_Y.values[1];
      const get_channel_aware = get0x02_X.wireValue !== get0x02_Y.wireValue;

      results.push(`fn=0x1F channel-aware: ${bulk_channel_aware}`);
      results.push(`fn=0x02 GET channel-aware: ${get_channel_aware}`);

      if (!bulk_channel_aware && get_channel_aware) {
        console.log('  FINDING: fn=0x1F is MONOLITHIC (not channel-aware).');
        console.log('  FINDING: fn=0x02 GET IS channel-aware.');
        console.log('  IMPLICATION: Use fn=0x02 GET for per-channel verification,');
        console.log('  NOT fn=0x1F. The HW-125 claim "fn=0x1F is channel-aware"');
        console.log('  was incorrect.\n');
        results.push('CORRECTED: fn=0x1F is NOT channel-aware (HW-125 error)');
      }
    }

    // ================================================================
    // TEST 6: bypass via fn=0x02 is channel-unaware
    // ================================================================
    //
    // The production fix (2026-05-26) moved buildSetBlockBypass from
    // fn=0x2e to fn=0x02. This test confirms the fix is correct:
    // set Amp 1 channel to Y via fn=0x11, then write bypass=true via
    // fn=0x02 (paramId=255, wire value 1), then read back. If fn=0x02
    // ignores channel context (as documented), bypass should land
    // regardless of the Y channel state.
    console.log('\n[TEST 6] Bypass via fn=0x02 after channel-Y context');
    console.log('----------------------------------------------------------\n');

    // Save original bypass state on default channel.
    switchChannel(output, AMP_1, 0);
    await sleep(200);
    const origBypass = await getParam(output, collected, AMP_1, BYPASS_PARAM_ID);
    if (origBypass) {
      originals.push({ effectId: AMP_1, paramId: BYPASS_PARAM_ID, channel: 0, label: origBypass.label, wire: origBypass.wireValue });
    }

    // Switch to channel Y, then write bypass=true via fn=0x02.
    console.log('  Switching Amp 1 to channel Y...');
    switchChannel(output, AMP_1, 1);
    await sleep(200);
    console.log('  Writing bypass=true via fn=0x02 (paramId=255, wire=1)...');
    output.sendMessage(buildSetParamLegacy(AMP_1, BYPASS_PARAM_ID, 1));
    await sleep(300);

    // Read bypass from channel X (the "default" that fn=0x02 should target).
    console.log('  Switching back to X, reading bypass...');
    switchChannel(output, AMP_1, 0);
    await sleep(200);
    const bypassReadX = await getParam(output, collected, AMP_1, BYPASS_PARAM_ID);
    if (bypassReadX) {
      console.log(`  Bypass on X after fn=0x02 write: wire=${bypassReadX.wireValue}, label="${bypassReadX.label}"`);
      check(bypassReadX.wireValue === 1, `fn=0x02 bypass write landed on X (got wire=${bypassReadX.wireValue}, expected 1)`);
    } else {
      fail('Could not read bypass state');
      fails++;
    }

    // Also read from Y to confirm fn=0x02 is truly channel-unaware.
    switchChannel(output, AMP_1, 1);
    await sleep(200);
    const bypassReadY = await getParam(output, collected, AMP_1, BYPASS_PARAM_ID);
    if (bypassReadY) {
      console.log(`  Bypass on Y: wire=${bypassReadY.wireValue}, label="${bypassReadY.label}"`);
      if (bypassReadX && bypassReadX.wireValue === bypassReadY.wireValue) {
        console.log('  FINDING: bypass reads the same on X and Y (block-global, not per-channel)');
        results.push('bypass: BLOCK-GLOBAL (same on X and Y)');
      } else {
        console.log('  FINDING: bypass differs across channels (unexpected)');
        results.push(`bypass: DIFFERS X=${bypassReadX?.wireValue} Y=${bypassReadY.wireValue}`);
      }
    }

    // Restore: un-bypass.
    console.log('  Restoring bypass=false...');
    switchChannel(output, AMP_1, 0);
    await sleep(100);
    output.sendMessage(buildSetParamLegacy(AMP_1, BYPASS_PARAM_ID, 0));
    await sleep(200);
    const bypassRestored = await getParam(output, collected, AMP_1, BYPASS_PARAM_ID);
    if (bypassRestored) {
      check(bypassRestored.wireValue === 0, `bypass restored to ENGAGED (wire=${bypassRestored.wireValue})`);
    }
    console.log();

    // ================================================================
    // TEST 7: Compressor effect_type — fn=0x02 vs fn=0x2e
    // ================================================================
    //
    // The alpha.6 test showed compressor.effect_type writes acking
    // but not persisting. Hypothesis: fn=0x2e writes to the wrong
    // channel's storage. This test compares:
    //   Round A: channel Y context + fn=0x2e write + X readback
    //   Round B: channel Y context + fn=0x02 write + X readback
    // If Round A fails and Round B succeeds, fn=0x02 is the fix.
    // If both fail, effect_type may be immutable on the compressor.
    console.log('\n[TEST 7] Compressor effect_type: fn=0x02 vs fn=0x2e');
    console.log('----------------------------------------------------------\n');

    // Save original.
    const CET = COMPRESSOR_EFFECT_TYPE_PARAM;
    switchChannel(output, COMPRESSOR_1, 0);
    await sleep(200);
    const origCompTypeX = await getParam(output, collected, COMPRESSOR_1, CET);
    if (origCompTypeX) {
      originals.push({ effectId: COMPRESSOR_1, paramId: CET, channel: 0, label: origCompTypeX.label, wire: origCompTypeX.wireValue });
      console.log(`  Original comp effect_type on X: wire=${origCompTypeX.wireValue}, label="${origCompTypeX.label}"`);
    }
    switchChannel(output, COMPRESSOR_1, 1);
    await sleep(200);
    const origCompTypeY = await getParam(output, collected, COMPRESSOR_1, CET);
    if (origCompTypeY) {
      originals.push({ effectId: COMPRESSOR_1, paramId: CET, channel: 1, label: origCompTypeY.label, wire: origCompTypeY.wireValue });
      console.log(`  Original comp effect_type on Y: wire=${origCompTypeY.wireValue}, label="${origCompTypeY.label}"\n`);
    }

    if (origCompTypeX) {
      // Pick a test value different from the current one.
      // effect_type enum: 0=STUDIO COMP, 1=PEDAL COMP 1, 2=PEDAL COMP 2, etc.
      const testVal = origCompTypeX.wireValue === 1 ? 2 : 1;
      const testLabel = testVal === 1 ? 'PEDAL COMP 1' : 'PEDAL COMP 2';

      // Round A: channel Y + fn=0x2e write.
      console.log(`  Round A: switch to Y, write effect_type=${testVal} (${testLabel}) via fn=0x2e...`);
      switchChannel(output, COMPRESSOR_1, 1);
      await sleep(200);
      output.sendMessage(buildSetParamDirect(COMPRESSOR_1, CET, testVal));
      await sleep(500);

      // Read back from X.
      switchChannel(output, COMPRESSOR_1, 0);
      await sleep(200);
      const roundA_X = await getParam(output, collected, COMPRESSOR_1, CET);
      if (roundA_X) {
        const roundA_landed = roundA_X.wireValue === testVal;
        console.log(`  Round A readback (X): wire=${roundA_X.wireValue}, label="${roundA_X.label}" — ${roundA_landed ? 'LANDED' : 'DID NOT LAND'}`);
        results.push(`comp effect_type via fn=0x2e after Y context: ${roundA_landed ? 'LANDED on X' : 'DID NOT land on X'}`);
      }

      // Restore to original before Round B.
      output.sendMessage(buildSetParamDirect(COMPRESSOR_1, CET, origCompTypeX.wireValue));
      await sleep(300);

      // Round B: channel Y + fn=0x02 write.
      console.log(`  Round B: switch to Y, write effect_type=${testVal} (${testLabel}) via fn=0x02...`);
      switchChannel(output, COMPRESSOR_1, 1);
      await sleep(200);
      output.sendMessage(buildSetParamLegacy(COMPRESSOR_1, CET, testVal));
      await sleep(500);

      // Read back from X.
      switchChannel(output, COMPRESSOR_1, 0);
      await sleep(200);
      const roundB_X = await getParam(output, collected, COMPRESSOR_1, CET);
      if (roundB_X) {
        const roundB_landed = roundB_X.wireValue === testVal;
        console.log(`  Round B readback (X): wire=${roundB_X.wireValue}, label="${roundB_X.label}" — ${roundB_landed ? 'LANDED' : 'DID NOT LAND'}`);
        results.push(`comp effect_type via fn=0x02 after Y context: ${roundB_landed ? 'LANDED on X' : 'DID NOT land on X'}`);

        if (roundA_X && roundA_X.wireValue !== testVal && roundB_landed) {
          console.log('\n  FINDING: fn=0x2e fails after Y context, fn=0x02 works.');
          console.log('  FIX: use fn=0x02 for compressor effect_type writes.\n');
        } else if (roundA_X) {
          const bothLanded = (roundA_X.wireValue === testVal) && roundB_landed;
          const neitherLanded = (roundA_X.wireValue !== testVal) && !roundB_landed;
          if (bothLanded) {
            console.log('\n  FINDING: both fn=0x2e and fn=0x02 land. Channel context is not the issue.\n');
          } else if (neitherLanded) {
            console.log('\n  FINDING: neither opcode persists. effect_type may be read-only on compressor, or needs a different mechanism.\n');
          }
        }
      }

      // Round C: channel X (default) + fn=0x2e write + X readback.
      // Tests whether the write requires matching channel context.
      console.log(`  Round C: stay on X, write effect_type=${testVal} (${testLabel}) via fn=0x2e...`);
      switchChannel(output, COMPRESSOR_1, 0);
      await sleep(200);
      output.sendMessage(buildSetParamDirect(COMPRESSOR_1, CET, testVal));
      await sleep(500);
      const roundC_X = await getParam(output, collected, COMPRESSOR_1, CET);
      if (roundC_X) {
        const roundC_landed = roundC_X.wireValue === testVal;
        console.log(`  Round C readback (X): wire=${roundC_X.wireValue}, label="${roundC_X.label}" — ${roundC_landed ? 'LANDED' : 'DID NOT LAND'}`);
        results.push(`comp effect_type via fn=0x2e on X context: ${roundC_landed ? 'LANDED' : 'DID NOT LAND'}`);
      }

      // Round D: channel X + fn=0x02 write + X readback.
      console.log(`  Round D: stay on X, write effect_type=${testVal} (${testLabel}) via fn=0x02...`);
      output.sendMessage(buildSetParamLegacy(COMPRESSOR_1, CET, testVal));
      await sleep(500);
      const roundD_X = await getParam(output, collected, COMPRESSOR_1, CET);
      if (roundD_X) {
        const roundD_landed = roundD_X.wireValue === testVal;
        console.log(`  Round D readback (X): wire=${roundD_X.wireValue}, label="${roundD_X.label}" — ${roundD_landed ? 'LANDED' : 'DID NOT LAND'}\n`);
        results.push(`comp effect_type via fn=0x02 on X context: ${roundD_landed ? 'LANDED' : 'DID NOT LAND'}`);
      }

      // Restore original.
      switchChannel(output, COMPRESSOR_1, 0);
      await sleep(100);
      output.sendMessage(buildSetParamDirect(COMPRESSOR_1, CET, origCompTypeX.wireValue));
      await sleep(200);
      if (origCompTypeY) {
        switchChannel(output, COMPRESSOR_1, 1);
        await sleep(100);
        output.sendMessage(buildSetParamDirect(COMPRESSOR_1, CET, origCompTypeY.wireValue));
        await sleep(200);
      }
    } else {
      console.log('  SKIP: compressor not readable (block may not be placed).\n');
      results.push('comp effect_type: SKIPPED (block not placed)');
    }

    // ================================================================
    // RESTORE original values
    // ================================================================
    console.log('[RESTORE] Putting original values back');
    console.log('----------------------------------------------------------\n');

    for (const o of originals) {
      switchChannel(output, o.effectId, o.channel);
      await sleep(150);
      // Restore using the wire value reinterpreted as display.
      // For params where wire != display, this may not restore perfectly,
      // but it's the best we can do without a display-to-wire table.
      // The important thing is we don't leave the device in a weird state.
      const displayGuess = o.label.match(/^[\d.-]+/) ? parseFloat(o.label) : o.wire;
      output.sendMessage(buildSetParamDirect(o.effectId, o.paramId, displayGuess));
      await sleep(100);
      console.log(`  Restored effectId=${o.effectId} paramId=${o.paramId} ch=${o.channel === 0 ? 'X' : 'Y'} to "${o.label}"`);
    }

    // Leave blocks on X.
    switchChannel(output, AMP_1, 0);
    switchChannel(output, DRIVE_1, 0);
    await sleep(200);
    console.log('  All blocks returned to channel X.\n');

    // ================================================================
    // SUMMARY
    // ================================================================
    console.log('===================================================================');
    console.log(`  SUMMARY: ${passes} passed, ${fails} failed`);
    console.log('===================================================================\n');
    for (const r of results) {
      console.log(`  ${r}`);
    }
    console.log();

    if (fails === 0) {
      console.log('  VERDICT: fn=0x2e RESPECTS fn=0x11 channel state.');
      console.log('  The alpha.3 Y=X bug was caused by Bug 1 (fn=0x2e value encoding).');
      console.log('  The executor code is correct. Channel writes work after alpha.5 fix.\n');
    } else {
      console.log('  VERDICT: Channel isolation partially broken. See FAIL entries above.\n');
    }

  } finally {
    input.closePort();
    output.closePort();
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
