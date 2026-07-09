/**
 * SPD-SX wave-parameter `.spd` codec — encode / parse a `<WvPrm>` record.
 *
 * A wave in the pool is two files at index = bucket*100 + slot:
 *   WAVE/DATA/<bucket>/<short>.wav   the audio (canonical 44.1k/16 PCM)
 *   WAVE/PRM/<bucket>/<slot>.spd     <WvPrm>: Nm0..Nm11 (name), Path, Tag
 * The device rebuilds its wave list from the PRM tree on load — there is no
 * master wavelist to maintain (2026-06-27 import A/B capture).
 *
 * Byte-for-byte port of the XML half of `scripts/spdsx/spdsx_wave.py`.
 */

export const NM_LEN = 12;

/** Wave name -> 12 char-codes, NUL-padded. Rejects non-printable ASCII. */
export function nameToNm(name: string): number[] {
  for (const c of name) {
    const code = c.charCodeAt(0);
    if (code < 32 || code > 126) {
      throw new Error(`wave name must be printable ASCII (no unicode/control chars): ${JSON.stringify(name)}`);
    }
  }
  const trimmed = name.slice(0, NM_LEN);
  const out = [...trimmed].map((c) => c.charCodeAt(0));
  while (out.length < NM_LEN) out.push(0);
  return out;
}

/** True when a wave name would be truncated to NM_LEN. */
export function nameTruncated(name: string): boolean {
  return name.length > NM_LEN;
}

export function encodeWavePrm(nmCodes: readonly number[], path: string, tag: number): string {
  const out: string[] = ['<WvPrm>'];
  nmCodes.forEach((c, i) => out.push(`\t<Nm${i}>${c}</Nm${i}>`));
  out.push(`\t<Path>${path}</Path>`);
  out.push(`\t<Tag>${tag}</Tag>`);
  out.push('</WvPrm>');
  return out.join('\n') + '\n';
}

export function parseWavePrm(text: string): { nm: number[]; path: string; tag: number } {
  const nm: number[] = [];
  for (let i = 0; i < NM_LEN; i++) {
    const m = text.match(new RegExp(`<Nm${i}>(-?\\d+)</Nm${i}>`));
    nm.push(m ? Number.parseInt(m[1], 10) : 0);
  }
  const path = /<Path>([\s\S]*?)<\/Path>/.exec(text)![1];
  const tag = Number.parseInt(/<Tag>(-?\d+)<\/Tag>/.exec(text)![1], 10);
  return { nm, path, tag };
}

/**
 * A short (<=8.3) DATA filename unique within its bucket, case-folded (FAT is
 * case-INSENSITIVE) against both on-disk names and names planned this batch.
 */
export function dataFilename(name: string, exists: (candidate: string) => boolean): string {
  const base = ([...name].filter((c) => /[a-zA-Z0-9_-]/.test(c)).join('').slice(0, 8)) || 'wave';
  let cand = base;
  let i = 1;
  while (exists(`${cand}.wav`)) {
    const sfx = `_${String(i).padStart(2, '0')}`;
    cand = base.slice(0, 8 - sfx.length) + sfx;
    i += 1;
  }
  return `${cand}.wav`;
}
