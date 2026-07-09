/**
 * Boss RC-family `.RC0` memory-file codec PROTOTYPE (step 3 of the RC-505mk2
 * plan). Structure-preserving parse + byte-exact serialize + path-addressable
 * surgical leaf edit, validated against the real sibling corpus
 * (RC-600 / RC-505 mk1 / RC-500) in `samples/rc505mk2-oracle/`.
 *
 * WHY THIS SHAPE. Every RC `.RC0` is line-oriented XML: one `<Tag>value</Tag>`
 * per line, container open/close tags on their own lines, a `<database>`
 * envelope, and an opaque trailing region after `</database>` (RC-600 carries
 * `<count>HHHH</count>` with NO final newline; the mk1/RC-500 end at
 * `</database>\n` with no count). Because the whole file is lines joined by
 * `\n`, `text.split('\n')` -> `lines.join('\n')` reproduces ANY file
 * byte-for-byte regardless of tag dialect (named `<PlyLvl>` vs single-letter
 * `<A>`), indentation scheme, or trailing region. So round-trip fidelity is
 * structural and dialect-agnostic; the only per-dialect knowledge needed is the
 * tag-letter dictionary for AUTHORING specific fields, which the codec does not
 * hardcode - it addresses leaves by PATH so read-modify-write preserves every
 * other byte (the same byte-exact discipline as the SPD-SX `.spd` codec).
 *
 * This is a prototype under scripts/_research; when a real RC-505mk2 file pins
 * the `[mk2?]` schema deltas (see docs/manuals/other-gear/RC-505mk2-RC0-SCHEMA.md
 * section 6) it moves to packages/rc-505/src/codec/rc0.ts and gains the mk2
 * field dictionary + a committed round-trip golden.
 */

export interface Rc0Leaf {
  /** Index into `Rc0Doc.lines` of this leaf's line. */
  readonly lineIndex: number;
  /** Exact leading whitespace of the line (preserved on edit). */
  readonly indent: string;
  /** Element tag (e.g. 'A', 'PlyLvl', 'C01'). */
  readonly tag: string;
  /** Current text value (integer or, for <count>, a hex string). */
  value: string;
  /** '/'-joined address, e.g. 'database/mem#0/TRACK1/D'. */
  readonly path: string;
}

export interface Rc0Doc {
  /** The file as lines (split on '\n'); join('\n') is byte-exact to the source. */
  readonly lines: string[];
  /** Every parsed leaf, in file order. */
  readonly leaves: Rc0Leaf[];
  /** Leaf lookup by path. */
  readonly byPath: Map<string, Rc0Leaf>;
}

const LEAF_RE = /^(\s*)<([A-Za-z0-9_#]+)>([^<]*)<\/\2>$/;
const CLOSE_RE = /^\s*<\/([A-Za-z0-9_#]+)>$/;
const OPEN_RE = /^\s*<([A-Za-z0-9_#]+)((?:\s+[A-Za-z0-9_#:.-]+="[^"]*")*)\s*>$/;

interface Frame {
  segment: string;
  /** occurrence counter for each distinct child base-segment, for disambiguation */
  readonly childCounts: Map<string, number>;
}

/** Give a base segment a `~N` suffix if it repeats among its siblings. */
function disambiguate(parentCounts: Map<string, number>, base: string): string {
  const seen = parentCounts.get(base) ?? 0;
  parentCounts.set(base, seen + 1);
  return seen === 0 ? base : `${base}~${seen}`;
}

function attrId(attrs: string): string | undefined {
  const m = /\bid="([^"]*)"/.exec(attrs);
  return m ? m[1] : undefined;
}

/**
 * Parse `.RC0` text into a structure-preserving document. Never throws on
 * unrecognized lines (they are retained verbatim in `lines` and simply not
 * indexed as leaves), so serialize() is always byte-exact even if a dialect
 * carries a line shape this parser does not model.
 */
export function parseRc0(text: string): Rc0Doc {
  const lines = text.split('\n');
  const leaves: Rc0Leaf[] = [];
  const byPath = new Map<string, Rc0Leaf>();
  // Root frame holds top-level (outside <database>) child disambiguation.
  const stack: Frame[] = [{ segment: '', childCounts: new Map() }];

  const parentPath = (): string => stack.map((f) => f.segment).filter(Boolean).join('/');
  const parentCounts = (): Map<string, number> => stack[stack.length - 1].childCounts;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const leaf = LEAF_RE.exec(line);
    if (leaf) {
      const [, indent, tag, value] = leaf;
      const seg = disambiguate(parentCounts(), tag);
      const base = parentPath();
      const path = base ? `${base}/${seg}` : seg;
      const node: Rc0Leaf = { lineIndex: i, indent, tag, value, path };
      leaves.push(node);
      byPath.set(path, node);
      continue;
    }

    const close = CLOSE_RE.exec(line);
    if (close) {
      if (stack.length > 1) stack.pop();
      continue;
    }

    const open = OPEN_RE.exec(line);
    if (open) {
      const [, tag, attrs] = open;
      const id = attrId(attrs);
      const base = id !== undefined ? `${tag}#${id}` : tag;
      const seg = disambiguate(parentCounts(), base);
      stack.push({ segment: seg, childCounts: new Map() });
      continue;
    }
    // Unrecognized line (xml decl, blank, unusual shape): retained, not indexed.
  }

  return { lines, leaves, byPath };
}

/** Re-serialize a document. Byte-exact to the source when unedited. */
export function serializeRc0(doc: Rc0Doc): string {
  return doc.lines.join('\n');
}

/** Read a leaf's current value by path, or undefined if absent. */
export function getLeaf(doc: Rc0Doc, path: string): string | undefined {
  return doc.byPath.get(path)?.value;
}

/**
 * Surgically set ONE leaf's value, rewriting only that line and leaving every
 * other byte untouched (read-modify-write authoring). The new line reuses the
 * leaf's exact indent + tag, so the file round-trips byte-for-byte except the
 * single changed value.
 */
export function setLeaf(doc: Rc0Doc, path: string, value: string | number): void {
  const leaf = doc.byPath.get(path);
  if (!leaf) throw new Error(`setLeaf: no leaf at path '${path}'`);
  const v = String(value);
  doc.lines[leaf.lineIndex] = `${leaf.indent}<${leaf.tag}>${v}</${leaf.tag}>`;
  leaf.value = v;
}

/** List leaf paths under a prefix (e.g. all fields of a section), in file order. */
export function leavesUnder(doc: Rc0Doc, prefix: string): Rc0Leaf[] {
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return doc.leaves.filter((l) => l.path.startsWith(p));
}

/**
 * Decode a char-code name section (NAME with `<A..L>` on RC-600/mk2 or
 * `<C01..C12>` on RC-500) to a string. Codes < 32 or > 126 render as '' so a
 * space(32)/NUL(0)-padded field trims cleanly. Demo/authoring helper.
 */
export function decodeCharCodes(doc: Rc0Doc, sectionPath: string): string {
  return leavesUnder(doc, sectionPath)
    .map((l) => Number.parseInt(l.value, 10))
    .map((c) => (c >= 32 && c <= 126 ? String.fromCharCode(c) : ''))
    .join('')
    .replace(/\s+$/u, '');
}
