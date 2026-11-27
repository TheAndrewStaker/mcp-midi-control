// review scratch: would dropping the 0x52 exemption change any real row? (nibble and power-of-ten step on 0x52 rows)
import { FM9_RANGES } from 'fractal-midi/gen3/fm9';
import { FM3_RANGES } from 'fractal-midi/gen3/fm3';
import { III_RANGES } from 'fractal-midi/gen3/axe-fx-iii';
for (const [id, R] of [['iii', III_RANGES], ['fm3', FM3_RANGES], ['fm9', FM9_RANGES]] as const) {
  const h: Record<string, number> = {};
  for (const fam of Object.values(R as any)) for (const r of Object.values(fam as any) as any[]) {
    if (r?.kind !== 'float' || r.typecode === undefined || (r.typecode & 0xff) !== 0x52) continue;
    const inc = r.step * r.scale; const e = inc > 0 ? Math.log10(inc) : NaN; const s = -Math.round(e);
    const k = `nib ${r.typecode & 0xf}, inc ${+inc.toPrecision(3)}${Math.abs(e + s) < 1e-9 && s > 2 && s <= 3 ? ' (override->' + s + ')' : ''}`; h[k] = (h[k] ?? 0) + 1;
  }
  console.log(id, JSON.stringify(h));
}
