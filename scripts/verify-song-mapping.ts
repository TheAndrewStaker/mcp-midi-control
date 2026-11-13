/**
 * Check that a song's claimed patch mapping matches what the devices actually
 * hold.
 *
 * The gap this closes: every song->patch mapping in this project lives in
 * markdown prose that NOTHING reads. When the MicroFreak's 512 slots were
 * category-sorted on 2026-08-15, every slot number in every song doc became
 * wrong at once and no check noticed; the one that was caught (Clint's
 * "Nostromo", 39 -> 163) was caught by hand. A song doc that names a slot is
 * making a testable claim about hardware, so it should be tested.
 *
 * Claims live in `docs/_private/rig/song-mappings.json`, not in the prose:
 * parsing free-form markdown for slot numbers is fragile, and this repo has
 * twice settled on manifest-as-source-of-truth instead (circuit-card-map,
 * setlist-sync). Only `status: "confirmed"` claims are gated; `proposed` and
 * `owed` are reported so an unfinished mapping is visible without failing.
 *
 * `assignments[]` rows (BK-SONG-LAYER (b), added 2026-08-22) are checked too:
 *   - `am4_scene_pc` rows read back `preset.scene_N_midi_{1..4}_{type,channel,
 *     value}` over the wire and require SOME slot of the claimed scene to send
 *     PC {pc} on ch{channel}. Scene-MIDI params live on the ACTIVE preset, so
 *     rows verify only while the AM4 sits on the claimed location — this gate
 *     is read-only and will NOT navigate the device; other presets' rows are
 *     reported SKIPPED with a load-and-re-run hint.
 *   - `recall` rows get a static addressing-arithmetic check where the rig's
 *     rule is known (Hydrasynth "A015" -> PC 14; MicroFreak slot 163 -> bank
 *     MSB 1 + PC 34). No wire traffic; a confirmed row with wrong numbers
 *     fails.
 *   - `channel` rows have no device-readable truth (the Circuit's track ->
 *     channel wiring is not queryable), so they are echoed as recorded facts.
 *
 * Reads hardware. Read-only: name scans, pack directory reads, and single
 * parameter reads — no writes, no preset navigation.
 * A device that is not connected is reported as SKIPPED, not failed, so this
 * is useful with whatever is plugged in.
 *
 * Run:
 *   npx tsx scripts/verify-song-mapping.ts                 # every song
 *   npx tsx scripts/verify-song-mapping.ts --song redbone  # one song
 *   npx tsx scripts/verify-song-mapping.ts --json out.json # capture the scan
 *
 * Exit 1 on any mismatch of a confirmed claim.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { MICROFREAK_DESCRIPTOR } from '../packages/arturia/src/descriptor.js';
import { HYDRASYNTH_DESCRIPTOR } from '../packages/hydrasynth/src/descriptor.js';
import { CIRCUIT_TRACKS_DESCRIPTOR } from '../packages/circuit-tracks/src/descriptor.js';
import { AM4_DESCRIPTOR } from '../packages/am4/src/descriptor.js';
import { SPD_SX_DESCRIPTOR } from '../packages/spd-sx/src/descriptor.js';
import { VE500_DESCRIPTOR } from '../packages/ve-500/src/descriptor.js';
import { parseAm4Location } from '../packages/am4/src/descriptor/schema.js';
import { sendReadAndParse } from '../packages/am4/src/shared/readOps.js';
import { formatLocationDisplay } from 'fractal-midi/am4';
import { getProjectName, PROJECT_NAME_LEN } from '../packages/circuit-tracks/src/ncs/format.js';
import { withEndpoint } from '../packages/core/src/protocol-generic/dispatcher/core.js';
import { closeAllMidiConnections } from '../packages/core/src/midi/transport.js';
import type { DeviceDescriptor, DispatchCtx } from '../packages/core/src/protocol-generic/types.js';

const MAPPINGS = process.env.SONG_MAPPINGS
  ?? path.join(process.cwd(), 'docs', '_private', 'rig', 'song-mappings.json');

interface Claim {
  device: string;
  /**
   * Absent slot = the pick is OWED: the song needs this voice but nobody has
   * chosen a patch yet (BK-VOICES-FILING, 2026-08-24). Such rows are reported
   * as notes and never scanned — there is nothing on the device to check.
   */
  slot?: number | string;
  pack?: number;
  expected_name?: string;
  role?: string;
  status: 'confirmed' | 'proposed' | 'owed';
}

