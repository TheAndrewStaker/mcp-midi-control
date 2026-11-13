// Golden + invariant checks for the Akai MPC descriptor.
//
// The Program Change numbering golden is the bench-proven fact (PC N-1 selects
// sequence N on a One G2, MPC OS 3.9), not something this encoder invented.
//
// Run: npx tsx scripts/verify-akai-mpc.ts

import { MPC_ONE_G2_DESCRIPTOR, resolveChannel } from '@mcp-midi-control/akai-mpc/descriptor.js';
import { MPC_ONE_G2 } from '@mcp-midi-control/akai-mpc/devices/mpcOneG2.js';
import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCardProject, isMpcCardRoot, listCardProjects, listMpcProjects, readCardProject, MPC_CARD_ROOT_ENV, resolveMpcCardRoot } from '@mcp-midi-control/akai-mpc/storage/card.js';
import { createLazyMidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import {
  drumProgram,
  dbToXpmVolume,
  xpmPadNotes,
  xpmVolumeToDb,
  XPM_UNITY_VOLUME,
  type XpmPad,
} from '@mcp-midi-control/akai-mpc/codec/drumProgram.js';
import { PAD_COLOUR, padColour, programPads, programPadsElement, type PadRole } from '@mcp-midi-control/akai-mpc/codec/padColour.js';
import { expansionXml, formatSha256Sums, parseSha256Sums } from '@mcp-midi-control/akai-mpc/codec/expansion.js';
import { gzipSync } from 'node:zlib';
import { parseXpj, sequenceTitle, summarizeXpj } from '@mcp-midi-control/akai-mpc/codec/project.js';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) {
    failures++;
    console.log(`FAIL: ${label}${detail ? `\n  ${detail}` : ''}`);
  }
}
const eq = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const d = MPC_ONE_G2_DESCRIPTOR;
const matches = (name: string): boolean => d.port_match.some((m) =>
  typeof m.pattern === 'string' ? name.toLowerCase().includes(m.pattern.toLowerCase()) : m.pattern.test(name));

// Port match: only the engine port, never the forwarded DIN jacks.
// Names as enumerated on a One G2: standalone, then Controller Mode.
check('matches the standalone sequencer output', matches('MPC One USB-C Out 1'));
check('matches the standalone sequencer input', matches('MPC One USB-C In 1'));
check('does not match the second USB pair', !matches('MPC One USB-C Out 2') && !matches('MPC One USB-C In 2'));
check('does not match the DAW port', !matches('MPC One USB-C DAW'));
check('matches the Public port', matches('MPC One Public'));
check('matches a numbered Public port', matches('MPC One G2 Public 1'));
check('the Public port marks Controller Mode, and is not the sequencer',
  MPC_ONE_G2.controller_mode_port.test('MPC One Public') && !MPC_ONE_G2.engine_ports.output.test('MPC One Public'));
check('does not match the forwarded DIN in', !matches('MPC One MIDI In 1'));
check('does not match the forwarded DIN out', !matches('MPC One MIDI Out A'));

// Program Change numbering: sequence N -> PC N-1, channel 1 by default.
delete process.env.MCP_MPC_CHANNEL;
check('sequence 1 -> C0 00', eq(d.writer.buildSwitchPreset!(1), [0xc0, 0x00]));
check('sequence 128 -> C0 7F', eq(d.writer.buildSwitchPreset!('128'), [0xc0, 0x7f]));
process.env.MCP_MPC_CHANNEL = '15';
check('channel env is honoured', eq(d.writer.buildSwitchPreset!(4), [0xce, 0x03]));
process.env.MCP_MPC_CHANNEL = '17';
check('out-of-range channel falls back', resolveChannel('MCP_MPC_CHANNEL', 1) === 1);
delete process.env.MCP_MPC_CHANNEL;

for (const bad of [0, 129, 'A01', 1.5]) {
  let threw = false;
  try {
    d.writer.buildSwitchPreset!(bad as number);
  } catch {
    threw = true;
  }
  check(`sequence ${String(bad)} refuses`, threw);
}

