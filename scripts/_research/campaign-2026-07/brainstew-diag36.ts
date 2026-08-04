// Diagnose slot 36 pattern 4 (m35-36): stored vs staged vs fresh import. Read-only.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';
import { importSongsterrDrums, type SongsterrPart } from '../../packages/core/src/protocol-generic/patterns/songsterr.js';

const dir = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/brainstew-authored-2026-07-29';
const f = readdirSync(dir).find((x) => /project36/.test(x))!;
const buf = readFileSync(join(dir, f));
const staged = JSON.parse(readFileSync('C:/dev/mcp-midi-tools/samples/_scratch/brainstew-staged.json', 'utf8'));
const sec = staged.find((s: any) => s.slot === 36).sections.find((x: any) => x.name === 'm35-36');

console.log('staged hat row  :', sec.voices.hat);
console.log('staged openhat  :', sec.voices.openhat);

// stored midi2 pattern 4, steps with notes
const m2 = decodeNotePattern(buf, 'midi2', 3);
const rows: string[] = [];
m2.forEach((s: any, i: number) => { if (s.active) rows.push(`${i}: ${s.notes.map((x: any) => `${x.note}@${x.velocity}`).join('+')}`); });
console.log('stored midi2 p4 :', rows.join('  '));

// stored drum3 pattern 4
const d3 = decodeDrumPattern(buf, 2, 3).flatMap((s: any, i: number) => (s.active ? [`${i}@${s.velocity}`] : []));
console.log('stored drum3 p4 :', d3.join(' '));

// fresh import of m35-36
const p6 = JSON.parse(readFileSync('C:/dev/mcp-midi-tools/samples/songsterr-cache/s8644/part-6.json', 'utf8')) as SongsterrPart;
const imp = importSongsterrDrums(p6, { stepsPerBeat: 4, fromMeasure: 35, toMeasure: 36 });
for (const [v, steps] of Object.entries(imp.voices)) {
  const hits = (steps as any[]).flatMap((s: any, i: number) => (s.on ? [`${i}${s.velocity !== undefined ? '@' + s.velocity : ''}${s.micro !== undefined ? 'm' + JSON.stringify(s.micro) : ''}`] : []));
  console.log(`import ${v}:`, hits.join(' '));
}