/**
 * `assignments[]` rows (see the manifest's `_schema`). The array also holds
 * bare `{ _note }` objects with no `kind` — annotation rows, not claims —
 * so every field except `kind` is read defensively.
 */
interface Assignment {
  kind?: 'channel' | 'recall' | 'am4_scene_pc';
  status?: 'confirmed' | 'proposed' | 'owed';
  device?: string;
  channel?: number;
  part?: string;
  // recall
  pc?: number;
  bank_msb?: number;
  bank_lsb?: number;
  target_slot?: number | string;
  // am4_scene_pc
  am4_preset?: string;
  scene?: number;
  _note?: string;
}
interface SongEntry { song: string; artist?: string; claims: Claim[]; assignments?: Assignment[] }

const DESCRIPTORS: Record<string, DeviceDescriptor> = {
  microfreak: MICROFREAK_DESCRIPTOR,
  hydrasynth: HYDRASYNTH_DESCRIPTOR,
  'circuit-tracks': CIRCUIT_TRACKS_DESCRIPTOR,
  am4: AM4_DESCRIPTOR,
  // Kit claims ride the same scanLocations path as everything else, but the
  // SPD-SX's scanner is STORAGE, not MIDI: it reads the mounted WAVE-MGR
  // drive, so kit rows verify only while the device is in that mode.
  'spd-sx': SPD_SX_DESCRIPTOR,
  // The VE-500 cannot report stored memory names (no scanLocations — the
  // device has no whole-patch or name read), so its claims are permanently
  // recorded-only. Registered so the skip says THAT instead of pretending
  // the device is unknown to this gate.
  've-500': VE500_DESCRIPTOR,
};

/**
 * Circuit Tracks' `scanLocations` reports the on-card FILENAME from the pack
 * directory, NOT the project name the front panel shows. Redbone's slots are
 * files called `24_SESSION.ncs`..`31_SESSION.ncs` while their embedded names
 * read "Redbone 1 Intro"..  -- so a directory scan says a fully-built song is
 * absent. That exact mistake was made on 2026-08-15, against this very song.
 *
 * So for Circuit claims this gate does NOT trust the scan: it pulls the
 * project and reads the name out of the bytes, which is what the device
 * displays. That is ~160 KB per slot, far too slow to sweep 64 of them, which
 * is why `scanLocations` cannot simply be changed to do it -- but a gate
 * checking a handful of named slots can afford it.
 */
// Use the codec's own decoder. Re-implementing it here (an earlier version did)
// made this a FOURTH copy, and it copied the wrong one: `descriptor/reader.ts`'s
// `decodeProjectName` reads 16 bytes while `ncs/format.ts` documents the field
// as 32 (`0x10..0x2F`, hardware-proven by an on-device rename). Those two
// shipped decoders still disagree, which is worth settling separately; this
// gate defers to `format.ts`.

/** Read the embedded names of specific Circuit slots, one project pull each. */
async function readCircuitNames(claims: readonly Claim[]): Promise<Map<string, string> | string> {
  const d = CIRCUIT_TRACKS_DESCRIPTOR;
  const dump = d.reader.dumpStoredPresetBinary;
  if (dump === undefined) return 'Circuit Tracks has no dumpStoredPresetBinary';
  const out = new Map<string, string>();
  try {
    for (const c of claims) {
      if (c.slot === undefined) continue; // owed pick, nothing on the card to pull
      const slot = Number(c.slot);
      const res = await withEndpoint(d, async (ctx: DispatchCtx) => dump(slot, ctx),
        { ...(c.pack !== undefined ? { pack: c.pack - 1 } : {}), opName: 'verify-song-mapping' });
      // Prefer the reader's own decode; fall back to the raw field if absent.
      out.set(`${c.pack ?? ''}|${String(c.slot)}`, res.name ?? getProjectName(res.bytes));
    }
  } catch (err) {
    return err instanceof Error ? err.message.split('\n')[0]! : String(err);
  }
  return out;
}