// switchPreset sends exactly the built frame and claims no readback.
const sent: number[][] = [];
const ctx = { conn: { send: (b: number[]) => sent.push([...b]) } } as unknown as DispatchCtx;
const res = await d.writer.switchPreset!(ctx, 3);
check('switchPreset sends one PC frame', sent.length === 1 && eq(sent[0], [0xc0, 0x02]));
check('receipt names the sequence', res.target === 'sequence 3');
check('receipt says there is no readback', /No readback/.test(res.info ?? ''));
check('receipt explains queued-while-playing', /queued/.test(res.info ?? ''));

// No parameter surface: reads and param writes refuse instead of guessing.
let refused = false;
try {
  await d.reader.getParam(ctx, 'amp', 'gain');
} catch (e) {
  refused = /no parameters over MIDI/.test((e as Error).message);
}
check('getParam refuses with the reason', refused);
refused = false;
try {
  d.writer.buildSetParam('amp', 'gain', 1);
} catch {
  refused = true;
}
check('buildSetParam refuses', refused);

// Capabilities stay honest.
const caps = d.capabilities;
check('tier is generic-only', caps.support_tier === 'generic-only');
check('no save over MIDI', caps.supports_save === false);
check('live_stream is the only realizer', eq(
  (caps.pattern_realizers ?? []).map((r) => r.length),
  ['live_stream'.length],
) && caps.pattern_realizers?.[0] === 'live_stream');
const vm = caps.voice_map as Record<string, { channel: number; note: number }>;
check('GM kick / snare / hat notes', vm.kick.note === 36 && vm.snare.note === 38 && vm.hat.note === 42);
check('drums default to channel 10', vm.kick.channel === 10);
check('preset is called a sequence', d.canonical_terms.preset === 'sequence');

