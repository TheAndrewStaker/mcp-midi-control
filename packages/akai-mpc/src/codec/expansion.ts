/**
 * MPC Expansion folder metadata: `Expansion.xml` and `SHA256SUMS`.
 *
 * Owns: the expansion descriptor (shaped like an Expansion Builder output) and
 * the checksum list a pack install verifies against. No file I/O here.
 */
import { xmlEscape } from './drumProgram.js';

export interface ExpansionInfo {
  /** Reverse-domain id, unique per expansion; it is also the ownership marker on the card. */
  identifier: string;
  title: string;
  manufacturer: string;
  description: string;
  /** Cover image file name inside the expansion folder. */
  img?: string;
}

/** `Expansion.xml` for a drum expansion. */
export function expansionXml(info: ExpansionInfo): string {
  return `<?xml version="1.0" encoding="UTF-8"?>

<expansion version="1.0.0.0" buildVersion="2.15.0.18">
  <local/>
  <identifier>${xmlEscape(info.identifier)}</identifier>
  <title>${xmlEscape(info.title)}</title>
  <manufacturer>${xmlEscape(info.manufacturer)}</manufacturer>
  <version>1.0.0.0</version>
  <type>drum</type>
  <priority>50</priority>
  <img>${xmlEscape(info.img ?? '')}</img>
  <description>${xmlEscape(info.description)}</description>
  <separator>-</separator>
</expansion>
`;
}

const SUMS_LINE = /^([0-9a-fA-F]{64}) [ *](.+)$/;

/**
 * `SHA256SUMS` text as a map of relative path to lowercase sha256.
 * Takes both sha256sum layouts: `<hash>  <path>` (text mode) and
 * `<hash> *<path>` (binary mode). A malformed line throws, naming it.
 */
export function parseSha256Sums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split(/\r\n|\n|\r/);
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    const m = SUMS_LINE.exec(line);
    if (m === null) {
      throw new SyntaxError(`SHA256SUMS line ${i + 1} is not '<sha256>  <path>': ${JSON.stringify(line.slice(0, 80))}`);
    }
    out.set(m[2], m[1].toLowerCase());
  });
  return out;
}

/** `SHA256SUMS` text (text-mode layout, LF line ends) from a path-to-hash map, in the map's order. */
export function formatSha256Sums(sums: ReadonlyMap<string, string>): string {
  let out = '';
  for (const [path, hash] of sums) out += `${hash.toLowerCase()}  ${path}\n`;
  return out;
}
