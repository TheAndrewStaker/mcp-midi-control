/**
 * VP4 scene-query probe (P0 ask, read-only, zero capture tooling).
 *
 * See packages/fractal-midi/docs/capture-guides/captures-vp4.md "P0: fn=0x0C
 * scene-query probe": the zero-cost, highest-value-per-minute ask for the
 * VP4. The gen-3 family documents a read-only SCENE query:
 *
 *   F0 00 01 74 14 0C 7F 12 F7   (cs = XOR(F0..7F) & 0x7F = 0x12)
 *
 * It has NO write side-effect (the `7F` byte is the documented QUERY
 * sentinel, not a scene number). If the VP4 answers it (and, in a LATER,
 * separately-consented step, also accepts the SET form), `switch_scene`
 * ships on the VP4 without needing the pid13 scene-value decode at all.
 * One frame, possibly a whole capability.
 *
 * The VP4 is a MIDI-class USB device (NOT the FM3's USB-CDC serial special
 * case; see CLAUDE.md "serialport for the FM3 only"), so this probe uses
 * the ordinary gen-3 MIDI connector (`connectVP4`), the same transport as
 * the other gen-3 family probes.
 *
 * THIS SCRIPT ONLY SENDS THE READ-ONLY QUERY FORM. It never sends the SET
 * form (`F0 00 01 74 14 0C <scene 0..7> <cks> F7`), which is a real write
 * and needs a separate, explicit, consented follow-up step; this probe
 * prints that follow-up frame as guidance text only, it does not send it.
 *
 * Usage:
 *   npx tsx scripts/probe-vp4-scene-query.ts [output.json]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  connectVP4,
  toHex,
  type MidiConnection,
} from '@mcp-midi-control/fractal-gen3/midi.js';
import {
  buildGetScene,
  buildSetScene,
  isSetGetSceneResponse,
  parseSceneResponse,
} from 'fractal-midi/gen3/axe-fx-iii';
import { guardAgainstRunningEditors } from './_lib/editor-guard.js';

const VP4_MODEL_ID = 0x14;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const outArg = process.argv[2] ?? 'vp4-scene-query-probe-output.json';
const outPath = path.isAbsolute(outArg) ? outArg : path.resolve(process.cwd(), outArg);

async function main(): Promise<void> {
  guardAgainstRunningEditors();
  console.error('VP4 scene-query probe (READ-ONLY: sends only the fn=0x0C QUERY form, never a SET)');

  let conn: MidiConnection;
  try {
    conn = connectVP4();
  } catch (err) {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (!conn.hasInput) {
    console.error('\nFound a VP4 output port but no input port; the probe needs to read replies.');
    console.error('Unplug/replug the USB cable and try again.');
    conn.close();
    process.exit(1);
  }

  const inbound: number[][] = [];
  conn.onMessage((bytes) => { if (bytes[0] === 0xf0) inbound.push(bytes); });

  async function sendAndCollect(bytes: number[], windowMs: number): Promise<number[][]> {
    const startLen = inbound.length;
    conn.send(bytes);
    await sleep(windowMs);
    return inbound.slice(startLen);
  }

  const outDir = path.join('samples', 'captured', 'vp4-scene-query');
  mkdirSync(outDir, { recursive: true });

  const req = buildGetScene(VP4_MODEL_ID);
  console.error(`\n→ Sending scene QUERY: ${toHex(req)}`);
  console.error('  (documented shape: F0 00 01 74 14 0C 7F 12 F7; no write side-effect)');

  const frames = await sendAndCollect(req, 800);

  let verdict: string;
  let parsedScene: number | undefined;
  if (frames.length === 0) {
    verdict =
      'NO RESPONSE. The VP4 either does not answer fn=0x0C over its 3rd-party MIDI surface, ' +
      'or needs a different trigger. This is still useful data: it means switch_scene needs ' +
      'the pid13 value-mapping decode after all.';
  } else {
    const reply = frames[0];
    console.error(`  ← ${toHex(reply)}`);
    if (isSetGetSceneResponse(reply, VP4_MODEL_ID)) {
      try {
        const parsed = parseSceneResponse(reply, VP4_MODEL_ID);
        parsedScene = parsed.scene;
        verdict =
          `VP4 ANSWERED with scene=${parsed.scene} (0-indexed). This CONFIRMS the fn=0x0C query ` +
          `works on VP4 hardware. Next step (SEPARATE, CONSENTED session, NOT run by this probe): ` +
          `try the SET form to confirm switch_scene works end-to-end.`;
      } catch (err) {
        verdict = `VP4 replied (${frames.length} frame(s)) but the reply didn't parse as a scene response: ${err instanceof Error ? err.message : String(err)}. Raw bytes captured for offline decode.`;
      }
    } else {
      verdict = `VP4 replied (${frames.length} frame(s)) but not shaped like a fn=0x0C scene response. Raw bytes captured for offline decode; could still be useful (e.g. a 0x64 MULTIPURPOSE_RESPONSE naming a result code).`;
    }
  }
  console.error(`\nVERDICT: ${verdict}`);

  console.error('\n── Follow-up (NOT sent by this probe; requires a separate, explicit, consented step) ──');
  console.error('If the query above was answered, the natural next test is the SET form for each');
  console.error('scene 1..4 (VP4 is AM4-shape: 4 scenes), one at a time, confirming on the front panel:');
  for (let scene = 0; scene < 4; scene++) {
    const setFrame = buildSetScene(scene, VP4_MODEL_ID);
    console.error(`  scene ${scene + 1}: ${toHex(setFrame)}`);
  }
  console.error('This probe does NOT send any of the lines above: a scene switch is a real, audible');
  console.error('write and needs its own explicit go-ahead, not a bundled probe side-effect.');

  const report = {
    probe: 'probe-vp4-scene-query',
    device: 'VP4',
    modelByte: VP4_MODEL_ID,
    capturedAt: new Date().toISOString(),
    note: 'READ-ONLY. Only the fn=0x0C QUERY form (7F sentinel) was sent. The SET form is printed as guidance only, never transmitted.',
    request: toHex(req),
    responseCount: frames.length,
    responses: frames.map((f) => toHex(f)),
    parsedScene,
    verdict,
    followUpSetFrames: Array.from({ length: 4 }, (_, scene) => toHex(buildSetScene(scene, VP4_MODEL_ID))),
  };
  writeFileSync(outPath, JSON.stringify(report, undefined, 2));
  if (frames.length) writeFileSync(path.join(outDir, 'vp4-scene-query-reply.syx'), Buffer.from(frames[0]));

  conn.close();
  console.error(`\n✓ Wrote ${outPath}`);
  console.error('Please send/email this JSON file back. Thank you!');
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nProbe failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