// ── codec: the drum .xpm writer, byte-identical to the reference writer ──
//
// Each golden is the sha256 + length of the program the reference Python
// writer produced from the same spec (scripts/fixtures/akai-mpc). A drum
// program is 2.2 MB of XML, so the hash is committed, not the file.
const GOLDEN: Record<string, { sha256: string; bytes: number }> = {
  'velocity-basic': { sha256: '7ef655a8c1c7d8970c58414763a04378490664998db25ce6eb4646d6c1aea988', bytes: 2204991 },
  'cycle-notes-colours': { sha256: 'fc15765eef73c2ecf6ed123509d5bcb4153dd3708a9f063d28d3d6b3bf60d059', bytes: 2204959 },
  articulation: { sha256: 'a395b4c5a7b6430d9750b564cb565cb2cbb6252baa74100a1c8c994058f1c7f2', bytes: 2207628 },
};
interface SpecPad {
  layers?: Array<[string, number, [number, number], number?]>;
  note?: number; zone_play?: number; mute_group?: number; mono?: boolean; polyphony?: number;
  volume?: number; pan?: number; velocity_sensitivity?: number;
  articulation?: { type: number; speed?: number; dynamics?: number; stereo?: number; scaling?: number };
  role?: PadRole; colour?: number;
}
const specs = JSON.parse(readFileSync('scripts/fixtures/akai-mpc/drum-program-specs.json', 'utf8')) as {
  programs: Array<{ id: string; name: string; platform?: string; pads: Record<string, SpecPad> }>;
};
const sha = (text: string): { sha256: string; bytes: number } => {
  const buf = Buffer.from(text, 'utf8');
  return { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
};
const toPads = (pads: Record<string, SpecPad>): Map<number, XpmPad> => new Map(
  Object.entries(pads).map(([num, sp]) => [Number(num), {
    ...(sp.layers !== undefined
      ? { layers: sp.layers.map(([sample, frames, velocity, volume]) => ({ sample, frames, velocity, ...(volume !== undefined ? { volume } : {}) })) }
      : {}),
    ...(sp.note !== undefined ? { note: sp.note } : {}),
    ...(sp.zone_play !== undefined ? { zonePlay: sp.zone_play } : {}),
    ...(sp.mute_group !== undefined ? { muteGroup: sp.mute_group } : {}),
    ...(sp.mono !== undefined ? { mono: sp.mono } : {}),
    ...(sp.polyphony !== undefined ? { polyphony: sp.polyphony } : {}),
    ...(sp.volume !== undefined ? { volume: sp.volume } : {}),
    ...(sp.pan !== undefined ? { pan: sp.pan } : {}),
    ...(sp.velocity_sensitivity !== undefined ? { velocitySensitivity: sp.velocity_sensitivity } : {}),
    ...(sp.articulation !== undefined ? { articulation: sp.articulation } : {}),
    ...(sp.role !== undefined ? { role: sp.role } : {}),
    ...(sp.colour !== undefined ? { colour: sp.colour } : {}),
  } satisfies XpmPad]),
);
for (const prog of specs.programs) {
  const text = drumProgram(prog.name, toPads(prog.pads), prog.platform !== undefined ? { platform: prog.platform } : {});
  const got = sha(text);
  const want = GOLDEN[prog.id];
  check(`xpm "${prog.id}" is byte-identical to the reference writer`,
    want !== undefined && got.sha256 === want.sha256 && got.bytes === want.bytes,
    `got ${got.bytes} bytes ${got.sha256.slice(0, 12)}, want ${want?.bytes} ${want?.sha256.slice(0, 12)}`);
}
{
  const basic = specs.programs[0];
  const text = drumProgram(basic.name, toPads(basic.pads));
  check('xpm: all 128 instruments are written', (text.match(/<Instrument number="/g) ?? []).length === 128);
  check('xpm: 8 layers per instrument', (text.match(/<Layer number="/g) ?? []).length === 128 * 8);
  check('xpm: a sample name is XML-escaped', text.includes('<SampleName>TK_Tom &amp; Rim &lt;A&gt;</SampleName>'));
  check('xpm: SliceEnd is frames - 1', text.includes('<SliceEnd>22049</SliceEnd>'));
  check('xpm: pad 1 answers note 36 by default', /<PadNote number="1">\s*<Note>36<\/Note>/.test(text));
  check('xpm: a plain program carries the plain header', text.includes('<Application_Version>3.5.0.54</Application_Version>'));
  const art = specs.programs[2];
  check('xpm: an articulation switches to the 3.7 header',
    drumProgram(art.name, toPads(art.pads)).includes('<Application_Version>3.7.1.34</Application_Version>'));
}
{
  const threw = (fn: () => unknown, re: RegExp): boolean => {
    try { fn(); return false; } catch (e) { return re.test((e as Error).message); }
  };
  check('xpm: two pads on one note refuse',
    threw(() => drumProgram('x', new Map([[1, { note: 40 }], [2, { note: 40 }]])), /same MIDI note/));
  check('xpm: pad 129 refuses', threw(() => drumProgram('x', new Map([[129, {}]])), /out of range/));
  check('xpm: nine layers refuse',
    threw(() => drumProgram('x', new Map([[1, { layers: Array.from({ length: 9 }, () => ({ sample: 's', frames: 1 })) }]])), /9 layers/));
  const notes = xpmPadNotes(new Map([[1, { note: 37 }]]));
  check('notes: an unlisted pad whose default is taken moves to a free note', notes.get(1) === 37 && notes.get(2) === 0);
  check('notes: a pad whose default is free keeps it', notes.get(3) === 38 && notes.get(92) === 127);
  check('notes: all 128 pads end on distinct notes', new Set(notes.values()).size === 128);
}
check('colour: role table matches the factory scheme',
  padColour('kick') === 0xff0000 && padColour('clap') === 0xffff00 && padColour('808') === 0x00ff00 && padColour('hat_open') === 0x5f3300);
check('colour: an explicit colour wins over the role', padColour('kick', 0x123456) === 0x123456);
check('colour: no role is the unknown teal', padColour() === PAD_COLOUR.perc);
{
  const el = programPadsElement(programPads(new Map([[1, 0xff0000]])));
  check('colour: the element is escaped JSON with quotes as entities',
    el.startsWith('<ProgramPads-v2.10>{\n    &quot;ProgramPads-v2.10&quot;: {') && el.includes('&quot;value0&quot;: 16711680'));
}
check('fader: unity is 0 dB', Math.abs(xpmVolumeToDb(XPM_UNITY_VOLUME)) < 1e-9);
check('fader: +6 dB round-trips', Math.abs(xpmVolumeToDb(dbToXpmVolume(6)) - 6) < 1e-9);
check('fader: 1.0 is +6 dB (the 40 log10 law)', Math.abs(xpmVolumeToDb(1.0) - 6.0) < 0.01, String(xpmVolumeToDb(1.0)));
{
  const exp = sha(expansionXml({ identifier: 'com.example.test & co', title: 'Test <Kit>', manufacturer: 'Maker', description: 'A & B', img: 'cover.jpg' }));
  check('expansion: Expansion.xml is byte-identical to the reference writer',
    exp.sha256 === '352cd955a6596db7772bab418c73615adda365f76ae1924b75bc84c33c4dcb5a' && exp.bytes === 407, `${exp.bytes} ${exp.sha256.slice(0, 12)}`);
  const h = 'A'.repeat(64);
  const sums = parseSha256Sums(`${h}  Kit/One.xpm\r\n\n${h} *Kit/Two.wav\n`);
  check('sums: both sha256sum layouts parse, hashes lowercased',
    sums.get('Kit/One.xpm') === h.toLowerCase() && sums.get('Kit/Two.wav') === h.toLowerCase() && sums.size === 2);
  check('sums: format round-trips', parseSha256Sums(formatSha256Sums(sums)).get('Kit/Two.wav') === h.toLowerCase());
  let bad = false;
  try { parseSha256Sums('nope'); } catch (e) { bad = /line 1/.test((e as Error).message); }
  check('sums: a malformed line throws, naming it', bad);
}

// ── codec: the .xpj project reader ──
//
// The container is built here in the shape read off real projects (5-line
// header, then JSON; sequences as { key, value }, playlist items keyed
// "item.sequenceIndex" / "item.repeats"), with fills interleaved the way a
// real song project has them.
{
  const body = {
    data: {
      masterTempo: 108,
      currentSequence: 0,
      sequences: [
        { key: 2, value: { name: '02b Verse 1 Fill', bpm: 108, lengthBars: 1 } },
        { key: 0, value: { name: '01 Intro', bpm: 108, lengthBars: 8 } },
        { key: 1, value: { name: '02 Verse 1', bpm: 108, lengthBars: 16 } },
        { key: 3, value: { name: '03 Heavy Part', bpm: 108, lengthBars: 4 } },
        { key: 4, value: { name: 'c01 Intro', bpm: 108 } },
      ],
      songs: [
        { name: 'Test', items: [{ 'item.sequenceIndex': 0, 'item.repeats': 1 }, { 'item.sequenceIndex': 1, 'item.repeats': 2 }, { 'item.sequenceIndex': 3, 'item.repeats': 1 }] },
        { name: '', items: [] },
      ],
      tracks: [{ name: 'Drums' }, { name: '' }, { name: 'Bass' }],
    },
  };
  const pack = (header: string[], json: string, eol = '\n'): Buffer => gzipSync(Buffer.from(`${header.join(eol)}${eol}${json}`, 'utf8'));
  const header = ['ACVS', '3.7.0.56', 'SerialisableProjectData', 'json', 'Linux'];
  const sum = summarizeXpj(parseXpj(pack(header, JSON.stringify(body))));
  check('xpj: header version and platform are read', sum.appVersion === '3.7.0.56' && sum.platform === 'Linux');
  check('xpj: sequences come back in index order', sum.sequences.map((q) => q.index).join() === '0,1,2,3,4');
  check('xpj: sequence number is index + 1 (Heavy Part is 4, not 3)',
    sum.sequences.find((q) => q.name === '03 Heavy Part')?.number === 4);
  check('xpj: bpm and length are carried, and left out when absent',
    sum.sequences[1].bpm === 108 && sum.sequences[1].lengthBars === 16 && sum.sequences[4].lengthBars === undefined);
  check('xpj: the playlist keeps order and repeats',
    sum.songs[0].items.map((i) => `${i.sequenceIndex}x${i.repeats}`).join(' ') === '0x1 1x2 3x1' && sum.songs[1].items.length === 0);
  check('xpj: unnamed tracks are dropped', sum.tracks.join() === 'Drums,Bass');
  check('xpj: master tempo and opening sequence are read', sum.masterTempo === 108 && sum.currentSequence === 0);
  check('xpj: CRLF header lines parse the same',
    summarizeXpj(parseXpj(pack(header, JSON.stringify(body), '\r\n'))).sequences.length === 5);
  check('title: an ordering prefix is stripped',
    sequenceTitle('06 Heavy Part') === 'Heavy Part' && sequenceTitle('02b Verse 1 Fill') === 'Verse 1 Fill' && sequenceTitle('c01 Intro') === 'Intro');
  check('title: a name with no prefix is unchanged', sequenceTitle('Verse 2') === 'Verse 2' && sequenceTitle('808 Break') === 'Break');
  const refuses = (bytes: Uint8Array, re: RegExp): boolean => {
    try { parseXpj(bytes); return false; } catch (e) { return re.test((e as Error).message); }
  };
  check('xpj: a file that is not gzip refuses', refuses(Buffer.from('plain text'), /not gzip/));
  check('xpj: a wrong header refuses, quoting it', refuses(pack(['RIFF', '1', 'x', 'json', 'Linux'], '{}'), /header is/));
  check('xpj: a body that is not JSON refuses', refuses(pack(header, 'nope'), /not JSON/));
  check('xpj: a document with no data refuses', refuses(pack(header, '{"other":1}'), /no "data"/));
}

// ── the card surface: project list + one project's sequences, read-only ──
//
// A throwaway folder laid out like the card: Projects/ and Expansions/ at the
// top, song projects one group folder down, each with its sample folder
// beside it, plus a loose project directly under Projects/.
{
  const card = mkdtempSync(join(tmpdir(), 'mpc-card-'));
  const xpj = (names: string[]): Buffer => gzipSync(Buffer.from(
    ['ACVS', '3.9.1.1', 'SerialisableProjectData', 'json', 'Linux', JSON.stringify({
      data: {
        masterTempo: 96,
        sequences: names.map((name, key) => ({ key, value: { name, bpm: 96, lengthBars: 8 } })),
        songs: [{ name: 'Night Drive', items: [{ 'item.sequenceIndex': 0, 'item.repeats': 1 }, { 'item.sequenceIndex': 3, 'item.repeats': 2 }] }],
        tracks: [],
      },
    })].join('\n'), 'utf8'));
  const put = (rel: string, bytes: Buffer): void => {
    mkdirSync(join(card, rel, '..'), { recursive: true });
    writeFileSync(join(card, rel), bytes);
  };
  const prior = process.env[MPC_CARD_ROOT_ENV];
  try {
    mkdirSync(join(card, 'Expansions'), { recursive: true });
    put('Projects/Songs/Night Drive (Nobody)/Night Drive.xpj', xpj(['01 Intro', '02 Verse', '02b Verse Fill', '03 Chorus']));
    mkdirSync(join(card, 'Projects/Songs/Night Drive (Nobody)/Night Drive_[ProjectData]'), { recursive: true });
    put('Projects/Songs/Slow Tide (Nobody)/Slow Tide.xpj', xpj(['01 Intro']));
    put('Projects/Loose Jam/Loose Jam.xpj', xpj(['01 A']));
    put('Projects/_Tests/One.xpj', xpj(['01 A']));
    put('Projects/_Tests/Two.xpj', xpj(['01 A']));
    put('Projects/Songs/Broken (Nobody)/Broken.xpj', Buffer.from('not a project'));
    put('Projects/Too/Deep/Down/Hidden/Hidden.xpj', xpj(['01 A']));

    check('card: a root needs both Projects and Expansions', isMpcCardRoot(card) && !isMpcCardRoot(join(card, 'Projects')));
    process.env[MPC_CARD_ROOT_ENV] = card;
    check('card: the env var names the root', resolveMpcCardRoot() === card);
    process.env[MPC_CARD_ROOT_ENV] = join(card, 'Projects');
    check('card: an env var pointing at a folder that is not a card resolves to nothing', resolveMpcCardRoot() === undefined);
    process.env[MPC_CARD_ROOT_ENV] = card;

    const projects = listCardProjects(card);
    check('card: projects are listed by folder path (a folder of loose project files lists each), sample and too-deep folders left out',
      projects.map((x) => x.location).join('|') === 'Loose Jam|Songs/Broken (Nobody)|Songs/Night Drive (Nobody)|Songs/Slow Tide (Nobody)|_Tests/One|_Tests/Two',
      projects.map((x) => x.location).join('|'));
    const pick = (q: string | number): string => {
      const r = findCardProject(projects, q);
      return 'candidates' in r ? `? ${r.candidates.length}` : r.location;
    };
    check('card: a project is found by path, by name, by a partial name and by list position',
      pick('Songs/Night Drive (Nobody)') === 'Songs/Night Drive (Nobody)' && pick('night drive') === 'Songs/Night Drive (Nobody)'
      && pick('slow') === 'Songs/Slow Tide (Nobody)' && pick(1) === 'Loose Jam' && pick('Songs\\Night Drive (Nobody)\\Night Drive.xpj') === 'Songs/Night Drive (Nobody)');
    check('card: a path given from below Projects/ (as a song book names it) matches as a path tail',
      pick('Night Drive (Nobody)/Night Drive') === 'Songs/Night Drive (Nobody)' && pick('Night Drive (Nobody)') === 'Songs/Night Drive (Nobody)');
    check('card: an ambiguous or unknown name returns candidates, never a guess', pick('nobody') === '? 3' && pick('zzz') === '? 6' && pick('_Tests/Two') === '_Tests/Two');

    const d = MPC_ONE_G2_DESCRIPTOR;
    check('card: the descriptor is hybrid with both surfaces at once',
      d.transport?.kind === 'hybrid' && d.transport.concurrent === true && d.transport.resolveRoot?.() === card);
    const sent: number[][] = [];
    let opened = 0;
    const conn = createLazyMidiConnection(() => { opened++; return { send: (b: number[]) => { sent.push(b); } } as never; });
    const ctx = { conn, storage: { root: card }, descriptor: d } as unknown as DispatchCtx;
    const scan = await d.reader.scanLocations!(ctx, 1, 99);
    check('card: a range wider than 200 projects is refused up front, naming how to page',
      /at most 200 projects per call/.test(await (async () => { try { await d.reader.scanLocations!(ctx, 1, 500); return ''; } catch (e) { return (e as Error).message; } })()));
    // The dispatcher's handle-health check reads lastSendError after ANY error.
    // On an unopened port that must answer "none" without opening it; when it
    // opened, the failed open replaced the card's own refusal with "no MIDI
    // port" (found by live-regression against the real card).
    check('card: a health check after a card error does not open the MIDI port',
      (conn as { lastSendError?: unknown }).lastSendError === undefined && opened === 0);
    check('card: scan_locations lists the projects and clamps the range',
      scan.scanned.length === 6 && scan.scanned[2].location === 'Songs/Night Drive (Nobody)' && scan.scanned[2].name === 'Night Drive');
    const snap = await d.reader.getPreset!(ctx, { location: 'night drive' });
    check('card: get_preset lists the sequences by number (the chorus is 4, not 3)',
      snap.name === 'Night Drive' && snap.slots.length === 4
      && snap.slots[3].slot === 4 && snap.slots[3].params?.name === '03 Chorus' && snap.slots[3].params?.bpm === 96 && snap.slots[3].params?.bars === 8,
      JSON.stringify(snap.slots[3]));
    check('card: the read says it came from the file and gives the playlist in sequence numbers',
      /on the SD card, not from the MPC's memory/.test(snap.read_warnings?.[0] ?? '') && /"Night Drive": 1 4x2/.test(snap.read_warnings?.[1] ?? ''),
      JSON.stringify(snap.read_warnings));
    check('card: a card read opens no MIDI port', opened === 0);

    // Internal storage: the same two folders one level down, in "MPC Documents",
    // with projects saved straight into Projects/ as the MPC does by default.
    put('MPC Documents/Expansions/keep.txt', Buffer.from(''));
    put('MPC Documents/Projects/FX Template.xpj', xpj(['01 A']));
    put('MPC Documents/Projects/BnB.xpj', xpj(['01 Verse', '02 Chorus']));
    put('MPC Documents/Projects/BnB_[ProjectData]/kick.wav', Buffer.from(''));
    put('MPC Documents/Projects/Sets/Live Set/Live Set.xpj', xpj(['01 A']));
    const internalRoot = join(card, 'MPC Documents');
    const internal = listCardProjects(internalRoot, 'internal');
    check('internal: loose projects in Projects/ and grouped ones are listed, each marked internal',
      internal.map((x) => x.location).join('|') === 'internal:BnB|internal:FX Template|internal:Sets/Live Set'
      && internal.every((x) => x.volume === 'internal' && x.root === internalRoot),
      internal.map((x) => x.location).join('|'));
    const both = listMpcProjects([{ root: card, volume: 'card' }, { root: internalRoot, volume: 'internal' }]);
    check('internal: both volumes list together, the card first so its positions do not move',
      both.length === projects.length + 3 && both[0].location === 'Loose Jam' && both[projects.length].location === 'internal:BnB');
    const hit = findCardProject(both, 'bnb');
    check('internal: a project is found by name across volumes and read from its own volume',
      !('candidates' in hit) && hit.volume === 'internal' && readCardProject(card, hit).sequences.length === 2);
    check('internal: a card project still lists as before (loose files at the top of Projects/ aside)',
      listCardProjects(card).every((x) => x.volume === 'card' && !x.location.startsWith('internal:')));
    const refusal = async (fn: () => Promise<unknown>): Promise<string> => { try { await fn(); return ''; } catch (e) { return (e as Error).message; } };
    check('card: an unknown project names the ones that exist',
      /Songs\/Slow Tide/.test(await refusal(() => d.reader.getPreset!(ctx, { location: 'zzz' }))));
    check('card: a file that is not a project refuses, naming the file',
      /Broken\.xpj could not be read/.test(await refusal(() => d.reader.getPreset!(ctx, { location: 'Broken' }))));
    check('card: get_preset with no location says the MPC reports nothing about its loaded project',
      /reports nothing/.test(await refusal(() => d.reader.getPreset!(ctx))));
    await d.writer.switchPreset!(ctx, 4);
    check('card: with the card mounted, switch_preset still reaches the MPC (port opened on first send)',
      opened === 1 && sent.length === 1 && sent[0][1] === 3);
    const midiOnly = { conn, descriptor: d } as unknown as DispatchCtx;
    check('card: with no card mounted, a card read says how to mount it',
      /card mounted on this computer/.test(await refusal(() => d.reader.scanLocations!(midiOnly, 1, 5))));
  } finally {
    if (prior === undefined) delete process.env[MPC_CARD_ROOT_ENV]; else process.env[MPC_CARD_ROOT_ENV] = prior;
    rmSync(card, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.log(`\nverify-akai-mpc: ${failures} failure(s)`);
  process.exit(1);
}
console.log('verify-akai-mpc OK');
