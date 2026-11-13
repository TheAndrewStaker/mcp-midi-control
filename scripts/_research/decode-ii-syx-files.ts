// Diagnostic: decode Axe-Fx II preset .syx files offline (no tool reads a file yet).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseIIImageTlv, imageParamWordIndex, parseIIGrid, decodeSceneStateWord, sceneStateWordIndex, KNOWN_PARAMS } from 'fractal-midi/gen2/axe-fx-ii';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
const dir = process.argv[2];
const WANT: Record<string, string[]> = {
  amp: ['effect_type','input_drive','bass','middle','treble','master_volume','presence','depth','level','input_trim','tone_location','bright'],
  drive: ['effect_type','gain','tone','volume','mix','lo_cut','hi_cut'],
  gate: ['threshold','ratio','attack','hold','release','low_cut','high_cut'],
  cab: ['effect_type','cab_type_l','cab_type_r','mic_l','mic_r','low_cut','high_cut','level_l','level_r'],
  delay: ['effect_type','time','tempo','feedback','mix','level','high_cut','low_cut'],
  reverb: ['effect_type','time','mix','level','size','predelay','high_cut','low_cut','early_level','late_level'],
  compressor: ['effect_type','threshold','ratio','attack','release','mix'],
  filter: ['effect_type','frequency','q','gain','level'],
  pitch: ['effect_type','mix'],
};
const P = Object.values(KNOWN_PARAMS) as any[];
for (const f of readdirSync(dir).filter((x) => x.endsWith('.syx'))) {
  const bytes = new Uint8Array(readFileSync(join(dir, f)));
  try {
    // Mark I/II (model 0x03) dumps carry 32 chunks (2048 words); the XL+ 64. Same 3-byte word packing.
    const words = new Uint16Array(4096);
    let cur = 12, c = 0;
    while (bytes[cur + 5] === 0x78) {
      const pl = bytes.slice(cur + 6, cur + 202 - 2);
      const count = (pl[0] & 0x7f) | ((pl[1] & 0x7f) << 7);
      for (let i = 0; i < count; i++) { const o = 2 + i * 3; words[c * 64 + i] = (pl[o] & 0x7f) | ((pl[o + 1] & 0x7f) << 7) | ((pl[o + 2] & 0x03) << 14); }
      cur += 202; c++;
    }
    console.log(`  [${c} chunks, format tag ${words[0]}]`);
    const tag = words[0]; words[0] = 2049; // older firmware tag (516/770); layout beyond word 0 matches
    const img = { words };
    const tlv = parseIIImageTlv(img.words);
    console.log(`\n=== ${f}  name="${tlv.name}"`);
    const grid = parseIIGrid(img.words).filter((c: any) => c.id >= 100 && c.id < 200);
    console.log('  grid:', grid.map((c: any) => `${c.row ?? '?'},${c.col ?? '?'}:${c.id}`).join(' '));
    for (const b of tlv.blocks) {
      const slug = b.block?.name ?? `id${b.wireId}`;
      const params = P.filter((p) => p.groupCode === b.block?.groupCode);
      const blockKey = params[0]?.block;
      const sw = sceneStateWordIndex(b);
      const scenes = sw !== undefined ? decodeSceneStateWord(img.words[sw]).map((s: any) => (s.bypassed ? '-' : (s.channel ?? 'X'))).join('') : '';
      const want = WANT[blockKey] ?? [];
      const out: string[] = [];
      for (const ch of ['X', 'Y'] as const) {
        const vals: string[] = [];
        for (const name of want) {
          const p = params.find((q) => q.name === name);
          if (!p) continue;
          try {
            const w = img.words[imageParamWordIndex(b, p.paramId, ch)];
            const sch = (AXEFX2_DESCRIPTOR as any).blocks?.[blockKey]?.params?.[name];
            const d = sch?.decode ? sch.decode(w) : w;
            vals.push(`${name}=${typeof d === 'number' ? Math.round(d * 100) / 100 : d}`);
          } catch { /* single-channel Y */ }
        }
        if (vals.length) out.push(`${ch}{ ${vals.join(', ')} }`);
      }
      console.log(`  ${slug} [scenes ${scenes}] ${out.join(' ')}`);
    }
  } catch (e) { console.log(`\n=== ${f}: ${(e as Error).message}`); }
}
