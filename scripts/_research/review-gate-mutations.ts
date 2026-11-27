// review scratch: do the synthetic cases in verify-fractal-gen3-family.ts's print-precision block catch rule mutations?
import { devicePrintDecimals } from '@mcp-midi-control/fractal-gen3/catalog.js';
type R = { kind: 'float' | 'enum'; displayMin: number; displayMax: number; step?: number; scale?: number; typecode?: number };
const row = (typecode: number | undefined, displayMin = 0, displayMax = 1000): R => ({ kind: 'float', displayMin, displayMax, step: 1, scale: 1, typecode });
const cases: Array<[R, number]> = [
  [row(0x430), 0], [row(0x431), 1], [row(0x562), 2], [row(0x43, 0.1, 10), 3], [row(0x434), 3], [row(0x52), 2], [row(undefined), 2],
  [row(0x570, 0, 1), 2], [row(0x571, 0, 1), 1],
  [{ kind: 'float', displayMin: 0, displayMax: 100, step: 0.001, scale: 100, typecode: 0x570 }, 1],
  [{ kind: 'float', displayMin: 0, displayMax: 1000, step: 1, scale: 1, typecode: 0x431 }, 1],
  [{ kind: 'enum', displayMin: 0, displayMax: 3, step: 1, scale: 1, typecode: 0x10 }, 2],
];
const p10 = (r: R) => { const inc = (r.step ?? 0) * (r.scale ?? 0); if (!(inc > 0)) return undefined; const e = Math.log10(inc), s = -Math.round(e); return Math.abs(e + s) < 1e-9 ? s : undefined; };
const guard = (r: R, d: number, t = (n: number) => n >= 10) => (t(Math.abs(r.displayMax - r.displayMin) * 10 ** d) ? d : 2);
const base = (r: R) => r.kind !== 'float' || r.typecode === undefined ? undefined : (r.typecode & 0xff) === 0x52 ? 2 : undefined;
const mut: Record<string, (r: R) => number> = {
  shipped: (r) => devicePrintDecimals(r as never),
  oldStepOnly: (r) => base(r) ?? (() => { const s = p10(r); return s !== undefined && s <= 3 ? s : 2; })(),
  nibbleOnly: (r) => base(r) ?? guard(r, Math.min(3, r.typecode! & 0xf)),
  noGuard: (r) => base(r) ?? (() => { let d = Math.min(3, r.typecode! & 0xf); const s = p10(r); if (s !== undefined && s > d && s <= 3) d = s; return d; })(),
  guardStrict: (r) => base(r) ?? (() => { let d = Math.min(3, r.typecode! & 0xf); const s = p10(r); if (s !== undefined && s > d && s <= 3) d = s; return guard(r, d, (n) => n > 10); })(),
  noCap: (r) => base(r) ?? (() => { let d = r.typecode! & 0xf; const s = p10(r); if (s !== undefined && s > d && s <= 3) d = s; return guard(r, d); })(),
  overrideCanLower: (r) => base(r) ?? (() => { let d = Math.min(3, r.typecode! & 0xf); const s = p10(r); if (s !== undefined && s <= 3) d = s; return guard(r, d); })(),
  overrideAnyFinerStep: (r) => base(r) ?? (() => { let d = Math.min(3, r.typecode! & 0xf); const inc = (r.step ?? 0) * (r.scale ?? 0); if (inc > 0) { const s = Math.ceil(-Math.log10(inc) - 1e-9); if (s > d && s <= 3) d = s; } return guard(r, d); })(),
  overrideNoUpperBound: (r) => base(r) ?? (() => { let d = Math.min(3, r.typecode! & 0xf); const s = p10(r); if (s !== undefined && s > d) d = s; return guard(r, d); })(),
  no0x52: (r) => r.kind !== 'float' || r.typecode === undefined ? 2 : (() => { let d = Math.min(3, r.typecode! & 0xf); const s = p10(r); if (s !== undefined && s > d && s <= 3) d = s; return guard(r, d); })(),
  guardTo0: (r) => base(r) ?? (() => { let d = Math.min(3, r.typecode! & 0xf); const s = p10(r); if (s !== undefined && s > d && s <= 3) d = s; return Math.abs(r.displayMax - r.displayMin) * 10 ** d >= 10 ? d : 0; })(),
};
for (const [name, f] of Object.entries(mut)) {
  const fails = cases.filter(([r, want]) => f(r) !== want).length;
  console.log(`${name.padEnd(22)} gate cases failing: ${fails}${name === 'shipped' ? '' : fails ? '  (caught)' : '  (NOT CAUGHT)'}`);
}