type Outcome = { claim: Claim; song: string; state: 'ok' | 'mismatch' | 'skipped' | 'unreadable' | 'unfiled'; got?: string; detail?: string };

type AssignmentOutcome = {
  song: string;
  assignment: Assignment;
  state: 'ok' | 'mismatch' | 'skipped' | 'unverifiable' | 'recorded';
  detail?: string;
};

// ── AM4 scene-MIDI read-back (`am4_scene_pc` rows) ──────────────────

/** Mirrors reader.ts's active-location state register (0x00ce/0x000a). */
const AM4_LOCATION_PID_LOW = 0x00ce;
const AM4_LOCATION_PID_HIGH = 0x000a;

type SceneSlotRead = { type: string; channel: number; value: number };

/**
 * One AM4 session for every `am4_scene_pc` row: read the active-location
 * register, then — only for rows whose claimed preset IS the active one —
 * read that scene's four MIDI slots (12 `preset.scene_N_midi_M_*` params,
 * ~50 ms each). Scene-MIDI params live on the active preset and this gate
 * never navigates, so rows for other presets stay unread here and the
 * caller reports them SKIPPED with a load-and-re-run hint.
 *
 * Returns a skip-reason string when the AM4 itself is not readable.
 */
async function readAm4SceneMidi(
  rows: readonly Assignment[],
): Promise<{ current?: string; scenes: Map<string, SceneSlotRead[]> } | string> {
  const d = AM4_DESCRIPTOR;
  try {
    return await withEndpoint(d, async (ctx: DispatchCtx) => {
      const parsed = await sendReadAndParse(ctx.conn, AM4_LOCATION_PID_LOW, AM4_LOCATION_PID_HIGH);
      const idx = parsed.asUInt32LE();
      const current = idx >= 0 && idx <= 103 ? formatLocationDisplay(idx) : undefined;
      const scenes = new Map<string, SceneSlotRead[]>();
      for (const row of rows) {
        if (row.am4_preset === undefined || row.scene === undefined) continue;
        // Match by PARSED location index, never by string: the display
        // formatter is unpadded ("A1") while the manifest files canonical
        // zero-padded codes ("A01"), so a string compare skips forever
        // (review finding, 2026-08-22). parseAm4Location accepts both.
        if (current === undefined || parseAm4Location(row.am4_preset) !== idx) continue;
        const key = `${row.am4_preset}|${row.scene}`;
        if (scenes.has(key)) continue;
        const slots: SceneSlotRead[] = [];
        for (let m = 1; m <= 4; m++) {
          const read = async (field: string) =>
            (await d.reader.getParam(ctx, 'preset', `scene_${row.scene}_midi_${m}_${field}`)).display_value;
          slots.push({
            type: String(await read('type')),
            channel: Number(await read('channel')),
            value: Number(await read('value')),
          });
        }
        scenes.set(key, slots);
      }
      return { ...(current !== undefined ? { current } : {}), scenes };
    }, { opName: 'verify-song-mapping' });
  } catch (err) {
    return err instanceof Error ? err.message.split('\n')[0]! : String(err);
  }
}

/** True when the string parses as a real AM4 location ("A01".."Z04"). */
function isAm4Location(loc: string): boolean {
  try {
    parseAm4Location(loc);
    return true;
  } catch {
    return false;
  }
}

// ── Static addressing-arithmetic checks (`recall` rows) ─────────────

/**
 * Check a recall row's wire numbers against the device's addressing rule,
 * with no wire traffic. Returns undefined when the rule for that device is
 * not modeled or the row lacks the fields (reported as recorded-only).
 *
 * Rules (both hardware-confirmed on this rig, see SONG-PATCH-REGISTRY.md
 * "THE TWO OFF-BY-ONES"):
 *   - hydrasynth: "A015" -> PC 14 (bank letter -> bank LSB 0..7; the wire
 *     PC is the patch number minus one).
 *   - microfreak: slot 163 -> bank MSB 1, PC 34 (0-based across 128-slot
 *     banks: MSB = (slot-1) div 128, PC = (slot-1) mod 128).
 */
