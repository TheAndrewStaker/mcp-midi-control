/**
 * schism-make-templates.ts: write 16 pre-named .ncs template copies for the
 * Schism build (plan: docs/_private/rig/songs/schism-build-plan-2026-07-29.md §2).
 *
 * apply_pattern has no name argument; names come from the template (the After
 * Dark §11 method). Copies samples/circuit-tracks/blank_slot20.ncs and patches
 * ONLY bytes 0x10..0x30 (32-byte space-padded ASCII name field, verified in
 * scripts/circuit-after-dark-rename.ts). No device I/O.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const NAME_OFF = 0x10;
const NAME_LEN = 0x20;
const EXPECT_CURRENT = 'User Session';

const PARTS: { file: string; name: string }[] = [
  { file: '01-intro.ncs',  name: 'Schism 01 Intro' },
  { file: '02-v1a.ncs',    name: 'Schism 02 V1a' },
  { file: '03-v1b.ncs',    name: 'Schism 03 V1b' },
  { file: '04-br1.ncs',    name: 'Schism 04 Br1' },
  { file: '05-v2.ncs',     name: 'Schism 05 V2' },
  { file: '06-br2hvy.ncs', name: 'Schism 06 Br2Hvy' },
  { file: '07-v3.ncs',     name: 'Schism 07 V3' },
  { file: '08-br3.ncs',    name: 'Schism 08 Br3' },
  { file: '09-int1.ncs',   name: 'Schism 09 Int1' },
  { file: '10-int2.ncs',   name: 'Schism 10 Int2' },
  { file: '11-int3.ncs',   name: 'Schism 11 Int3' },
  { file: '12-int4.ncs',   name: 'Schism 12 Int4' },
  { file: '13-btwn1.ncs',  name: 'Schism 13 Btwn1' },
  { file: '14-btwn2.ncs',  name: 'Schism 14 Btwn2' },
  { file: '15-out1.ncs',   name: 'Schism 15 Out1' },
  { file: '16-out2.ncs',   name: 'Schism 16 Out2' },
];

const nameOf = (b: Uint8Array): string =>
  Array.from(b.slice(NAME_OFF, NAME_OFF + NAME_LEN)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();

function nameBytes(name: string): number[] {
  if (name.length > NAME_LEN) throw new Error(`name "${name}" is ${name.length} chars; the field holds ${NAME_LEN}`);
  if (!/^[\x20-\x7e]+$/.test(name)) throw new Error(`name "${name}" has non-printable-ASCII characters`);
  return Array.from({ length: NAME_LEN }, (_, i) => (i < name.length ? name.charCodeAt(i) : 0x20));
}

const src = readFileSync('samples/circuit-tracks/blank_slot20.ncs');
const cur = nameOf(src);
if (cur !== EXPECT_CURRENT) {
  throw new Error(`template name is "${cur}", expected "${EXPECT_CURRENT}"; refusing`);
}

mkdirSync('samples/circuit-tracks/schism', { recursive: true });

for (const p of PARTS) {
  const out = Buffer.from(src);
  const want = nameBytes(p.name);
  for (let i = 0; i < NAME_LEN; i++) out[NAME_OFF + i] = want[i];
  // verify: only the name field differs
  let diff = 0;
  for (let i = 0; i < src.length; i++) {
    if (out[i] !== src[i] && (i < NAME_OFF || i >= NAME_OFF + NAME_LEN)) diff++;
  }
  if (diff !== 0) throw new Error(`${p.file}: ${diff} bytes changed outside the name field`);
  const path = `samples/circuit-tracks/schism/${p.file}`;
  writeFileSync(path, out);
  console.log(`${path}  name="${nameOf(out)}"`);
}
console.log(`\n${PARTS.length} templates written.`);
