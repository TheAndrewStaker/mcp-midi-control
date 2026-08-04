import { readFileSync } from 'node:fs';
import { flattenSongsterrDrums, type SongsterrPart } from '../../packages/core/src/protocol-generic/patterns/songsterr.js';
import { quantizeDrumEvents } from '../../packages/core/src/protocol-generic/patterns/drumScore.js';
const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s23527';
const load = (id: number): SongsterrPart => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
const d = flattenSongsterrDrums(load(6));
const q = quantizeDrumEvents(d.events, { beats: 77 * 4, stepsPerBeat: 4 });
for (const m of [7]) {
  console.log(`--- source m${m}:`);
  for (const [v, steps] of Object.entries(q.voices)) for (const [gs, s] of (steps as any[]).entries()) {
    if (!s.on) continue; const bar = Math.floor(gs/16)+1; if (bar !== m) continue;
    console.log(`  ${v} sib${gs%16} micro[${(s.micro??[0]).join(',')}] vel ${s.velocity ?? (s.accent?120:100)}`);
  }
}
// how many distinct bar images in the whole source
const sig = new Map<number,string>();
for (let b=1;b<=77;b++){const c:string[]=[];for(const [v,steps] of Object.entries(q.voices))for(const [gs,s] of (steps as any[]).entries()){if(!s.on)continue;if(Math.floor(gs/16)+1!==b)continue;for(const mi of (s.micro??[0]))c.push(`${gs%16}|${v}|${mi}`);}sig.set(b,c.sort().join(','));}
console.log(`source distinct bar images across 77 bars: ${new Set(sig.values()).size}`);
