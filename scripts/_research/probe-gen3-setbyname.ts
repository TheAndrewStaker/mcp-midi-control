import { AXEFX3_DESCRIPTOR, FM3_DESCRIPTOR, FM9_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/device.js';
const cases: Array<[string, string, string]> = [
  ['drive', 'type', 'Klone Chiron'], ['drive', 'type', 'DS1 Distortion Mod'], ['reverb', 'type', 'Room, Small'],
  ['reverb', 'type', 'Small Room'], ['reverb', 'type', 'Spring, Medium'], ['compressor', 'type', 'VCA Modern Compressor'],
  ['chorus', 'type', 'Japan CE-1 Chorus'], ['delay', 'model', 'Pan Delay'],
];
for (const [id, d] of Object.entries({ iii: AXEFX3_DESCRIPTOR, fm3: FM3_DESCRIPTOR, fm9: FM9_DESCRIPTOR })) {
  console.log(id, cases.map(([b, p, v]) => { try { return `${v}=${String(d.blocks[b]?.params[p]?.encode(v))}`; } catch { return `${v}=THROW`; } }).join(' | '));
}
