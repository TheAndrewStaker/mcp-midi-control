import { AXEFX3_DESCRIPTOR, FM3_DESCRIPTOR, FM9_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/device.js';
const want = /^(compressor|drive|amp|phaser|fuzz)\.(dynamics|bias|dyn_?pres\w*|dyn_?depth\w*|tone|line_?freq\w*|resample\w*|in_?dynamics|spkr_?dynamics|bias_?x|bias_?excursion)$/i;
for (const [id, d] of [['iii', AXEFX3_DESCRIPTOR], ['fm3', FM3_DESCRIPTOR], ['fm9', FM9_DESCRIPTOR]] as const)
  for (const [slug, b] of Object.entries(d.blocks)) for (const [n, s] of Object.entries(b.params))
    if (want.test(`${slug}.${n}`)) console.log(id, `${slug}.${n}`.padEnd(30), s.unit, s.display_min, s.display_max, s.wire_kind ?? '', 'decode(32767)=', (() => { try { return s.decode(32767); } catch (e) { return 'ERR'; } })());
