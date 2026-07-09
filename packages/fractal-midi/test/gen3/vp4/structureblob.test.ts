/**
 * VP4 eid206 pid0 tc=0x1f structure-blob goldens.
 *
 * Two REAL response frames embedded verbatim from the community captures
 * (Kevin Iudicello, fw 4.03) — different presets, different sessions:
 *   - v2 (`samples/captured/decoded/vp4-403-v2/frames.json`, 2026-06-09 edit
 *     session): the post-move blob, preset "Virtual Pedalboard", chain
 *     [70, empty, 78, 66] = the annotated Delay-move cascade [DLY,·,CHO,RVB].
 *   - v1 (`samples/captured/decoded/vp4-403/frames.json`, 2026-06-08 read
 *     poll): preset "Main Bank", chain [70,118,90,94] = DLY/DRV/PHR/WAH,
 *     current scene 3 (the annotated scene 1→3 switch).
 *
 * Failure means the decode drifted from the real device's wire bytes.
 * Cookbook: [[vp4-eid206-structure-blob]] (this file is its golden).
 */
import {
  buildVp4GetStructureBlob,
  parseVp4StructureBlob,
} from '../../../src/gen3/vp4/index.js';

function hex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}
function fromHex(s: string): number[] {
  const clean = s.replace(/\s/g, '');
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) out.push(Number.parseInt(clean.slice(i, i + 2), 16));
  return out;
}

// The verbatim VP4-Edit query (202 occurrences across the two captures).
const REQUEST_GOLDEN = 'f000017414014e0100001f000000000040f7';

// v2 post-move response frame (238 bytes, checksum-valid).
const V2_POST_MOVE_FRAME =
  'f000017414014e0100001f0000004001300000000004000000000000000225481c10' +
  '4a664b496875305b04050315486136184d760b494820100804020100402010080402' +
  '0100003410106d460b4d666931480865410040201008040201004020100804020100' +
  '40201008000423495276324b0404231558613c480402010040201008040201004020' +
  '100804020100400022192d460b64582029192e662b49442010080402010040201008' +
  '0402010040201008040002395e20221c4d1733144020100804020100402010080402' +
  '01004020100804020100402000114000000000000000096000000042000000005df7';

// v1 response frame (238 bytes, checksum-valid; preset "Main Bank", scene 3).
const V1_FRAME =
  'f000017414014e0100001f0000004001300000000004000000004000000218480710' +
  '49560b255c2021182d66590040201008040201004020100804020100402010080402' +
  '01000052305d64020100402010080402010040201008040201004020100804020100' +
  '4020100800053b05502022192d460b64402010080402010040201008040201004020' +
  '1008040201004000281a0c171b15642022192d460b64402010080402010040201008' +
  '0402010040201008040002114a6c305e240201004020100804020100402010080402' +
  '0100402010080402010040200011400000016c0000000b200000005e0000000037f7';

export const VP4_STRUCTBLOB_CASE_COUNT = 22;

export function runVp4StructureBlobTests(): void {
  const failed: string[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    if (!ok) failed.push(`${label}${detail ? ` — ${detail}` : ''}`);
  };

  // 1. Request frame byte-exactness (checksum computed, not hardcoded).
  const req = buildVp4GetStructureBlob();
  check('request frame byte-exact vs capture', hex(req) === REQUEST_GOLDEN, hex(req));

  // 2. v2 post-move blob — every decoded field vs the mining-report values.
  const v2 = parseVp4StructureBlob(fromHex(V2_POST_MOVE_FRAME));
  check('v2 statusFlag 0x60 (post first structural edit)', v2.statusFlag === 0x60, String(v2.statusFlag));
  check('v2 currentScene 0 (0-based)', v2.currentScene === 0, String(v2.currentScene));
  check('v2 currentSceneDisplay 1', v2.currentSceneDisplay === 1, String(v2.currentSceneDisplay));
  check('v2 presetName', v2.presetName === 'Virtual Pedalboard', JSON.stringify(v2.presetName));
  const v2Scenes = ['4 Classic FX', 'Drive, Delay', 'Delay, Reverb', 'No Drive'];
  v2Scenes.forEach((n, i) =>
    check(`v2 scene ${i + 1} name`, v2.sceneNames[i] === n, JSON.stringify(v2.sceneNames[i])),
  );
  check('v2 chain slot 1 = Delay (70)', v2.chain[0]?.effectId === 70 && v2.chain[0]?.name === 'Delay',
    JSON.stringify(v2.chain[0]));
  check('v2 chain slot 2 = empty (null)', v2.chain[1] === null, JSON.stringify(v2.chain[1]));
  check('v2 chain slot 3 = Chorus (78)', v2.chain[2]?.effectId === 78 && v2.chain[2]?.name === 'Chorus',
    JSON.stringify(v2.chain[2]));
  check('v2 chain slot 4 = Reverb (66)', v2.chain[3]?.effectId === 66 && v2.chain[3]?.name === 'Reverb',
    JSON.stringify(v2.chain[3]));

  // 3. v1 blob (second preset / second session).
  const v1 = parseVp4StructureBlob(fromHex(V1_FRAME));
  check('v1 statusFlag 0x60', v1.statusFlag === 0x60, String(v1.statusFlag));
  check('v1 currentScene 2 (scene 3, the annotated 1→3 switch)', v1.currentScene === 2 && v1.currentSceneDisplay === 3,
    `${v1.currentScene}/${v1.currentSceneDisplay}`);
  check('v1 presetName', v1.presetName === 'Main Bank', JSON.stringify(v1.presetName));
  const v1Scenes = ['Raw', 'Wah Delay', 'Phaser Delay', 'Delay'];
  v1Scenes.forEach((n, i) =>
    check(`v1 scene ${i + 1} name`, v1.sceneNames[i] === n, JSON.stringify(v1.sceneNames[i])),
  );
  const v1Chain = [
    [70, 'Delay'], [118, 'Drive'], [90, 'Phaser'], [94, 'Wah'],
  ] as const;
  check(
    'v1 chain = DLY/DRV/PHR/WAH',
    v1.chain.every((s, i) => s?.effectId === v1Chain[i][0] && s?.name === v1Chain[i][1]),
    JSON.stringify(v1.chain),
  );

  // 4. Malformed frames throw.
  const throws = (label: string, frame: number[]) => {
    let threw = false;
    try { parseVp4StructureBlob(frame); } catch { threw = true; }
    check(`${label} throws`, threw);
  };
  throws('short/garbage frame', [0xf0, 0x00, 0x01, 0x74, 0x14, 0x01, 0xf7]);
  throws('truncated blob', fromHex(V2_POST_MOVE_FRAME).slice(0, 100));
  const badCks = fromHex(V2_POST_MOVE_FRAME);
  badCks[badCks.length - 2] ^= 0x01;
  throws('checksum-corrupted frame', badCks);
  const wrongReg = fromHex(V2_POST_MOVE_FRAME);
  wrongReg[8] = 0x01; // pid 1, not the structure register
  throws('wrong register (pid≠0)', wrongReg);

  if (failed.length > 0) {
    throw new Error(`vp4/structureblob failures:\n${failed.join('\n')}`);
  }
}
