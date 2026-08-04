/**
 * circuit-card-map.ts — GENERATE the one map of the whole Circuit Tracks card.
 *
 * THE PROBLEM THIS SOLVES. "What is Pack 5 project 37?" and "where does Sugar
 * live?" were answerable only by reading six documents that disagreed with each
 * other and, in places, with the device. This emits ONE index that answers both
 * directions, and it emits it FROM THE PROJECT FILES so it cannot be stale by
 * more than one capture.
 *
 * WHY GENERATED AND NOT HAND-WRITTEN. A hand-maintained inventory drifts, and
 * this rig has already lost time to docs that contradicted the card. Every fact
 * that CAN be measured IS measured — see `_lib/circuit-card-scan.ts`, which owns
 * all of it. Only three things come from a human (what a project IS, which bars
 * it covers, and any tempo written to the device since the capture) and those
 * live in `_lib/circuit-card-roster.ts`, keyed by slot and ASSERTED against the
 * file's own name so a stale description announces itself instead of lying.
 *
 * This file owns PRESENTATION only: which columns, which wording, which
 * hazards get surfaced on the row rather than in a footnote.
 *
 * USAGE
 *   npx tsx scripts/circuit-card-map.ts                  # regenerate the map
 *   npx tsx scripts/circuit-card-map.ts --dir <capture>  # from another capture
 *   npx tsx scripts/circuit-card-map.ts --json           # machine-readable, no write
 *   npx tsx scripts/circuit-card-map.ts --stdout         # print the markdown
 *   npx tsx scripts/circuit-card-map.ts --no-xref        # skip the on-disk sha scan
 *
 * TOUCHES NO HARDWARE. Reads a capture directory and writes one markdown file.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { KIND_LABEL, type RosterEntry } from './_lib/circuit-card-roster.js';
import {
  PACKS, SLOTS_PER_PACK, buildRows, buildXref, diffByRegion, findDrift, nameGroups,
  type Drift, type Manifest, type Row,
} from './_lib/circuit-card-scan.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const CAPTURE = flag('--dir') ?? 'samples/circuit-ncs/card-backup-2026-07-27T16-49Z';
const OUT = flag('--out') ?? 'docs/_private/rig/circuit-card-map.md';
const XREF_ROOT = flag('--xref') ?? 'samples';
const USE_XREF = !argv.includes('--no-xref');
const AS_JSON = argv.includes('--json');
const TO_STDOUT = argv.includes('--stdout');

// ─── cells ──────────────────────────────────────────────────────────────────

const esc = (s: string): string => s.replace(/\|/g, '\\|');

function tempoCell(r: Row): string {
  const d = r.decoded;
  if (!d) return '';
  if (d.tempo < 0) return '?';
  const pc = r.roster?.postCapture;
  const wroteAfter = r.drift.some((x) => x.kind === 'pre-write backup') || r.postCaptureOnly;
  if (!wroteAfter) return `${d.tempo}`;
  if (pc?.bpm !== undefined) return `**${pc.bpm}** (capture: ${d.tempo})`;
  return `? (capture: ${d.tempo})`;
}

function contentCell(r: Row): string {
  const d = r.decoded;
  if (!d) return '';
  if (d.faults.length > 0) return '*not decoded — the file is corrupt*';
  if (d.tracks.length === 0) return '*nothing*';
  const chains = [...new Set(d.tracks.map((t) => t.chain).filter((c): c is string => c !== undefined))];
  const body = d.tracks.map((t) => `${t.label} ${t.count}`).join(' · ');
  return chains.length === 0 ? `${body} · *pat 1 only*` : `${body} · ${chains.join(' / ')}`;
}

function whatCell(r: Row): string {
  if (!r.decoded) return '';
  const e = r.roster;
  if (!e) return '*unclassified*';
  const bits: string[] = [`_${KIND_LABEL[e.kind]}_ — ${e.what.replace(/\.?$/, '.')}`];
  if (e.bars) bits.push(`Bars ${e.bars}.`);
  if (e.doc) bits.push(`[doc](${e.doc})`);
  return bits.join(' ');
}

/**
 * Hazards go HERE, on the slot's own row, not in a footnote. Looking up a slot
 * is the moment the warning is worth anything: "this one will sound if you
 * stomp into it" is useless three sections further down the page.
 */
