/**
 * Gen-3 current-type-name READ goldens (fn=0x01 sub=0x1F + sub=0x09 GET).
 *
 * Byte-grounded against a real FM9 (fw 11.0) capture, 2026-06-19
 * (`samples/captured/fm9-windows-verify-2026-06-19/fm9-probe-output.json`,
 * job3 + job2). The device replies to a type-param GET with the current
 * model NAME as an 8→7 packed, length-prefixed display string — decoded by
 * the existing `parseGetParameterResponse`, and surfaced on the SET-echo via
 * `parseGen3SetValueEcho().displayName`.
 *
 *   reverb (eff 66, pid 10) → "Small Room"
 *   amp    (eff 58, pid 10) → "59 Bassguy Bright"
 *   drive  (eff 118, pid 0) → "Rat Distortion"
 *
 * These are the FIRST hardware-captured gen-3 type-name reads on Windows; the
 * decode also fixed the probe's "value 0" misparse (a type GET carries float32
 * ZERO + the name, not a numeric ordinal).
 */
import {
  buildRequestCurrentTypeName,
  parseGetParameterResponse,
  isGetParameterResponse,
  parseGen3SetValueEcho,
} from '../../../src/gen3/axe-fx-iii/index.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function hexStr(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}
function parseHex(s: string): number[] {
  return s.trim().split(/\s+/).map((h) => parseInt(h, 16));
}

const FM9 = 0x12;

// Captured fn=0x01 sub=0x1F REQUESTS (host → device), byte-exact from the probe.
const REQ_REVERB = 'F0 00 01 74 12 01 1F 00 42 00 0A 00 00 00 00 00 00 00 00 00 00 41 F7';
const REQ_AMP    = 'F0 00 01 74 12 01 1F 00 3A 00 0A 00 00 00 00 00 00 00 00 00 00 39 F7';
const REQ_DRIVE  = 'F0 00 01 74 12 01 1F 00 76 00 00 00 00 00 00 00 00 00 00 00 00 7F F7';

// Captured fn=0x01 sub=0x1F REPLIES (device → host).
const REPLY_REVERB = 'F0 00 01 74 12 01 1F 00 42 00 0A 00 00 00 00 00 00 00 00 0B 00 29 5B 2C 16 63 30 40 52 37 5B 6D 50 00 12 F7';
const REPLY_AMP    = 'F0 00 01 74 12 01 1F 00 3A 00 0A 00 00 00 00 00 00 00 00 12 00 1A 4E 24 04 13 05 66 73 33 5D 2F 12 02 09 64 69 33 5A 0E 40 00 2E F7';
const REPLY_DRIVE  = 'F0 00 01 74 12 01 1F 00 76 00 00 00 00 00 00 00 00 00 00 0F 00 29 18 2E 42 02 11 52 73 3A 1B 6E 27 23 25 5E 6E 00 00 41 F7';

// Captured fn=0x01 sub=0x09 GET reply on the reverb TYPE param (job2): the
// frame the probe reported as value:0 — it actually carries "Small Room".
const REPLY_SUB09_REVERB =
  'F0 00 01 74 12 01 09 00 42 00 0A 00 00 00 00 00 00 00 00 20 00 29 5B 2C 16 63 30 40 52 37 5B 6D 50 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 2F F7';

const cases: Array<() => void> = [];

// 1. Request builders byte-exact to the captured FM9 requests.
cases.push(() => {
  for (const [name, eff, pid, expected] of [
    ['reverb', 66, 10, REQ_REVERB],
    ['amp', 58, 10, REQ_AMP],
    ['drive', 118, 0, REQ_DRIVE],
  ] as const) {
    const got = buildRequestCurrentTypeName(eff, pid, FM9);
    assert(got.length === 23, `${name} type-name request must be 23 bytes, got ${got.length}`);
    assert(
      hexStr(got) === hexStr(parseHex(expected)),
      `${name} type-name request mismatch:\n  exp ${expected}\n  got ${hexStr(got)}`,
    );
  }
});

// 2. parseGetParameterResponse decodes the captured sub=0x1F replies to real names.
cases.push(() => {
  for (const [eff, pid, expected, frame] of [
    [66, 10, 'Small Room', REPLY_REVERB],
    [58, 10, '59 Bassguy Bright', REPLY_AMP],
    [118, 0, 'Rat Distortion', REPLY_DRIVE],
  ] as const) {
    const bytes = parseHex(frame);
    assert(isGetParameterResponse(bytes, FM9), `sub=0x1F reply (eff ${eff}) should be a GET response`);
    const got = parseGetParameterResponse(bytes, FM9);
    assert(got.effectId === eff, `eff mismatch: exp ${eff} got ${got.effectId}`);
    assert(got.paramId === pid, `pid mismatch: exp ${pid} got ${got.paramId}`);
    assert(
      got.displayString === expected,
      `name mismatch for eff ${eff}: exp "${expected}" got "${got.displayString}"`,
    );
  }
});

// 3. sub=0x09 GET on a TYPE param carries the name (NOT value 0) — the fixed misparse.
cases.push(() => {
  const bytes = parseHex(REPLY_SUB09_REVERB);
  assert(isGetParameterResponse(bytes, FM9), 'sub=0x09 type GET should be a GET response');
  const got = parseGetParameterResponse(bytes, FM9);
  assert(got.effectId === 66 && got.paramId === 10, 'sub=0x09 eff/pid');
  assert(got.displayString === 'Small Room', `sub=0x09 name: got "${got.displayString}"`);
});

// 4. parseGen3SetValueEcho surfaces the type name via displayName (writer echo path).
cases.push(() => {
  const echo = parseGen3SetValueEcho(parseHex(REPLY_SUB09_REVERB));
  assert(echo.effectId === 66 && echo.paramId === 10, 'echo eff/pid');
  assert(echo.normalizedValue === 0, `echo float field is zero for a type param, got ${echo.normalizedValue}`);
  assert(echo.displayName === 'Small Room', `echo displayName: got "${echo.displayName}"`);
  // A continuous reply with no display string leaves displayName undefined.
  const reverb1f = parseGen3SetValueEcho(parseHex(REPLY_REVERB));
  assert(reverb1f.displayName === 'Small Room', 'sub=0x1F reply also exposes displayName');
});

export function runGen3TypeNameTests(): void {
  for (const c of cases) c();
}
export const GEN3_TYPENAME_CASE_COUNT = cases.length;
