/**
 * Deterministic validator for SPD-SX kit `.spd` XML — the pre-write gate.
 *
 * Port of `scripts/spdsx/verify_kit_xml.py`. Checks the structural invariants
 * that hold across every real device kit, so an AUTHORED kit can be proven
 * well-formed BEFORE it is written, and so the real kits on a device (or the
 * snapshot corpus) can be used as a deterministic regression set.
 *
 * Dependency-free (no XML library): the format is a flat, predictable tag set,
 * so the invariants are checked by targeted matches rather than a full parse.
 */

import { NAME_LEN, SUBNAME_LEN, PAD_COUNT } from './kitXml.js';

export interface KitValidation {
  ok: boolean;
  name: string | undefined;
  assigned: number;
  errors: string[];
}

function intTag(text: string, tag: string): number | undefined {
  const m = text.match(new RegExp(`<${tag}>\\s*(-?\\d+)\\s*</${tag}>`));
  return m ? Number.parseInt(m[1], 10) : undefined;
}

/** Decode <prefix0..prefixN-1> char-codes into a string (stop at NUL). */
function decodeName(text: string, prefix: string, n: number): string | undefined {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const v = intTag(text, `${prefix}${i}`);
    if (v === undefined) return undefined; // missing field
    if (v === 0) break;
    if (v >= 32 && v <= 126) out.push(String.fromCharCode(v));
  }
  return out.join('').replace(/\s+$/, '');
}

export function validateKit(text: string, maxWave?: number): KitValidation {
  const errs: string[] = [];
  // Strip a UTF-8 BOM if present (Python read utf-8-sig).
  const raw = text.replace(/^﻿/, '');

  const rootMatch = raw.match(/<\s*([A-Za-z][\w]*)/);
  if (!rootMatch || rootMatch[1] !== 'KitPrm') {
    errs.push(`root tag is <${rootMatch ? rootMatch[1] : '?'}>, expected <KitPrm>`);
  }

  // Name (required) — NUL or printable-ASCII codes, non-empty.
  const name = decodeName(raw, 'Nm', NAME_LEN);
  if (name === undefined) {
    errs.push(`missing/invalid Nm0..Nm${NAME_LEN - 1} (kit name)`);
  } else {
    for (let i = 0; i < NAME_LEN; i++) {
      const v = intTag(raw, `Nm${i}`);
      if (v !== undefined && v !== 0 && !(v >= 32 && v <= 126)) {
        errs.push(`Nm${i} = ${v} is not NUL or printable ASCII (32..126)`);
      }
    }
    if (name === '') errs.push('kit name is empty');
  }

  // Sub-name (required structurally; content may be blank).
  for (let i = 0; i < SUBNAME_LEN; i++) {
    if (intTag(raw, `SubNm${i}`) === undefined) {
      errs.push(`missing SubNm${i}`);
      break;
    }
  }

  // Optional Level / Tempo: if present must be in range.
  const lvl = intTag(raw, 'Level');
  if (lvl !== undefined && !(lvl >= 0 && lvl <= 127)) errs.push(`Level out of range 0..127: ${lvl}`);
  const tempo = intTag(raw, 'Tempo');
  if (tempo !== undefined && !(tempo >= 200 && tempo <= 3000)) {
    errs.push(`Tempo out of range 200..3000 (BPM*10): ${tempo}`);
  }

  // Pads: exactly PAD_COUNT <PadPrm>, each with valid Wv + SubWv.
  const pads = [...raw.matchAll(/<PadPrm>([\s\S]*?)<\/PadPrm>/g)].map((m) => m[1]);
  if (pads.length !== PAD_COUNT) errs.push(`found ${pads.length} <PadPrm>, expected ${PAD_COUNT}`);
  let assigned = 0;
  pads.forEach((pad, idx) => {
    for (const field of ['Wv', 'SubWv'] as const) {
      const v = intTag(pad, field);
      if (v === undefined) {
        errs.push(`pad ${idx}: missing/invalid <${field}>`);
        continue;
      }
      if (v < -1) errs.push(`pad ${idx}: <${field}> = ${v} (< -1)`);
      else if (v !== -1 && maxWave !== undefined && v > maxWave) {
        errs.push(`pad ${idx}: <${field}> = ${v} exceeds max wave index ${maxWave}`);
      }
      if (field === 'Wv' && v !== -1) assigned += 1;
    }
  });
  if (pads.length === PAD_COUNT && assigned === 0) {
    errs.push('kit has no waves assigned to any pad (all Wv = -1)');
  }

  return { ok: errs.length === 0, name, assigned, errors: errs };
}
