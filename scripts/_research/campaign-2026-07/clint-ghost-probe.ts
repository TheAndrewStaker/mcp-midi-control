/** Ghost-flag census for the Clint drum union + the old card's stored velocity multiset (READ-ONLY). */
import { readFileSync } from 'node:fs';
import { flattenSongsterrDrums, type SongsterrPart } from '../../packages/core/src/protocol-generic/patterns/songsterr.js';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s8562';
const load = (id: number): SongsterrPart => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
for (const id of [14, 15]) {
  const f = flattenSongsterrDrums(load(id));
  console.log(`t${id}: ${f.events.length} events, flat.ghosts=${(f as unknown as {ghosts:number}).ghosts} accents=${(f as unknown as {accents:number}).accents}`);
  const byVoice = new Map<string, {tot:number; ghost:number; ghostNoVel:number; explicit:number}>();
  for (const e of f.events) {
    const r = byVoice.get(e.voice) ?? {tot:0,ghost:0,ghostNoVel:0,explicit:0};
    r.tot++;
    if (e.ghost === true) { r.ghost++; if (e.velocity === undefined) r.ghostNoVel++; }
    if (e.velocity !== undefined) r.explicit++;
    byVoice.set(e.voice, r);
  }
  for (const [v, r] of [...byVoice.entries()].sort()) console.log(`   ${v}: ${r.tot} tot, ghost ${r.ghost} (no explicit vel ${r.ghostNoVel}), explicit vel ${r.explicit}`);
}
// old card oracle: stored midi2 velocity multiset across slots 27-34
const ORACLE = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/card-backup-2026-07-29/pack5';
const vm = new Map<number, number>();
const noteVm = new Map<string, number>();
for (let slot = 27; slot <= 34; slot++) {
  const buf = readFileSync(`${ORACLE}/proj${slot}__${slot - 1}_SESSION.ncs`);
  for (let p = 0; p < 8; p++) {
    for (const s of decodeNotePattern(buf as unknown as Uint8Array, 'midi2', p)) {
      if (!s.active) continue;
      for (const n of s.notes) {
        vm.set(n.velocity, (vm.get(n.velocity) ?? 0) + 1);
        noteVm.set(`${n.note}@${n.velocity}`, (noteVm.get(`${n.note}@${n.velocity}`) ?? 0) + 1);
      }
    }
  }
}
console.log(`\nOLD CARD stored midi2 velocity multiset (slots 27-34): ${JSON.stringify(Object.fromEntries([...vm.entries()].sort((a,b)=>a[0]-b[0])))}`);
console.log(`OLD CARD note@vel: ${JSON.stringify(Object.fromEntries([...noteVm.entries()].sort()))}`);