function checkRecallArithmetic(a: Assignment): { ok: boolean; detail: string } | undefined {
  if (a.device === 'hydrasynth' && typeof a.target_slot === 'string' && a.pc !== undefined) {
    const m = a.target_slot.match(/^([A-H])(\d{3})$/);
    if (!m) return { ok: false, detail: `target_slot "${a.target_slot}" is not a Hydrasynth location (A001..H128)` };
    const wantPc = Number(m[2]) - 1;
    const wantLsb = m[1]!.charCodeAt(0) - 'A'.charCodeAt(0);
    if (a.pc !== wantPc) return { ok: false, detail: `${a.target_slot} recalls via PC ${wantPc}, row says ${a.pc}` };
    // A load-bearing byte that is not RECORDED is not a passing row: plain
    // PC only reaches the device's CURRENT bank, and on this rig only bank
    // A is Circuit-PC recallable — a non-A target must carry its explicit
    // bank LSB or the row understates what recall actually requires.
    if (m[1] !== 'A' && a.bank_lsb === undefined) {
      return { ok: false, detail: `${a.target_slot} is bank ${m[1]}, which plain PC cannot reach (Circuit sends no Bank Select; rig rule pins bank A) — record bank_lsb ${wantLsb} or move the patch to bank A` };
    }
    if (a.bank_lsb !== undefined && a.bank_lsb !== wantLsb) {
      return { ok: false, detail: `bank ${m[1]} is bank LSB ${wantLsb}, row says ${a.bank_lsb}` };
    }
    return { ok: true, detail: `${a.target_slot} == PC ${wantPc}${a.bank_lsb !== undefined ? ` / bank LSB ${a.bank_lsb}` : ''}` };
  }
  if (a.device === 'microfreak' && typeof a.target_slot === 'number' && a.pc !== undefined) {
    const wantMsb = Math.floor((a.target_slot - 1) / 128);
    const wantPc = (a.target_slot - 1) % 128;
    // Same principle: past slot 128 the bank MSB is what makes the recall
    // land (hardware-confirmed 2026-08-14); a row that omits it would print
    // OK while live recall goes to the wrong slot.
    if (wantMsb > 0 && a.bank_msb === undefined) {
      return { ok: false, detail: `slot ${a.target_slot} is past 128 and needs bank MSB ${wantMsb} recorded — PC ${wantPc} alone recalls a different slot` };
    }
    if (a.pc !== wantPc || (a.bank_msb !== undefined && a.bank_msb !== wantMsb)) {
      return { ok: false, detail: `slot ${a.target_slot} recalls via bank MSB ${wantMsb} + PC ${wantPc}, row says MSB ${a.bank_msb ?? '(unset)'} + PC ${a.pc}` };
    }
    return { ok: true, detail: `slot ${a.target_slot} == bank MSB ${wantMsb} + PC ${wantPc}` };
  }
  return undefined;
}