function notesCell(r: Row): string {
  const parts: string[] = [];
  if (r.markers.length > 0) parts.push(r.markers.join(' '));
  if (r.roster?.hazard) parts.push(r.roster.hazard);
  const pc = r.roster?.postCapture;
  const wroteAfter = r.drift.some((x) => x.kind === 'pre-write backup') || r.postCaptureOnly === true;
  if (wroteAfter) {
    parts.push(pc?.bpm === undefined
      ? 'Written after this capture; what the tempo was set to is not recorded anywhere. See [How stale is this map](#how-stale-is-this-map).'
      : `Tempo set to **${pc.bpm}** after this capture (${pc.confidence}) — the corrected byte is on the device only. Source in [How stale is this map](#how-stale-is-this-map).`);
  }
  parts.push(...r.notes);
  return parts.join(' ');
}

/** Collapse runs of consecutive free slots so "where is there room" reads at a glance. */
function slotRows(rows: Row[], pack: number): string[] {
  const out: string[] = [];
  const packRows = rows.filter((r) => r.pack === pack);
  let i = 0;
  while (i < packRows.length) {
    const r = packRows[i];
    if (r.occupied) {
      out.push(`| **${r.slot}** | \`${esc(r.decoded?.name ?? '')}\` | ${esc(whatCell(r))} | ${tempoCell(r)} | ${esc(contentCell(r))} | ${esc(notesCell(r))} |`);
      i++;
      continue;
    }
    let j = i;
    while (j < packRows.length && !packRows[j].occupied) j++;
    const from = packRows[i].slot, to = packRows[j - 1].slot, n = j - i;
    const label = n === 1 ? `${from}` : `${from}-${to}`;
    out.push(`| ${label} | | *free${n === 1 ? '' : ` — ${n} contiguous`}* | | | |`);
    i = j;
  }
  return out;
}

function freeRuns(rows: Row[], pack: number): { from: number; to: number }[] {
  const runs: { from: number; to: number }[] = [];
  let cur: { from: number; to: number } | undefined;
  for (const r of rows.filter((x) => x.pack === pack)) {
    if (r.occupied) { if (cur) { runs.push(cur); cur = undefined; } continue; }
    if (cur) cur.to = r.slot; else cur = { from: r.slot, to: r.slot };
  }
  if (cur) runs.push(cur);
  return runs;
}

/** `['Pack 1 project 4', 'Pack 1 project 5']` → `Pack 1 projects 4-5`. */
function collapseWhere(where: string[]): string {
  const byPack = new Map<string, number[]>();
  for (const w of where) {
    const m = /^Pack (\d+) project (\d+)$/.exec(w);
    if (!m) return where.join(', ');
    byPack.set(m[1], [...(byPack.get(m[1]) ?? []), Number(m[2])]);
  }
  return [...byPack.entries()].map(([p, slots]) => `Pack ${p} ${rangeLabel(slots)}`).join('; ');
}

