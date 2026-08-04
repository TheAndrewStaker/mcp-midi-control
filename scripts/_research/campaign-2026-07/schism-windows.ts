import { readFileSync } from 'node:fs';
import { toChopPart, planSongChop } from '../../packages/core/src/protocol-generic/patterns/songChop.js';
import type { SongsterrPart } from '../../packages/core/src/protocol-generic/patterns/songsterr.js';
const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s6700';
const load = (id: number) => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
const parts = [[2,'S1'],[3,'M1'],[5,'DR']].map(([id, l]) => toChopPart(id as number, l as string, load(id as number)));
const plan = planSongChop(parts);
for (const p of plan.projects) {
  const w = p.pattern_windows.map((x) => `m${x.from_measure}${x.to_measure !== x.from_measure ? '-' + x.to_measure : ''}(${x.steps})`).join(' ');
  console.log(`P${String(p.project).padStart(2)} ${p.name.padEnd(26)} ${w}`);
}