async function scanDevice(id: string, slots: (number | string)[], packs: Set<number>): Promise<Map<string, string> | string> {
  const d = DESCRIPTORS[id];
  if (d === undefined) return `no descriptor registered for "${id}"`;
  const scanner = d.reader.scanLocations;
  if (scanner === undefined) return `${d.display_name} has no scanLocations`;

  const found = new Map<string, string>();
  try {
    for (const pack of packs.size > 0 ? [...packs] : [undefined]) {
      const numeric = slots.filter((s): s is number => typeof s === 'number');
      // String slots (Hydrasynth "A001") must be SORTED, not taken in the order
      // the claims happen to appear: ["H010","A015"] would ask for a reversed
      // range, which the Hydrasynth reader refuses outright, and the refusal
      // used to surface as a bland SKIPPED that still exited 0.
      const strings = slots.filter((s): s is string => typeof s === 'string').sort();
      const from = numeric.length > 0 ? Math.min(...numeric) : strings[0]!;
      const to = numeric.length > 0 ? Math.max(...numeric) : strings[strings.length - 1]!;
      const res = await withEndpoint(d, async (ctx: DispatchCtx) => scanner(ctx, from, to),
        { ...(pack !== undefined ? { pack: pack - 1 } : {}), opName: 'verify-song-mapping' });
      for (const s of res.scanned) {
        found.set(`${pack ?? ''}|${s.location}`, s.name ?? '');
      }
    }
  } catch (err) {
    return err instanceof Error ? err.message.split('\n')[0]! : String(err);
  }
  return found;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const only = argv.includes('--song') ? argv[argv.indexOf('--song') + 1]!.toLowerCase() : undefined;
  const jsonOut = argv.includes('--json') ? argv[argv.indexOf('--json') + 1]! : undefined;

  if (!fs.existsSync(MAPPINGS)) {
    console.error(`No song mapping file at ${MAPPINGS}. Nothing to verify.`);
    process.exitCode = 1;
    return;
  }
  const doc = JSON.parse(fs.readFileSync(MAPPINGS, 'utf-8')) as { songs: SongEntry[] };
  const songs = doc.songs.filter((s) => only === undefined || s.song.toLowerCase().includes(only));
  if (songs.length === 0) {
    console.error(`No song matching "${only}" in ${path.basename(MAPPINGS)}.`);
    process.exitCode = 1;
    return;
  }

  // Group every claim by device so each device is opened once, not per claim.
  const byDevice = new Map<string, { slots: (number | string)[]; packs: Set<number> }>();
  for (const s of songs) {
    for (const c of s.claims) {
      if (c.slot === undefined) continue; // owed pick: no slot to scan
      const e = byDevice.get(c.device) ?? { slots: [], packs: new Set<number>() };
      e.slots.push(c.slot);
      if (c.pack !== undefined) e.packs.add(c.pack);
      byDevice.set(c.device, e);
    }
  }

  const scans = new Map<string, Map<string, string> | string>();
  for (const [id, { slots, packs }] of byDevice) {
    process.stdout.write(`reading ${id}… `);
    const r = id === 'circuit-tracks'
      ? await readCircuitNames(songs.flatMap((s) => s.claims).filter((c) => c.device === 'circuit-tracks'))
      : await scanDevice(id, slots, packs);
    scans.set(id, r);
    console.log(typeof r === 'string' ? `SKIPPED (${r})` : `${r.size} slot(s) read`);
  }

  // AM4 scene-MIDI read-back: one session for every am4_scene_pc row whose
  // claimed preset is a real location. Rows on TBD presets need no wire.
  const am4Rows = songs.flatMap((s) => s.assignments ?? [])
    .filter((a) => a.kind === 'am4_scene_pc');
  // Exclude malformed rows from the wire read: a `scene: 7` would build a
  // param name KNOWN_PARAMS does not hold and the resulting throw inside the
  // session used to collapse EVERY am4 row to a non-fatal SKIP. The row
  // itself is failed per-row in the reporting loop below.
  const validScene = (a: Assignment) => Number.isInteger(a.scene) && a.scene! >= 1 && a.scene! <= 4;
  const am4Readable = am4Rows.filter((a) =>
    a.am4_preset !== undefined && isAm4Location(a.am4_preset) && validScene(a));
  let am4Scan: Awaited<ReturnType<typeof readAm4SceneMidi>> | undefined;
  if (am4Readable.length > 0) {
    process.stdout.write(`reading am4 scene-MIDI (up to ${1 + 12 * new Set(am4Readable.map((a) => `${a.am4_preset}|${a.scene}`)).size} param reads)… `);
    am4Scan = await readAm4SceneMidi(am4Readable);
    console.log(typeof am4Scan === 'string'
      ? `SKIPPED (${am4Scan})`
      : `active preset ${am4Scan.current ?? 'unknown'}, ${am4Scan.scenes.size} scene(s) read`);
  }

  const outcomes: Outcome[] = [];
  const assignmentOutcomes: AssignmentOutcome[] = [];
  for (const s of songs) {
    console.log(`\n${s.song}${s.artist !== undefined ? ` (${s.artist})` : ''}`);
    for (const c of s.claims) {
      // A claim without a slot (or a name) is an OWED pick: the row records
      // that the song needs this voice and nobody has chosen a patch. Report
      // it — the whole point of filing it is that it stays visible — but
      // there is nothing on any device to verify.
      if (c.slot === undefined || c.expected_name === undefined) {
        outcomes.push({ claim: c, song: s.song, state: 'unfiled' });
        console.log(`  note  ${c.device} — pick owed, no slot filed${c.role !== undefined ? ` (${c.role})` : ''}`);
        continue;
      }
      const scan = scans.get(c.device);
      if (typeof scan === 'string' || scan === undefined) {
        outcomes.push({ claim: c, song: s.song, state: 'skipped', detail: String(scan) });
        console.log(`  SKIP  ${c.device} ${c.slot}  (device not readable)`);
        continue;
      }
      const got = scan.get(`${c.pack ?? ''}|${String(c.slot)}`);
      if (got === undefined) {
        outcomes.push({ claim: c, song: s.song, state: 'unreadable' });
        console.log(`  ????  ${c.device} ${c.slot}  slot not in scan range`);
        continue;
      }
      const exact = got.trim().toLowerCase() === c.expected_name.trim().toLowerCase();
      if (exact) {
        outcomes.push({ claim: c, song: s.song, state: 'ok', got });
        console.log(`  OK    ${c.device} ${String(c.slot).padStart(3)}  "${got}"${c.status !== 'confirmed' ? `  [${c.status}]` : ''}`);
      } else {
        outcomes.push({ claim: c, song: s.song, state: 'mismatch', got });
        // On-card project names are 16 chars, so a longer intended name is
        // truncated by the device. Say so rather than reporting a bare
        // mismatch the reader has to diagnose.
        const truncated = c.expected_name.length > PROJECT_NAME_LEN
          && c.expected_name.slice(0, PROJECT_NAME_LEN).trim().toLowerCase() === got.trim().toLowerCase();
        const note = truncated
          ? `  (the name field holds ${PROJECT_NAME_LEN} chars, so "${c.expected_name}" is truncated on the card)`
          : '';
        console.log(`  ${c.status === 'confirmed' ? 'FAIL' : 'warn'}  ${c.device} ${String(c.slot).padStart(3)}  expected "${c.expected_name}", device holds "${got}"${note}`);
      }
    }

    for (const a of s.assignments ?? []) {
      if (a.kind === undefined) continue; // bare { _note } annotation row
      const tag = a.status !== undefined && a.status !== 'confirmed' ? `  [${a.status}]` : '';
      const push = (state: AssignmentOutcome['state'], detail?: string) =>
        assignmentOutcomes.push({ song: s.song, assignment: a, state, ...(detail !== undefined ? { detail } : {}) });

      if (a.kind === 'channel') {
        push('recorded');
        console.log(`  note  ${a.device} listens on ch${a.channel}${a.part !== undefined ? ` (${a.part})` : ''}${tag}  — recorded, not device-verifiable`);
        continue;
      }

      if (a.kind === 'recall') {
        const r = checkRecallArithmetic(a);
        if (r === undefined) {
          push('recorded');
          console.log(`  note  ${a.device} recall${a.pc !== undefined ? ` PC ${a.pc}` : ''}${tag}  — ${a.pc === undefined && a.target_slot === undefined ? 'numbers not yet filed' : 'no addressing rule modeled'}${a._note !== undefined ? ` (${a._note})` : ''}`);
        } else if (r.ok) {
          push('ok', r.detail);
          console.log(`  OK    ${a.device} recall ${r.detail}${tag}`);
        } else {
          push('mismatch', r.detail);
          console.log(`  ${a.status === 'confirmed' ? 'FAIL' : 'warn'}  ${a.device} recall — ${r.detail}`);
        }
        continue;
      }

      // am4_scene_pc
      const where = `am4 ${a.am4_preset} scene ${a.scene}`;
      if (!(Number.isInteger(a.scene) && a.scene! >= 1 && a.scene! <= 4)) {
        push('mismatch', `scene ${a.scene} out of range 1..4`);
        console.log(`  ${a.status === 'confirmed' ? 'FAIL' : 'warn'}  ${where}  scene must be 1..4 (the AM4 has four scenes); fix the manifest row`);
        continue;
      }
      if (a.am4_preset === undefined || !isAm4Location(a.am4_preset)) {
        push('unverifiable', 'preset location not yet assigned');
        console.log(`  ${a.status === 'confirmed' ? 'FAIL' : 'note'}  ${where} -> PC ${a.pc} ch${a.channel}${tag}  — preset location "${a.am4_preset}" is not authorable-to yet (assign a real location to verify)`);
        continue;
      }
      if (am4Scan === undefined || typeof am4Scan === 'string') {
        push('skipped', typeof am4Scan === 'string' ? am4Scan : 'AM4 not read');
        console.log(`  SKIP  ${where}  (AM4 not readable)`);
        continue;
      }
      const slots = am4Scan.scenes.get(`${a.am4_preset}|${a.scene}`);
      if (slots === undefined) {
        push('skipped', `AM4 is on ${am4Scan.current ?? 'an unknown preset'}, not ${a.am4_preset}`);
        console.log(`  SKIP  ${where}  (AM4 is on ${am4Scan.current ?? 'an unknown preset'} — load ${a.am4_preset} and re-run; this gate never navigates)`);
        continue;
      }
      const hit = slots.some((sl) => sl.type === 'PC' && sl.channel === a.channel && sl.value === a.pc);
      if (hit) {
        push('ok');
        console.log(`  OK    ${where} sends PC ${a.pc} on ch${a.channel}${tag}`);
      } else {
        const holds = slots.map((sl, i) => `midi_${i + 1}=${sl.type === 'None' ? 'None' : `${sl.type} ${sl.value} ch${sl.channel}`}`).join(', ');
        push('mismatch', holds);
        console.log(`  ${a.status === 'confirmed' ? 'FAIL' : 'warn'}  ${where}  expected PC ${a.pc} ch${a.channel}; device holds ${holds}`);
      }
    }
  }

  // The JSON capture used to be a bare claims array; it grew a second
  // section when assignments[] verification landed (BK-SONG-LAYER (b)).
  if (jsonOut !== undefined) {
    fs.writeFileSync(jsonOut, JSON.stringify({ claims: outcomes, assignments: assignmentOutcomes }, null, 2));
  }

  // `unreadable` means the device answered but not for this slot (a truncated
  // scan, or a pack-keying miss). That is a FAILURE for a confirmed claim, not
  // a pass: an earlier version counted only mismatches, so a gate that had
  // verified nothing still reported "N ok, 0 failed" and exited 0. `skipped`
  // (device absent) stays non-fatal and is called out separately.
  const failures = outcomes.filter((o) =>
    (o.state === 'mismatch' || o.state === 'unreadable') && o.claim.status === 'confirmed');
  const warnings = outcomes.filter((o) => o.state === 'mismatch' && o.claim.status !== 'confirmed');
  const skipped = outcomes.filter((o) => o.state === 'skipped' || o.state === 'unreadable');

  // Assignments: a confirmed row that MISMATCHES or cannot ever be verified
  // (no real preset location) fails; skips (device absent / wrong preset
  // loaded) and recorded-only kinds stay non-fatal.
  const aFailures = assignmentOutcomes.filter((o) =>
    (o.state === 'mismatch' || o.state === 'unverifiable') && o.assignment.status === 'confirmed');
  const aWarnings = assignmentOutcomes.filter((o) => o.state === 'mismatch' && o.assignment.status !== 'confirmed');
  const aSkipped = assignmentOutcomes.filter((o) => o.state === 'skipped');

  const unfiled = outcomes.filter((o) => o.state === 'unfiled');
  console.log(`\nclaims: ${outcomes.filter((o) => o.state === 'ok').length} ok, ${failures.length} failed, ${warnings.length} unconfirmed-mismatch, ${skipped.length} skipped${unfiled.length > 0 ? `, ${unfiled.length} picks owed (no slot filed)` : ''}`);
  if (assignmentOutcomes.length > 0) {
    console.log(`assignments: ${assignmentOutcomes.filter((o) => o.state === 'ok').length} ok, ${aFailures.length} failed, ${aWarnings.length} unconfirmed-mismatch, ${aSkipped.length} skipped, ${assignmentOutcomes.filter((o) => o.state === 'recorded').length} recorded-only`);
  }
  if (skipped.length > 0 || aSkipped.length > 0) {
    console.log('Skipped claims were NOT verified. A device that is unplugged proves nothing either way.');
  }
  if (failures.length > 0 || aFailures.length > 0) process.exitCode = 1;
}

main()
  .catch((err) => { console.error(`verify-song-mapping failed: ${err instanceof Error ? err.message : String(err)}`); process.exitCode = 1; })
  .finally(() => { closeAllMidiConnections(); });
