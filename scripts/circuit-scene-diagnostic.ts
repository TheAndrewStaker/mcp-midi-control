/**
 * circuit-scene-diagnostic — (re)build the SCENE regression fixture on the card.
 *
 * ## Why this exists
 *
 * From 2026-09-03 to 2026-09-12 this project carried a wrong diagnosis: that a writer-authored SCENES
 * layout "does not play on load", because the scenes path clears the active `0x2c4` chain table to
 * `[0,0]`. It was filed as BK-CIRCUIT-SCENES-ON-LOAD, written into `writer.ts` as a KNOWN DEFECT
 * comment, and it caused one song to be converted to a plain chain to work around it.
 *
 * It was wrong, and the reason it survived nine days is that every test of it ran on a REAL SONG.
 * Real songs are terrible diagnostics: that song's only audible track was a MicroFreak on a
 * separate device, its internal levels were all stored at 0, its scene 1 is a 2-bar pickup fill that
 * legitimately sounds like starting mid-phrase, and the "select a scene" instruction actually REBUILDS
 * the chain (hold-a-pad-then-press-another is the device's chain-building gesture, manual p.83). Four
 * confounds stacked on one question.
 *
 * This fixture removes all four. It is a throwaway project whose only job is to answer "which scene is
 * playing right now?" out loud:
 *
 *   Scene 1 = 1 KICK     Scene 2 = 2 SNARES     Scene 3 = 3 HATS     Scene 4 = 4 RIDES
 *
 * You identify the scene by COUNTING. Internal drums are stored UP (100) and the synths muted, so no
 * external gear is in the signal path. Four scenes, four patterns, one scene per pattern, authored
 * through the ordinary `scene_plan` path — so what it proves, it proves about OUR WRITER, not just
 * about the device.
 *
 * The 2026-09-12 owner run: loaded cold, pressed Play, touched nothing → "they cycle 1,2,3,4,1,2,3,4"
 * and "wrapped nicely". That killed the defect, un-blocked scene-based arrangement
 * (BK-SCENE-SECTION-COLLAPSE), and corrected `writer.ts`.
 *
 * ## Keep it on the card
 *
 * It costs one project slot and answers a scene question by ear in ~30 seconds. When a scene behaviour
 * is in doubt, test THIS before touching a song — a diagnostic you can count beats a song you have to
 * interpret.
 *
 * Run: npx tsx scripts/circuit-scene-diagnostic.ts [--pack 3] [--slot 54] [--dry]
 */
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const SERVER = path.resolve(process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js');
const argVal = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const PACK = Number(argVal('--pack') ?? 3);
const SLOT = Number(argVal('--slot') ?? 54);
const DRY = process.argv.includes('--dry');
const NAME = 'SceneTest 1234';

const text = (r: unknown): string =>
  ((r as { content?: { type?: string; text?: string }[] })?.content ?? [])
    .filter((x) => x.type === 'text' && typeof x.text === 'string')
    .map((x) => x.text!)
    .join('\n');

/**
 * One scene per section, each a DIFFERENT voice at a DIFFERENT hit count. Both axes vary on purpose:
 * the count alone survives a muddy monitor, and the timbre alone survives miscounting.
 */
const SECTIONS = [
  { name: 'One',   steps: 16, voices: { kick:       'x...............' } },
  { name: 'Two',   steps: 16, voices: { snare:      'x.......x.......' } },
  { name: 'Three', steps: 16, voices: { closed_hat: 'x.....x.....x...' } },
  { name: 'Four',  steps: 16, voices: { ride:       'x...x...x...x...' } },
];

async function main(): Promise<void> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER] });
  const client = new Client({ name: 'scene-diagnostic', version: '1' }, { capabilities: {} });
  await client.connect(transport);

  // Read-before-write, per the safe-edit contract: this fixture is disposable, the slot it lands in
  // is not. Only an EMPTY slot or a previous copy of this same fixture is a legal target.
  const pre = await client.callTool({ name: 'get_preset', arguments: { port: 'circuit', pack: PACK, location: SLOT } });
  const prej = JSON.parse(text(pre)) as { name?: string };
  const occupant = prej.name ?? '';
  const empty = /^\(empty Project/.test(occupant);
  if (!empty && occupant !== NAME) {
    console.error(`REFUSING: Pack ${PACK} Project ${SLOT} holds "${occupant}".`);
    console.error(`Pick a free slot with --slot, or delete that project first if you meant to replace it.`);
    await client.close();
    process.exit(1);
  }
  console.log(`Pack ${PACK} Project ${SLOT}: ${empty ? 'EMPTY' : `already "${occupant}"`} — writable`);

  const res = await client.callTool({
    name: 'apply_pattern',
    arguments: {
      port: 'circuit', mode: 'ncs_upload', pack: PACK, ncs_slot: SLOT,
      ncs_template: 'samples/circuit-tracks/blank_slot20.ncs',
      confirm_overwrite: true, backup_first: false, dry_run: DRY,
      project_name: NAME, bpm: 100, colour: 'Pink',
      // Drums UP is the whole point: the fixture must sound with nothing else connected.
      mixer_levels: { drum1: 100, drum2: 100, drum3: 100, drum4: 100, synth1: 0, synth2: 0 },
      condense_drums: true,
      arrangement: {
        sections: SECTIONS,
        scene_plan: [['One'], ['Two'], ['Three'], ['Four']],
      },
    },
  });
  console.log(text(res).slice(0, 900));

  console.log(`\nTEST: load Pack ${PACK} Project ${SLOT}, press Play, touch nothing.`);
  console.log('  1 kick → 2 snares → 3 hats → 4 rides → wrap  = scene chains auto-advance on a cold load.');
  console.log('  1 kick forever                               = they do not; the stored chain is being ignored.');
  console.log('  Single-TAP a scene pad to SELECT one. Do NOT hold one pad and press another —');
  console.log('  that is the chain-BUILDING gesture and it rewrites what you are trying to measure.');
  await client.close();
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