/** `[1,2,3,5]` → `projects 1-3, 5`. */
function rangeLabel(nums: number[]): string {
  const s = [...nums].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`);
    i = j + 1;
  }
  return `project${s.length > 1 ? 's' : ''} ${parts.join(', ')}`;
}

// ─── render ─────────────────────────────────────────────────────────────────

function render(captureDir: string, man: Manifest, rows: Row[], drift: Drift[]): string {
  const packName = new Map(man.packs.map((p) => [p.device_pack, p.pack_name]));
  const L: string[] = [];
  const now = new Date().toISOString();

  L.push('# Circuit Tracks card map — every project, every slot');
  L.push('');
  L.push('> **GENERATED FILE. Do not hand-edit — your edits will be overwritten.**');
  L.push('>');
  L.push(`> Generated \`${now}\` by \`scripts/circuit-card-map.ts\``);
  L.push(`> from capture \`${captureDir.replace(/\\/g, '/')}\`, taken \`${man.captured_at}\`.`);
  L.push('>');
  L.push('> Regenerate after the next card backup:');
  L.push('> `npx tsx scripts/circuit-card-map.ts --dir samples/circuit-ncs/<new-capture>`');
  L.push('');
  L.push('This is the index the other rig docs are not: **by slot** (what is Pack 5 project 37?) and');
  L.push('**by song** (where does Sugar live?), for all five packs and all 64 slots of each. It links out');
  L.push('rather than duplicating — the fuller story of a song, a groove or a pack lives in the docs it');
  L.push('points at.');
  L.push('');
  L.push('Everything measurable here is measured from the project files themselves: name, tempo, swing,');
  L.push('mixer levels, which tracks carry content, pattern chains, structural validity and bit-exact');
  L.push('duplicates. Only three things are hand-carried, in');
  L.push('[`scripts/_lib/circuit-card-roster.ts`](../../../scripts/_lib/circuit-card-roster.ts): what a');
  L.push('project IS, which bars it covers, and any tempo written to the device since the capture. Each of');
  L.push("those is keyed to the project's stored NAME, and a row whose name no longer matches is marked");
  L.push('**NAME MISMATCH** rather than quietly kept.');
  L.push('');

  // ── totals ──
  L.push('## Totals');
  L.push('');
  L.push('| Pack | Pack name | Occupied | Free | Longest free run |');
  L.push('|---|---|---:|---:|---|');
  for (let p = 1; p <= PACKS; p++) {
    const occ = rows.filter((r) => r.pack === p && r.occupied).length;
    const runs = freeRuns(rows, p);
    const longest = runs.reduce((a, b) => (b.to - b.from > a.to - a.from ? b : a), { from: 0, to: -1 });
    const n = longest.to - longest.from + 1;
    const longestLabel = longest.to < longest.from ? 'none'
      : n === 1 ? `1 slot (${longest.from}) — no two free slots adjacent`
        : `${n} slots (${longest.from}-${longest.to})`;
    L.push(`| Pack ${p} | \`${packName.get(p) ?? '?'}\` | ${occ} of ${SLOTS_PER_PACK} | ${SLOTS_PER_PACK - occ} | ${longestLabel} |`);
  }
  const totalOcc = rows.filter((r) => r.occupied).length;
  L.push(`| **All** | | **${totalOcc} of ${PACKS * SLOTS_PER_PACK}** | **${PACKS * SLOTS_PER_PACK - totalOcc}** | |`);
  L.push('');

  // ── legend ──
  L.push('## How to read a row');
  L.push('');
  L.push('**What it is** carries the category, and the categories are not interchangeable:');
  L.push('');
  L.push('| Category | Means |');
  L.push('|---|---|');
  L.push('| _song section_ | One part of a real multi-project arrangement. Repertoire. |');
  L.push('| _groove conversion (name GUESSED)_ | A drum groove from a purchased Mixwave pack. The pack ships its grooves **unnamed**; the titles are community **guesses** at the source song and can be wrong. **Not repertoire.** See [`groove-library.md`](groove-library.md). |');
  L.push('| _groove, hand-transcribed_ | A drum groove written by ear as a "recognizable starter". The name is honest about intent, not about the record. **Not repertoire.** |');
  L.push('| _test / scratch_ | Protocol or hardware test. Not music. |');
  L.push('| _unclassified_ | On the card, provenance recorded nowhere. |');
  L.push('');
  L.push('**Tempo** is the stored byte at `0x34` — the tempo the project plays at when it is loaded. Where');
  L.push('a bold value appears with `(capture: N)` behind it, the device was written after this capture was');
  L.push('taken and the bold number is what it was written to; see the row note for the source.');
  L.push('');
  L.push('**Content** counts note onsets per note track and hits per drum track, then gives the pattern');
  L.push('chain the device auto-advances through. `pat 1 only` means the track is unchained and loops its');
  L.push('first pattern forever.');
  L.push('');
  L.push('**Markers** appear at the front of the notes cell:');
  L.push('');
  const clean = rows.filter((r) => r.occupied && (r.decoded?.faults.length ?? 0) === 0).length;
  L.push('| Marker | Means |');
  L.push('|---|---|');
  L.push(`| **CORRUPT** | The file fails a structural check the other ${clean} projects pass. Its content is not decoded, because a corrupt file still decodes to plausible-looking nonsense. A CRC-verified backup entry does NOT rule this out: the device's transfer CRC covers the encoded stream, not the decoded file. |`);
  L.push('| **SILENT SYNTHS** | Both synth mixer levels are stored at 0 **and** the synth tracks carry notes. A correctly authored project in this state looks broken at the rig. |');
  L.push('| **SILENT DRUMS** | A drum track carries hits at mixer level 0 (a deliberate blend layer). |');
  L.push('| **TEMPO STALE** | The slot was written after this capture; the tempo column shows both values. |');
  L.push('| **NOT IN THE CAPTURE** | The project exists on the device but not in this backup. Never backed up. |');
  L.push('| **NAME MISMATCH** | The stored name no longer matches what the roster expected. Description unverified. |');
  L.push('| **NAME SHARED** | Another project on the card has the same name and different bytes. |');
  L.push('| **UNCLASSIFIED** | Occupied, and nothing records what it is. |');
  L.push('');
  L.push('Free slots are collapsed into runs (`13-32 — 20 contiguous`), because where there is *room for a');
  L.push('whole song* is the question a list of 20 identical blank rows answers worst.');
  L.push('');
  const zeroSynth = rows.filter((r) => r.occupied && r.decoded?.synthLevels[0] === 0 && r.decoded?.synthLevels[1] === 0);
  const zeroSynthAudible = zeroSynth.filter((r) => r.decoded?.tracks.some((t) => t.label.startsWith('Synth')));
  L.push(`**Card-wide, ${zeroSynth.length} projects store both synth mixer levels at 0** — the deliberate batch pass that`);
  L.push('silenced the internal synth voices so the Synth 1/2 tracks drive external gear over MIDI instead.');
  L.push(`Only the **${zeroSynthAudible.length}** of those that actually carry synth notes are marked, because those are the ones`);
  L.push('that will look broken when you select them and hear nothing.');
  L.push('');

  // ── by slot ──
  L.push('---');
  L.push('');
  L.push('## By slot');
  L.push('');
  L.push('Slot numbers are **device numbering**, 1-based, exactly as the unit displays them.');
  L.push('');
  for (let p = 1; p <= PACKS; p++) {
    const occ = rows.filter((r) => r.pack === p && r.occupied).length;
    L.push(`### Pack ${p} — \`${packName.get(p) ?? '?'}\` (${occ} of ${SLOTS_PER_PACK})`);
    L.push('');
    const runs = freeRuns(rows, p).filter((r) => r.to > r.from);
    const singles = freeRuns(rows, p).filter((r) => r.to === r.from).map((r) => r.from);
    L.push(runs.length > 0
      ? `Free runs: ${runs.map((r) => `**${r.from}-${r.to}** (${r.to - r.from + 1})`).join(', ')}${singles.length > 0 ? `; isolated free slots ${singles.join(', ')}` : ''}.`
      : `No free run longer than a single slot${singles.length > 0 ? `; isolated free slots ${singles.join(', ')}` : ''}.`);
    L.push('');
    L.push('| Slot | Name | What it is | Tempo | Content | Notes & hazards |');
    L.push('|---:|---|---|---:|---|---|');
    L.push(...slotRows(rows, p));
    L.push('');
  }

  // ── by song ──
  L.push('---');
  L.push('');
  L.push('## By song');
  L.push('');
  L.push('Where a whole song lives, in one line each. Only _song section_ rows are repertoire; the two');
  L.push('groove groups and the test projects are listed after, so a song title that appears there is not');
  L.push('mistaken for an arrangement.');
  L.push('');

  const songs = new Map<string, Row[]>();
  for (const r of rows) {
    const s = r.roster?.song;
    if (r.roster?.kind === 'song' && s) songs.set(s, [...(songs.get(s) ?? []), r]);
  }
  L.push('| Song | Artist | Where | Projects | Tempo | Doc |');
  L.push('|---|---|---|---:|---:|---|');
  const ordered = [...songs.entries()].sort((a, b) => a[1][0].pack - b[1][0].pack || a[1][0].slot - b[1][0].slot);
  for (const [title, group] of ordered) {
    const e0 = group[0].roster as RosterEntry;
    const packs = [...new Set(group.map((g) => g.pack))];
    const where = packs.map((p) => `Pack ${p} ${rangeLabel(group.filter((g) => g.pack === p).map((g) => g.slot))}`).join('; ');
    const tempos = [...new Set(group.map((g) => (g.roster?.postCapture?.bpm ?? g.decoded?.tempo)))];
    L.push(`| **${title}** | ${e0.artist ?? ''} | ${where} | ${group.length} | ${tempos.join(' / ')} | ${e0.doc ? `[${e0.doc}](${e0.doc})` : '*none*'} |`);
  }
  L.push('');

  for (const [heading, kind, blurb] of [
    ['Groove conversions — Mixwave, names are GUESSES', 'groove-mixwave', 'Not repertoire, and every name is an unverified attribution. Full provenance: [`groove-library.md`](groove-library.md).'],
    ['Grooves — hand-transcribed', 'groove-transcribed', 'Not repertoire. Recognizable starters, not note-perfect masters.'],
    ['Test / scratch projects', 'test', 'Not music.'],
    ['Unclassified', 'unknown', 'On the card, provenance recorded nowhere.'],
  ] as const) {
    const group = rows.filter((r) => r.roster?.kind === kind);
    if (group.length === 0) continue;
    L.push(`### ${heading}`);
    L.push('');
    L.push(blurb);
    L.push('');
    L.push('| Where | Name | Tempo |');
    L.push('|---|---|---:|');
    for (const r of group) {
      L.push(`| Pack ${r.pack} project ${r.slot} | \`${esc(r.decoded?.name ?? '')}\` | ${tempoCell(r)} |`);
    }
    L.push('');
  }

  // ── same name, different project ──
  const groups = nameGroups(rows);
  L.push('---');
  L.push('');
  L.push('## Same name, different project');
  L.push('');
  L.push('The device lets any number of projects carry the same 16-character name, and several here do.');
  L.push('**The name is not an identity.** Each group below is diffed byte-for-byte against its first');
  L.push('member and the differing bytes are reported by region, because "differs in two mixer bytes" and');
  L.push('"differs in 136 bytes of note data" are the same row on a name-only inventory and are not the');
  L.push('same situation at all.');
  L.push('');
  if (groups.length === 0) {
    L.push('No two projects on the card share a name.');
  }
  for (const [name, group] of groups) {
    const ref = group[0];
    L.push(`### \`${esc(name)}\` — ${group.length} copies`);
    L.push('');
    L.push('| Where | Differs from the first | Synth levels | Content |');
    L.push('|---|---|---|---|');
    for (const r of group) {
      let diffCell = '*(reference)*';
      if (r !== ref && r.bytes && ref.bytes) {
        const { total, byRegion } = diffByRegion(ref.bytes, r.bytes);
        diffCell = total === 0 ? '**identical**' : `**${total} bytes** — ${byRegion.map(([reg, n]) => `${n} ${reg}`).join(', ')}`;
      }
      L.push(`| Pack ${r.pack} project ${r.slot} | ${diffCell} | ${r.decoded?.synthLevels.join(' / ')} | ${esc(contentCell(r))} |`);
    }
    L.push('');
  }

  // ── drift ──
  L.push('---');
  L.push('');
  L.push('## How stale is this map');
  L.push('');
  L.push(`The capture was taken \`${man.captured_at}\`. Everything above is that snapshot, except where a row`);
  L.push('says otherwise.');
  L.push('');
  L.push('**The corrected tempo bytes are on the device and in no capture on disk.**');
  L.push('`circuit-set-project-tempo.ts` writes its `restore-tempo-*` backup *before* it patches the byte,');
  L.push('so those directories hold the **pre-write** image, and every one of them is sha256-identical to');
  L.push('this capture. That is enough to prove MECHANICALLY that a slot was written afterwards, and not');
  L.push('enough to read what it was written TO. So the bold tempo values in the table above are');
  L.push('hand-carried with a citation, and they are the only numbers in this document that are not read');
  L.push('off a file. Their sources:');
  L.push('');
  const sources = new Map<string, { bpm?: number; confidence: string; source: string; where: string[] }>();
  for (const r of rows) {
    const pc = r.roster?.postCapture;
    if (!pc || (r.drift.length === 0 && !r.postCaptureOnly)) continue;
    const k = `${pc.source}|${pc.bpm}`;
    const e = sources.get(k) ?? { bpm: pc.bpm, confidence: pc.confidence, source: pc.source, where: [] };
    e.where.push(`Pack ${r.pack} project ${r.slot}`);
    sources.set(k, e);
  }
  L.push('| Slots | Set to | Confidence | Source |');
  L.push('|---|---:|---|---|');
  for (const [, e] of sources) {
    L.push(`| ${collapseWhere(e.where)} | ${e.bpm ?? '?'} | ${e.confidence} | ${esc(e.source)} |`);
  }
  L.push('');
  L.push('`verified` means a doc records a device read-back of the landed value. `intended` means the');
  L.push('target was written down and the write is proven to have run, but nothing re-read the result.');
  L.push('');
  L.push('Every post-capture file on disk that names a pack and a slot:');
  L.push('');
  if (drift.length === 0) {
    L.push('None. No `.ncs` on disk postdates the capture.');
  } else {
    L.push('| Kind | Files | Slots it touches | What it proves |');
    L.push('|---|---:|---|---|');
    for (const kind of ['pre-write backup', 'other capture'] as const) {
      const g = drift.filter((d) => d.kind === kind);
      if (g.length === 0) continue;
      const where = [...new Set(g.map((d) => `Pack ${d.pack} project ${d.slot}`))];
      L.push(`| \`${kind === 'pre-write backup' ? 'restore-*' : 'other'}\` directories | ${g.length} | ${collapseWhere(where)} | ${kind === 'pre-write backup'
        ? 'a write ran after the capture; each file is the image taken **before** its patch, so it carries the OLD value'
        : 'a read of this slot postdating the backup'} |`);
    }
  }
  L.push('');
  L.push('One card backup closes the whole gap:');
  L.push('');
  L.push('```');
  L.push('npx tsx scripts/circuit-backup-card.ts');
  L.push('npx tsx scripts/circuit-card-map.ts --dir samples/circuit-ncs/<the-new-capture>');
  L.push('```');
  L.push('');
  L.push('Related: [`circuit-pack-inventory.md`](circuit-pack-inventory.md) (how the packs are organised and');
  L.push('why), [`circuit-card-backups.md`](circuit-card-backups.md) (the restore register),');
  L.push('[`groove-library.md`](groove-library.md) (the 18 grooves and their provenance),');
  L.push('[`SONG-COVERAGE-2026-07-27.md`](SONG-COVERAGE-2026-07-27.md) (what is repertoire and what is not),');
  L.push('[`songs/`](songs/) (the per-song documents).');
  L.push('');
  return L.join('\n');
}

