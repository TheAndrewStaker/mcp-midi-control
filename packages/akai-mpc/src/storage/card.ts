/**
 * The MPC's card (or drive) as a mounted volume: find it, list the projects on
 * it, and read one project's sequences. Read-only. Nothing here writes.
 *
 * The card is recognised by its two top-level folders, `Projects` and
 * `Expansions`, which the MPC creates and which no ordinary drive carries
 * together. `MCP_MPC_CARD_ROOT` names the root outright and wins.
 *
 * The MPC's INTERNAL storage carries the same two folders one level down, in
 * `MPC Documents/`. It mounts on the computer beside the card while the MPC is
 * in Controller Mode (seen on a One G2, MPC OS 3.9.1). Both volumes are read;
 * a project on the internal storage has a location that starts `internal:`.
 * There is nothing over USB that names the volumes: they are ordinary mounted
 * drives, found by their folder layout.
 *
 * A project is a folder that holds a `.xpj` file. Projects live under
 * `Projects/`, sometimes one group folder down (`Projects/Songs/<project>/`),
 * so the scan goes two levels below `Projects/` and no further. A project's
 * LOCATION is its folder path relative to `Projects/`, with forward slashes:
 * `Songs/Song Title (Artist)`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { parseXpj, summarizeXpj, type XpjSummary } from '../codec/project.js';

export const MPC_CARD_ROOT_ENV = 'MCP_MPC_CARD_ROOT';
const PROJECTS_DIR = 'Projects';
const EXPANSIONS_DIR = 'Expansions';
const INTERNAL_DIR = 'MPC Documents';
/** Location prefix of a project on the MPC's internal storage. */
export const INTERNAL_PREFIX = 'internal:';

export type MpcVolume = 'card' | 'internal';
export interface MpcRoot {
  /** The folder that holds `Projects` and `Expansions`. */
  root: string;
  volume: MpcVolume;
}

const isDir = (p: string): boolean => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};

/** True when `root` carries both folders the MPC keeps at the top of its card. */
export function isMpcCardRoot(root: string): boolean {
  return isDir(join(root, PROJECTS_DIR)) && isDir(join(root, EXPANSIONS_DIR));
}

function mounts(): string[] {
  if (process.platform === 'win32') {
    // D..Z: C: is the system disk and never the card.
    return Array.from({ length: 23 }, (_x, i) => `${String.fromCharCode(68 + i)}:\\`);
  }
  const out: string[] = [];
  for (const base of ['/Volumes', '/media', '/mnt', '/run/media']) {
    try {
      for (const name of readdirSync(base)) out.push(join(base, name));
    } catch { /* not on this platform */ }
  }
  return out;
}

/** Every mounted MPC volume: cards first, then internal storage. The env override names one root and wins. */
export function resolveMpcRoots(): MpcRoot[] {
  const override = process.env[MPC_CARD_ROOT_ENV];
  if (override !== undefined && override.trim() !== '') {
    return isMpcCardRoot(override.trim()) ? [{ root: override.trim(), volume: 'card' }] : [];
  }
  const cards: MpcRoot[] = [];
  const internal: MpcRoot[] = [];
  for (const mount of mounts()) {
    if (!existsSync(mount)) continue;
    if (isMpcCardRoot(mount)) cards.push({ root: mount, volume: 'card' });
    else if (isMpcCardRoot(join(mount, INTERNAL_DIR))) internal.push({ root: join(mount, INTERNAL_DIR), volume: 'internal' });
  }
  return [...cards, ...internal];
}

/** The first mounted MPC volume (a card when there is one), or undefined when none is mounted. */
export function resolveMpcCardRoot(): string | undefined {
  return resolveMpcRoots()[0]?.root;
}

export interface CardProject {
  /** Folder path relative to `Projects/`, forward slashes. What `get_preset` takes. */
  location: string;
  /** The project's name: its `.xpj` filename without the extension. */
  name: string;
  /** The `.xpj` path relative to `Projects/`. */
  file: string;
  /** The volume root this project was found under. */
  root: string;
  volume: MpcVolume;
}

