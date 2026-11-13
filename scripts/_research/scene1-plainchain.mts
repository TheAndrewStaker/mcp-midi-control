/**
 * scene1-plainchain.mts - OFFLINE. Give a scene-chained project a plain chain that matches SCENE 1,
 * so it plays on load instead of looping its first pattern forever.
 *
 * THE DEFECT. Seven projects on this card store `[0,0]` in the ACTIVE chain table (0x2c4) on every
 * track while carrying a real 4-scene arrangement. `[0,0]` means "play pattern 1, forever". On load
 * and play the device follows the ACTIVE table and does NOT pick up a stored scene chain by itself -
 * heard on hardware 2026-09-03 (P1:56) and recorded at the top of `ncs/sceneChain.ts`. So
 * these load playing one bar, and the two copies of one Bridge project load SILENT on synth2, because
 * their synth2 content starts at pattern 2 while pattern 1 is the drums-only bar.
 *
 * THE FIX, and why this particular one. The same decode records what the device does for itself:
 * its own save image keeps the active table EQUAL to the selected scene. So the faithful active
 * table for a project parked on Scene 1 is Scene 1's own per-track ranges - not a span invented to
 * cover all the content. Copying Scene 1 out of the scene stack into the active table therefore
 * reproduces a device-authentic save rather than a guess, and it preserves the arrangement: the
 * scene pads still switch sections, the scene chain is untouched, and the project simply starts
 * where its author intended.
 *
 * Note what this deliberately does NOT do: it does not make every track audible on load. On
 * That Bridge project's Scene 1 is `synth2[0,0]` over an empty pattern 1, so synth2 stays silent until
 * Scene 2 - which is the arrangement, not a fault. Papering over that with a full-span chain would
 * play the section in the wrong order.
 *
 * Usage: npx tsx scripts/_research/scene1-plainchain.mts <in.ncs> <out.ncs>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { NCS_FILE_SIZE, checkNcsStructure, getProjectName, type NoteTrack } from '../../packages/circuit-tracks/src/ncs/format.js';
import { getSceneNoteChain, getSceneDrumChain, getSceneChainEnd } from '../../packages/circuit-tracks/src/ncs/sceneChain.js';

const CHAIN = 0x2c4;
const NOTE_SLOT: Record<NoteTrack, number> = { synth1: 0, synth2: 1, midi1: 2, midi2: 3 };
const DRUM_SLOT_BASE = 4;

const [inp, outp] = process.argv.slice(2);
if (!inp || !outp) throw new Error('usage: scene1-plainchain.mts <in.ncs> <out.ncs>');
const buf = new Uint8Array(readFileSync(inp));
if (buf.length !== NCS_FILE_SIZE) throw new Error(`bad .ncs: ${buf.length} bytes`);

const name = getProjectName(buf);
const end = getSceneChainEnd(buf);
if (end === undefined) throw new Error(`${name}: no scene chain - this tool is only for scene-chained projects`);

const changed: string[] = [];
for (const t of ['synth1', 'synth2', 'midi1', 'midi2'] as NoteTrack[]) {
  const s1 = getSceneNoteChain(buf, 0, t);
  if (s1 === undefined) continue;                       // Scene 1 not defined for this track
  const off = CHAIN + NOTE_SLOT[t] * 4;
  const was = `[${buf[off]},${buf[off + 1]}]`;
  buf[off] = s1.start; buf[off + 1] = s1.end;
  if (was !== `[${s1.start},${s1.end}]`) changed.push(`${t} ${was} -> [${s1.start},${s1.end}]`);
}
for (let dt = 0; dt < 4; dt++) {
  const s1 = getSceneDrumChain(buf, 0, dt);
  if (s1 === undefined) continue;
  const off = CHAIN + (DRUM_SLOT_BASE + dt) * 4;
  const was = `[${buf[off]},${buf[off + 1]}]`;
  buf[off] = s1.start; buf[off + 1] = s1.end;
  if (was !== `[${s1.start},${s1.end}]` && dt === 0) changed.push(`drums ${was} -> [${s1.start},${s1.end}]`);
}

const chk = checkNcsStructure(buf);
if (!chk.ok) throw new Error(`${name}: checkNcsStructure failed: ${JSON.stringify(chk)}`);
mkdirSync(dirname(outp), { recursive: true });
writeFileSync(outp, buf);
console.log(`${name.padEnd(20)} sceneChainEnd=${end}  ${changed.join('  |  ') || '(already matched Scene 1)'}`);
