/**
 * Preflight gate: binds `docs/contributing/` to the registered device set.
 *
 * RATIONALE
 * ---------
 * Contribution guidance rots in exactly three ways, and each one has already
 * happened in this repo:
 *
 *   1. A device is registered and never gets a page, so its owners land
 *      nowhere. Ten of sixteen devices were in that state before this gate.
 *   2. A page's advertised support tier drifts away from the descriptor's own
 *      `capabilities.support_tier`, so the docs promise something the server
 *      does not.
 *   3. A doc links a file or a command that no longer exists (`docs/captures/`
 *      was dead for months; a renamed probe leaves a dead instruction on a
 *      public page).
 *
 * All three are mechanically checkable with no hardware, so they are checked
 * here rather than left to review. The oracle is the descriptor set itself,
 * imported the same way `packages/server-all/src/server/index.ts` imports it,
 * plus a source scan of that file so a newly registered device cannot slip past
 * this gate without being noticed.
 *
 * HARD FAILURES vs WARNINGS
 * -------------------------
 * Missing pages, orphan pages, malformed meta, page-vs-descriptor mismatch,
 * dead links and dead commands FAIL. A descriptor whose declared tier disagrees
 * with its own `verification` prose only WARNS: that is a judgement call about
 * what the product claims to users, and it belongs to the maintainer, not to a
 * lint.
 *
 * Run: npx tsx scripts/verify-contribution-guides.ts
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { AXEFX2_DESCRIPTOR, AX8_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import { AXEFXGEN1_DESCRIPTOR } from '@mcp-midi-control/fractal-gen1/descriptor.js';
import { MODERN_FRACTAL_DESCRIPTORS } from '@mcp-midi-control/fractal-gen3/device.js';
import { HYDRASYNTH_DESCRIPTOR } from '@mcp-midi-control/hydrasynth/descriptor.js';
import { CIRCUIT_TRACKS_DESCRIPTOR } from '@mcp-midi-control/circuit-tracks/descriptor.js';
import { SPD_SX_DESCRIPTOR } from '@mcp-midi-control/spd-sx/descriptor.js';
import { VE500_DESCRIPTOR } from '@mcp-midi-control/ve-500/descriptor.js';
import { MICROFREAK_DESCRIPTOR, MINIFREAK_DESCRIPTOR } from '@mcp-midi-control/arturia/descriptor.js';
import { RC_505_MK2_DESCRIPTOR, RC_600_DESCRIPTOR } from '@mcp-midi-control/boss-rc/descriptor.js';
import type { DeviceDescriptor } from '@mcp-midi-control/core/protocol-generic/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CONTRIB = path.join(ROOT, 'docs', 'contributing');
const DEVICE_DIR = path.join(CONTRIB, 'devices');
const HUB = path.join(CONTRIB, 'README.md');
const SERVER_INDEX = path.join(ROOT, 'packages', 'server-all', 'src', 'server', 'index.ts');
const REDIRECT_STUB = path.join(
  ROOT, 'packages', 'fractal-midi', 'docs', 'capture-guides', 'README.md',
);
const TEMPLATE = '_TEMPLATE.md';

let failures = 0;
let warnings = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) {
    failures++;
    console.log(`FAIL: ${label}${detail ? `\n  ${detail}` : ''}`);
  }
}

function warn(label: string, detail = ''): void {
  warnings++;
  console.log(`WARN: ${label}${detail ? `\n  ${detail}` : ''}`);
}

// ── The registered device set, imported exactly as server-all imports it ─────
//
// Keys are the identifiers server-all registers. The source scan below asserts
// this map and that file agree, so registering a device without teaching this
// gate about it is itself a failure.
const REGISTERED: Record<string, DeviceDescriptor | readonly DeviceDescriptor[]> = {
  MODERN_FRACTAL_DESCRIPTORS,
  AXEFXGEN1_DESCRIPTOR,
  AX8_DESCRIPTOR,
  AXEFX2_DESCRIPTOR,
  AM4_DESCRIPTOR,
  HYDRASYNTH_DESCRIPTOR,
  CIRCUIT_TRACKS_DESCRIPTOR,
  SPD_SX_DESCRIPTOR,
  VE500_DESCRIPTOR,
  MICROFREAK_DESCRIPTOR,
  MINIFREAK_DESCRIPTOR,
  RC_505_MK2_DESCRIPTOR,
  RC_600_DESCRIPTOR,
};

const ROSTER: DeviceDescriptor[] = Object.values(REGISTERED)
  .flatMap((v) => (Array.isArray(v) ? [...v] : [v as DeviceDescriptor]));
const ROSTER_IDS = new Set(ROSTER.map((d) => d.id));

const tierOf = (d: DeviceDescriptor): string => d.capabilities.support_tier ?? 'verified';
const transportOf = (d: DeviceDescriptor): string => d.transport?.kind ?? 'midi';
const presetClassOf = (d: DeviceDescriptor): string => d.preset_class ?? 'layout';

console.log(`contribution guides: ${ROSTER.length} registered devices`);

// ── 1. Registry drift: server-all's registrations match this gate's map ──────
{
  const src = readFileSync(SERVER_INDEX, 'utf8');
  const registered = new Set<string>();
  for (const m of src.matchAll(/registerMcpDevice\(\s*([A-Z][A-Z0-9_]*)\s*\)/g)) {
    registered.add(m[1]);
  }
  // The gen-3 family registers through a loop over its exported array.
  for (const m of src.matchAll(/for \(const \w+ of ([A-Z][A-Z0-9_]*)\)/g)) {
    if (m[1] in REGISTERED) registered.add(m[1]);
  }
  const known = new Set(Object.keys(REGISTERED));
  const unknown = [...registered].filter((n) => !known.has(n));
  const stale = [...known].filter((n) => !registered.has(n));
  check(
    'every descriptor registered by server-all is known to this gate',
    unknown.length === 0,
    unknown.length > 0
      ? `not in REGISTERED: ${unknown.join(', ')}. Add it here AND add docs/contributing/devices/<id>.md.`
      : '',
  );
  check(
    'this gate lists no descriptor server-all does not register',
    stale.length === 0,
    stale.length > 0 ? `registered here but not in server-all: ${stale.join(', ')}` : '',
  );
}

// ── 2. Every descriptor declares support_tier explicitly ─────────────────────
//
// Falling through the dispatcher default lands on the right answer by luck, and
// a future default change would move a device's advertised status silently.
for (const d of ROSTER) {
  check(
    `${d.id}: declares capabilities.support_tier explicitly`,
    d.capabilities.support_tier !== undefined,
    'inherits the dispatcher default instead of declaring its own tier',
  );
}

// ── 3/4. Page coverage and orphans ───────────────────────────────────────────
const pageFiles = existsSync(DEVICE_DIR)
  ? readdirSync(DEVICE_DIR).filter((f) => f.endsWith('.md'))
  : [];
const devicePages = pageFiles.filter((f) => f !== TEMPLATE);

check('docs/contributing/devices/ exists', existsSync(DEVICE_DIR));
check(`docs/contributing/devices/${TEMPLATE} exists`, pageFiles.includes(TEMPLATE));

for (const d of ROSTER) {
  check(
    `${d.id}: has docs/contributing/devices/${d.id}.md`,
    devicePages.includes(`${d.id}.md`),
    'every registered device gets a page; copy devices/_TEMPLATE.md',
  );
}
for (const f of devicePages) {
  const id = f.replace(/\.md$/, '');
  check(
    `devices/${f}: filename is a registered device id`,
    ROSTER_IDS.has(id),
    'orphan page: no descriptor with this id is registered',
  );
}

// ── Per-page structural checks ───────────────────────────────────────────────
const REQUIRED_HEADINGS = [
  '## Device',
  '## Support status',
  '## Confirmed on hardware',
  '## Blocked, and on what',
  '## Before you start',
  '## Asks, ranked',
  '## Submitting',
  '## When an ask closes',
] as const;

const META_KEYS = [
  'device_id', 'support_tier', 'transport', 'preset_class', 'owned_by_maintainer',
] as const;

const ASK_TIERS = ['REPORT', 'DONATE', 'PROBE', 'SESSION', 'CAPTURE'] as const;
const ASK_RE = /^### (REPORT|DONATE|PROBE|SESSION|CAPTURE)-(\d+): .+$/;

function parseMeta(body: string): Record<string, string> | undefined {
  const m = body.match(/<!--\s*contribution-meta\s*\n([\s\S]*?)-->/);
  if (m === undefined || m === null) return undefined;
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^\s*([a-z_]+):\s*(.+?)\s*$/);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

function checkHeadings(rel: string, body: string): void {
  // Trim BEFORE collecting, not just while testing. Filtering on `l.trim()` but
  // keeping the raw `l` meant a CRLF file collected '## Device\r', which then
  // failed the `missing` comparison against '## Device' and reported every
  // section absent on a page that had all of them. Contributors on Windows would
  // have hit this the first time they edited a page in an editor that writes
  // CRLF, and the error message ("missing: ...") points at the wrong problem.
  const found = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => REQUIRED_HEADINGS.includes(l as never));
  const missing = REQUIRED_HEADINGS.filter((h) => !found.includes(h));
  check(
    `${rel}: has all ${REQUIRED_HEADINGS.length} required H2 sections`,
    missing.length === 0,
    missing.length > 0 ? `missing: ${missing.join(' / ')}` : '',
  );
  if (missing.length > 0) return;
  const ordered = REQUIRED_HEADINGS.every((h, i) => found[i] === h);
  check(
    `${rel}: required H2 sections are in the canonical order`,
    ordered,
    ordered ? '' : `got: ${found.join(' -> ')}`,
  );
}

function checkAsks(rel: string, body: string): void {
  const lines = body.split('\n');
  const start = lines.indexOf('## Asks, ranked');
  if (start < 0) return;
  const seen = new Set<string>();
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('## ')) break;
    if (!line.startsWith('### ')) continue;
    const m = line.match(ASK_RE);
    check(
      `${rel}: ask heading is well formed`,
      m !== null,
      m === null ? `"${line.trim()}" must read "### TIER-n: title" (${ASK_TIERS.join('/')})` : '',
    );
    if (m === null) continue;
    const id = `${m[1]}-${m[2]}`;
    check(`${rel}: ask id ${id} is unique on the page`, !seen.has(id));
    seen.add(id);
    // The bold tier line sits directly beneath, allowing one blank line.
    const next = (lines[i + 1] ?? '').trim() === '' ? (lines[i + 2] ?? '') : (lines[i + 1] ?? '');
    check(
      `${rel}: ask ${id} has a tier line whose tier matches its id`,
      next.startsWith(`**Tier: ${m[1]}`),
      `expected a line starting "**Tier: ${m[1]}" under the heading, got: ${next.trim().slice(0, 70)}`,
    );
  }
}

// ── Walk every markdown file under docs/contributing/ ────────────────────────
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

const allDocs = existsSync(CONTRIB) ? walk(CONTRIB) : [];
const pkgScripts: Record<string, string> =
  JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts ?? {};

for (const abs of allDocs) {
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
  const body = readFileSync(abs, 'utf8');
  const isDevicePage = abs.startsWith(DEVICE_DIR) && path.basename(abs) !== TEMPLATE;

  // ── 15. No em dashes or en dashes anywhere in contributor-facing docs ──────
  const dashLine = body.split('\n').findIndex((l) => /[–—]/.test(l));
  check(
    `${rel}: no em or en dashes`,
    dashLine < 0,
    dashLine >= 0 ? `line ${dashLine + 1}: ${body.split('\n')[dashLine].trim().slice(0, 80)}` : '',
  );

  // ── 13. Relative links resolve ────────────────────────────────────────────
  for (const m of body.matchAll(/\]\(([^)]+)\)/g)) {
    const target = m[1].trim();
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const [file] = target.split('#');
    if (file === '') continue;
    const resolved = path.resolve(path.dirname(abs), file);
    check(
      `${rel}: link resolves -> ${target}`,
      existsSync(resolved),
      `no such file: ${path.relative(ROOT, resolved).replace(/\\/g, '/')}`,
    );
  }

  // ── 10. Cited commands resolve ────────────────────────────────────────────
  for (const m of body.matchAll(/npm run ([a-z0-9:_-]+)/g)) {
    check(
      `${rel}: cited "npm run ${m[1]}" is a real script`,
      m[1] in pkgScripts,
      'not a key in the root package.json scripts block',
    );
  }
  for (const m of body.matchAll(/npx tsx (scripts\/[A-Za-z0-9._/-]+\.ts)/g)) {
    check(
      `${rel}: cited "${m[1]}" exists`,
      existsSync(path.join(ROOT, m[1])),
    );
  }

  // Structure applies to every device page plus the template skeleton.
  if (isDevicePage || path.basename(abs) === TEMPLATE) {
    checkHeadings(rel, body);
    checkAsks(rel, body);
  }

  if (!isDevicePage) continue;

  // ── 5/6/7/8/9. Meta block binds the page to its descriptor ────────────────
  const id = path.basename(abs, '.md');
  const desc = ROSTER.find((d) => d.id === id);
  const meta = parseMeta(body);
  check(`${rel}: has a contribution-meta block`, meta !== undefined);
  if (meta === undefined || desc === undefined) continue;

  for (const key of META_KEYS) {
    check(`${rel}: contribution-meta declares ${key}`, meta[key] !== undefined);
  }
  check(
    `${rel}: contribution-meta device_id matches the filename`,
    meta.device_id === id,
    `meta says "${meta.device_id}"`,
  );
  check(
    `${rel}: support_tier matches the descriptor`,
    meta.support_tier === tierOf(desc),
    `page says "${meta.support_tier}", descriptor says "${tierOf(desc)}"`,
  );
  check(
    `${rel}: transport matches the descriptor`,
    meta.transport === transportOf(desc),
    `page says "${meta.transport}", descriptor says "${transportOf(desc)}"`,
  );
  check(
    `${rel}: preset_class matches the descriptor`,
    meta.preset_class === presetClassOf(desc),
    `page says "${meta.preset_class}", descriptor says "${presetClassOf(desc)}"`,
  );
}

// ── 12. The hub's device index table covers exactly the roster ───────────────
{
  const hub = readFileSync(HUB, 'utf8');
  const rows = new Map<string, string>();
  for (const line of hub.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    const link = cells.find((c) => /\]\(devices\/[a-z0-9-]+\.md\)/.test(c));
    if (link === undefined) continue;
    const idm = link.match(/\]\(devices\/([a-z0-9-]+)\.md\)/);
    const tier = cells.find((c) => /^`(verified|community-beta|generic-only)`$/.test(c));
    if (idm) rows.set(idm[1], tier?.replace(/`/g, '') ?? '(no tier cell)');
  }
  for (const d of ROSTER) {
    const tier = rows.get(d.id);
    check(
      `docs/contributing/README.md: index table has a row for ${d.id}`,
      tier !== undefined,
    );
    if (tier !== undefined) {
      check(
        `docs/contributing/README.md: ${d.id} tier cell matches the descriptor`,
        tier === tierOf(d),
        `table says "${tier}", descriptor says "${tierOf(d)}"`,
      );
    }
  }
  for (const id of rows.keys()) {
    check(
      `docs/contributing/README.md: index row "${id}" is a registered device`,
      ROSTER_IDS.has(id),
    );
  }
}

// ── 14. The old location stays a redirect stub, not a second source of truth ─
{
  const stub = readFileSync(REDIRECT_STUB, 'utf8');
  const lines = stub.split('\n').length;
  check(
    'capture-guides/README.md is still a short redirect stub',
    lines <= 40,
    `${lines} lines; it must not regrow into a second source of truth`,
  );
  check(
    'capture-guides/README.md carries no ask headings',
    !/^#{2,3} .*\b(Asks|Ask|T\d|C\d)\b/m.test(stub),
    'asks belong on docs/contributing/devices/<id>.md',
  );
  check(
    'capture-guides/README.md points at the new home',
    stub.includes('docs/contributing/'),
  );
}

// ── WARN-only: descriptor tier vs its own verification prose ─────────────────
//
// Deliberately NOT a hard failure. Changing an advertised tier changes what the
// product claims to users, which is a maintainer decision, not a lint's.
// A NEGATED mention does not count. The RC-600's prose says its PC offset is
// "carried from the mk2's hardware-confirmed sibling behavior ... NOT
// independently confirmed on an RC-600 unit", which is the descriptor being
// careful, not contradicting itself. Flagging that trains the reader to ignore
// the warning, which costs more than the warning is worth.
const NEGATED = /\b(not|never|no)\b[^.]{0,80}\bconfirmed\b|\bconfirmed\b[^.]{0,40}\b(sibling|carried from)\b/i;

for (const d of ROSTER) {
  const v = d.capabilities.verification ?? '';
  const hit = v.match(/.{0,70}hardware-confirmed.{0,70}/i);
  if (tierOf(d) === 'generic-only' && hit !== null && !NEGATED.test(hit[0])) {
    warn(
      `${d.id}: declared support_tier "generic-only" but its own verification prose says hardware-confirmed`,
      `prose: "...${hit[0].trim()}..."\n  Resolve in the descriptor (either the tier or the prose is wrong). `
      + 'The device page reports both as written and does not pick a side.',
    );
  }
}

console.log(
  failures === 0
    ? `\ncontribution guides OK (${ROSTER.length} devices, ${devicePages.length} pages, ${warnings} warning(s))`
    : `\n${failures} contribution-guide check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