// ─── main ───────────────────────────────────────────────────────────────────

function main(): void {
  const mp = join(CAPTURE, 'manifest.json');
  if (!existsSync(mp)) { console.error(`no manifest at ${mp}`); process.exit(2); }
  const man = JSON.parse(readFileSync(mp, 'utf8')) as Manifest;
  const drift = findDrift(CAPTURE, Date.parse(man.captured_at));
  const xref = buildXref(XREF_ROOT, CAPTURE, USE_XREF);
  const rows = buildRows(CAPTURE, man, drift, xref);

  if (AS_JSON) {
    const slim = rows.filter((r) => r.occupied).map(({ bytes, ...rest }) => rest);
    console.log(JSON.stringify({ capture: CAPTURE, captured_at: man.captured_at, drift, rows: slim }, undefined, 2));
    return;
  }

  const md = render(CAPTURE, man, rows, drift);
  if (TO_STDOUT) { console.log(md); return; }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, md, 'utf8');

  const occ = rows.filter((r) => r.occupied).length;
  const unclassified = rows.filter((r) => r.occupied && !r.roster);
  const mismatched = rows.filter((r) => r.roster && r.decoded && r.roster.name !== r.decoded.name);
  const corrupt = rows.filter((r) => (r.decoded?.faults.length ?? 0) > 0);
  console.log(`Wrote ${relative(process.cwd(), OUT).replace(/\\/g, '/')}`);
  console.log(`  capture     : ${CAPTURE} (${man.captured_at})`);
  console.log(`  projects    : ${occ} occupied of ${PACKS * SLOTS_PER_PACK}`);
  console.log(`  classified  : ${occ - unclassified.length} of ${occ}`);
  if (unclassified.length > 0) console.log(`  UNCLASSIFIED: ${unclassified.map((r) => `p${r.pack}/${r.slot}`).join(', ')}`);
  if (mismatched.length > 0) console.log(`  NAME MISMATCH: ${mismatched.map((r) => `p${r.pack}/${r.slot} "${r.decoded?.name}" != "${r.roster?.name}"`).join('; ')}`);
  if (corrupt.length > 0) console.log(`  CORRUPT     : ${corrupt.map((r) => `p${r.pack}/${r.slot}`).join(', ')}`);
  console.log(`  post-capture writes: ${drift.length} file(s) across ${new Set(drift.map((d) => `${d.pack}:${d.slot}`)).size} slot(s)`);
}

main();
