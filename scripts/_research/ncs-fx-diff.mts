/** Controlled differential: SceneTest 1234 BEFORE any FX sends (backed up when it was deleted from
 *  slot 62) vs AFTER the owner saved with my 8 distinct reverb sends live. Distinct values mean each
 *  byte identifies itself. */
import { readFileSync } from 'node:fs';
const BEFORE = 'C:/Users/Steph/mcp-midi-backups/Novation_Circuit_Tracks-pack3-slot62-SceneTest_1234-2026-09-12_20-28-06.ncs';
const AFTER  = 'C:/Users/Steph/mcp-midi-backups/fx-decode/Novation_Circuit_Tracks-SceneTest_1234-2026-09-12_21-59-33.ncs';
const a = new Uint8Array(readFileSync(BEFORE));
const b = new Uint8Array(readFileSync(AFTER));
const SENT: Record<number, string> = {11:'synth1',22:'synth2',33:'drum1',44:'drum2',55:'drum3',66:'drum4',77:'audio1/MIDI1',88:'audio2/MIDI2'};
const diffs: {o:number;f:number;t:number}[] = [];
for (let i=0;i<a.length;i++) if (a[i]!==b[i]) diffs.push({o:i,f:a[i],t:b[i]});
console.log(`${diffs.length} byte(s) differ\n`);
console.log('--- bytes whose NEW value is one of the 8 values I sent ---');
const hits = diffs.filter(d=>SENT[d.t]!==undefined);
for (const d of hits) console.log(`  0x${d.o.toString(16)}  ${String(d.f).padStart(3)} -> ${String(d.t).padStart(3)}   <= ${SENT[d.t]} reverb send`);
console.log(`\n--- every other changed byte (save side-effects) ---`);
for (const d of diffs.filter(d=>SENT[d.t]===undefined).slice(0,30)) console.log(`  0x${d.o.toString(16)}  ${String(d.f).padStart(3)} -> ${String(d.t).padStart(3)}`);
const others = diffs.filter(d=>SENT[d.t]===undefined).length;
if (others>30) console.log(`  … +${others-30} more`);