function xpjsIn(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.xpj')).sort();
  } catch {
    return [];
  }
}

/** Every project on the card, sorted by location. */
export function listCardProjects(root: string, volume: MpcVolume = 'card'): CardProject[] {
  const base = join(root, PROJECTS_DIR);
  const out: CardProject[] = [];
  const prefix = volume === 'internal' ? INTERNAL_PREFIX : '';
  const add = (location: string, name: string, file: string): void => {
    out.push({ location: `${prefix}${location}`, name, file, root, volume });
  };
  const visit = (rel: string, depth: number): void => {
    const dir = rel === '' ? base : join(base, rel);
    const xpjs = xpjsIn(dir);
    if (rel === '') {
      // Projects saved straight into Projects/ (the MPC's default on its
      // internal storage). The group folders beside them are still walked.
      for (const f of xpjs) add(f.slice(0, -4), f.slice(0, -4), f);
    } else if (xpjs.length === 1) {
      add(rel, xpjs[0].slice(0, -4), `${rel}/${xpjs[0]}`);
      return;
    } else if (xpjs.length > 1) {
      // A folder of loose projects: each file is its own project.
      for (const f of xpjs) add(`${rel}/${f.slice(0, -4)}`, f.slice(0, -4), `${rel}/${f}`);
      return;
    }
    if (depth >= 2) return;
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      // A project keeps its samples in "<name>_[ProjectData]"; that is content, not a project.
      if (name.startsWith('.') || name.endsWith('_[ProjectData]')) continue;
      const next = rel === '' ? name : `${rel}/${name}`;
      if (isDir(join(base, next))) visit(next, depth + 1);
    }
  };
  visit('', 0);
  // Code-point order, so the list positions are the same on every machine.
  return out.sort((a, b) => (a.location < b.location ? -1 : a.location > b.location ? 1 : 0));
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Every project on every mounted MPC volume: the card's first, then the internal storage's. */
export function listMpcProjects(roots: readonly MpcRoot[]): CardProject[] {
  return roots.flatMap((r) => listCardProjects(r.root, r.volume));
}

/**
 * Pick one project by location, by its 1-based position in the listing, or by
 * name. Returns the candidates instead when the query does not settle on one.
 */
export function findCardProject(projects: readonly CardProject[], query: string | number): CardProject | { candidates: string[] } {
  if (typeof query === 'number' || /^\d+$/.test(String(query).trim())) {
    const hit = projects[Number(query) - 1];
    return hit ?? { candidates: projects.slice(0, 20).map((p) => p.location) };
  }
  const raw = String(query).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\.xpj$/i, '');
  const exact = projects.filter((p) => p.location === raw || p.file.slice(0, -4) === raw);
  if (exact.length === 1) return exact[0];
  // A path given from somewhere below Projects/ ("Song Title (Artist)/Song
  // Title", as a song book names its project): match it as the tail of a path.
  const tail = projects.filter((p) => p.location.endsWith(`/${raw}`) || p.file.slice(0, -4).endsWith(`/${raw}`));
  if (tail.length === 1) return tail[0];
  const q = norm(raw);
  const same = projects.filter((p) => norm(p.location) === q || norm(p.name) === q);
  if (same.length === 1) return same[0];
  const partial = same.length > 1 ? same : projects.filter((p) => q !== '' && (norm(p.name).includes(q) || norm(p.location).includes(q)));
  if (partial.length === 1) return partial[0];
  return { candidates: (partial.length > 0 ? partial : projects).slice(0, 20).map((p) => p.location) };
}

/** Read and summarise one project file. Throws SyntaxError when it is not an MPC project. */
export function readCardProject(root: string, project: CardProject): XpjSummary {
  return summarizeXpj(parseXpj(readFileSync(join(project.root ?? root, PROJECTS_DIR, project.file))));
}
