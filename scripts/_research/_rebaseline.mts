/**
 * Prove the ONLY behavioural change under the two whole-buffer sha256 goldens is the three
 * mis-decoded drum-record bytes. Method: take the CURRENT (corrected) output, re-apply the OLD
 * writes by hand, and check it reproduces the OLD golden hash exactly. If it does, the new hash is
 * a safe re-baseline rather than a photograph of whatever the code now does.
 */
import { createHash } from 'node:crypto';
import { NCS_FILE_SIZE } from '../../packages/circuit-tracks/src/ncs/format.js';
import { authorArrangementIntoProject } from '../../packages/circuit-tracks/src/descriptor/writer.js';
import { CIRCUIT_TRACKS_DESCRIPTOR } from '../../packages/circuit-tracks/src/descriptor.js';
import { charGridToSteps, compileToPlan } from '../../packages/core/src/protocol-generic/patterns/index.js';
import type { NeutralPattern, NeutralStep } from '../../packages/core/src/protocol-generic/patterns/index.js';
import type { RealizePlan } from '../../packages/core/src/protocol-generic/types.js';

const caps = CIRCUIT_TRACKS_DESCRIPTOR.capabilities;
const sec = (name: string, kick: string, bass?: string): { name: string; plan: RealizePlan } => {
  const voices: Record<string, { steps: NeutralStep[] }> = { kick: { steps: charGridToSteps(kick) } };
  if (bass) voices.bass = { steps: charGridToSteps(bass).map((s, i) => (s.on ? { ...s, note: 48 + (i % 5) } : s)) };
  const p: NeutralPattern = { name, steps: kick.length, bars: 1, voices };
  return { name, plan: compileToPlan(p, caps, { bpm: 120, mode: 'ncs_upload', repeat: 1, upload: { slot: 0 } }) };
};
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

// ---- golden 1: CHAIN arrangement ----
const OLD1 = 'ef566459390eb3c5131d58fe159277da847ca41c5a61d9ff6f9a672165e99081';
const b1 = new Uint8Array(NCS_FILE_SIZE);
authorArrangementIntoProject(b1, [
  sec('verse', 'x...x...', 'x.x.x.x.'), sec('chorus', 'xx..xx..', '.x...x..'), sec('bridge', 'x.x.x.x.'),
], [0, 1, 2, 1]);
const new1 = sha(b1);
const r1 = Uint8Array.from(b1); r1[0x26fc7] = 0x0c;          // the removed setDrumChain "enable tail"
console.log('GOLDEN 1 (chain)');
console.log('  new hash          ', new1);
console.log('  reconstructed-old ', sha(r1));
console.log('  matches OLD golden', sha(r1) === OLD1 ? 'YES -> only 0x26fc7 changed' : 'NO  -> something else moved too');

// ---- golden 2: GREEDY-SCENES ----
const OLD2 = '9a6e06ef568b2baf8433d0dc7e05afd097891c01873aa0dd09cde99a184a608c';
const greedy = () => ['s1', 's2', 's3', 's4', 's5'].map((n, i) =>
  sec(n, ('x...'.repeat(2)).slice(0, 8 - i) + '.'.repeat(i), i % 2 ? 'x...x...' : undefined));
const b2 = new Uint8Array(NCS_FILE_SIZE);
authorArrangementIntoProject(b2, greedy(), [0, 1, 2, 3, 4, 0, 1, 2, 3, 4]);
const new2 = sha(b2);
for (const label of ['scene only', 'scene + drumchain tail'] as const) {
  const r2 = Uint8Array.from(b2);
  r2[0x26fbc] = 0x00; r2[0x26fd2] = 0x07;                    // the removed setSceneChain "state bytes"
  if (label === 'scene + drumchain tail') r2[0x26fc7] = 0x0c;
  if (label === 'scene only') {
    console.log('GOLDEN 2 (greedy scenes)');
    console.log('  new hash          ', new2);
  }
  console.log(`  reconstructed-old (${label}) matches:`, sha(r2) === OLD2 ? 'YES' : 'no');
}
// exhaustive: which bytes must change to reach OLD2?
console.log('\ncurrent values at the three suspect offsets (new build):',
  `0x26fbc=${b2[0x26fbc]} 0x26fc7=${b2[0x26fc7]} 0x26fd2=${b2[0x26fd2]}`);
