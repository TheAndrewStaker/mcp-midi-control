/**
 * Golden: external-instrument routing for apply_pattern (external_targets) +
 * rig links. Proves a groove resolves against an EXTERNAL device's voice_map but
 * authors onto the HOST's outward MIDI-track channel (Circuit MIDI 1/2 → SPD-SX),
 * with the explicit-target rule (default external-only; also_internal = both).
 *
 * Run via:  npx tsx scripts/verify-external-routing.ts
 */

import { clearRegistry, registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { buildExternalOverrides } from '@mcp-midi-control/core/protocol-generic/dispatcher/externalRouting.js';
import { clearRigLinksCache, getRigLinks, trackForDevice, RIG_LINKS_ENV } from '@mcp-midi-control/core/protocol-generic/rigLinks.js';
import { clearRigManifestCache, RIG_MANIFEST_ENV } from '@mcp-midi-control/core/protocol-generic/openrig/manifest.js';
import { CIRCUIT_TRACKS_DESCRIPTOR } from '@mcp-midi-control/circuit-tracks/descriptor.js';
import { SPD_SX_DESCRIPTOR } from '@mcp-midi-control/spd-sx/descriptor.js';

// Hermetic: trackForDevice now consults the rig manifest (resolveRigLinks), so a
// stray MCP_RIG_MANIFEST in the environment must not leak in and satisfy a
// "no rig link -> error" assertion by resolving a track from the manifest.
delete process.env[RIG_MANIFEST_ENV];
clearRigManifestCache();

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) console.log(`  OK   ${name}`);
  else { console.error(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); failures++; };
};
const threw = (fn: () => unknown): boolean => { try { fn(); return false; } catch { return true; } };

clearRegistry();
registerDevice(CIRCUIT_TRACKS_DESCRIPTOR);
registerDevice(SPD_SX_DESCRIPTOR);

const hostCaps = CIRCUIT_TRACKS_DESCRIPTOR.capabilities; // has external_tracks {midi1:3, midi2:4}
const spdsxMap = SPD_SX_DESCRIPTOR.capabilities.voice_map!;

console.log('host declares outward MIDI tracks:');
check('Circuit external_tracks = {midi1:3, midi2:4}',
  hostCaps.external_tracks?.midi1 === 3 && hostCaps.external_tracks?.midi2 === 4, JSON.stringify(hostCaps.external_tracks));

// Each voice now resolves to a LIST of destinations; external-only = [external],
// also_internal = [internal, external].
const onlyExt = (arr: readonly { channel: number; note: number }[] | undefined, ch: number, note: number) =>
  arr !== undefined && arr.length === 1 && arr[0].channel === ch && arr[0].note === note;

console.log('\nexternal routing (default = external-only):');
{
  const { overrides, hints } = buildExternalOverrides(
    [{ device: 'spd-sx', track: 'midi2', voices: ['kick', 'snare'] }], hostCaps, ['kick', 'snare', 'hat'],
  );
  // kick/snare → ch4 (MIDI2) with the SPD-SX's OWN GM notes (36/38); hat untouched.
  check('kick → [ch4 + SPD-SX kick note] only', onlyExt(overrides.kick, 4, spdsxMap.kick.note), JSON.stringify(overrides.kick));
  check('snare → [ch4 + SPD-SX snare note] only', onlyExt(overrides.snare, 4, spdsxMap.snare.note), JSON.stringify(overrides.snare));
  check('unrouted voice (hat) gets no override', overrides.hat === undefined);
  check('hint names the track + external-only', /midi2/.test(hints[0]) && /external only/i.test(hints[0]), hints[0]);
}

console.log('\nexternal routing (also_internal = drums AND MIDI 2):');
{
  const { overrides } = buildExternalOverrides(
    [{ device: 'spd-sx', track: 'midi2', voices: ['kick'], also_internal: true }], hostCaps, ['kick', 'snare'],
  );
  // kick now has TWO destinations: the Circuit's own drum (ch10/60) AND the SPD-SX (ch4/36).
  const arr = overrides.kick;
  const hasInternal = arr?.some((d) => d.channel === hostCaps.voice_map!.kick.channel && d.note === hostCaps.voice_map!.kick.note);
  const hasExternal = arr?.some((d) => d.channel === 4 && d.note === spdsxMap.kick.note);
  check('also_internal: kick has BOTH internal + external destinations', arr?.length === 2 && hasInternal === true && hasExternal === true, JSON.stringify(arr));
}

console.log('\nsame voice to TWO tracks (now appends, no false collision):');
{
  const { overrides } = buildExternalOverrides([
    { device: 'spd-sx', track: 'midi1', voices: ['kick'] },
    { device: 'spd-sx', track: 'midi2', voices: ['kick'] },
  ], hostCaps, ['kick']);
  const chans = (overrides.kick ?? []).map((d) => d.channel).sort();
  check('kick routed to midi1 (ch3) AND midi2 (ch4) — two destinations', JSON.stringify(chans) === '[3,4]', JSON.stringify(overrides.kick));
}

console.log('\ndefault voices = every pattern voice the device maps:');
{
  // No `voices` → route all pattern voices the SPD-SX can place; an unmappable one is skipped.
  const { overrides } = buildExternalOverrides([{ device: 'spd-sx', track: 'midi2' }], hostCaps, ['kick', 'snare', 'cowbell_xyz']);
  check('all mappable voices routed, unmappable skipped', overrides.kick !== undefined && overrides.snare !== undefined && overrides.cowbell_xyz === undefined);
}

console.log('\nvoice_notes pad pinning (idle-pad recovery):');
{
  // busy_hat has NO SPD-SX voice_map entry; pinned to the idle clap pad (39)
  // with the Circuit octave offset, it authors at 39+12 and reports pinned.
  const { overrides, resolutions } = buildExternalOverrides(
    [{ device: 'spd-sx', track: 'midi2', note_offset: 12, voice_notes: { busy_hat: 39, ride_bell: 49 } }],
    hostCaps, ['kick', 'busy_hat', 'ride_bell'],
  );
  check('pinned busy_hat → ch4 note 39+12 (no voice_map entry needed)', onlyExt(overrides.busy_hat, 4, 51), JSON.stringify(overrides.busy_hat));
  check('pinned ride_bell → ch4 note 49+12', onlyExt(overrides.ride_bell, 4, 61), JSON.stringify(overrides.ride_bell));
  check('pin bypasses the fold layer (resolution says pinned, no fold)',
    resolutions.busy_hat?.map_key === 'note 39 (pinned)' && resolutions.busy_hat?.fold === undefined, JSON.stringify(resolutions.busy_hat));
  check('unpinned voice still resolves via the voice_map', onlyExt(overrides.kick, 4, spdsxMap.kick.note + 12), JSON.stringify(overrides.kick));
  check('pin out of range throws',
    threw(() => buildExternalOverrides([{ device: 'spd-sx', track: 'midi2', voice_notes: { kick: 130 } }], hostCaps, ['kick'])));
  check('pin for a voice not in the pattern throws',
    threw(() => buildExternalOverrides([{ device: 'spd-sx', track: 'midi2', voice_notes: { china: 49 } }], hostCaps, ['kick'])));

  // Review fix (2026-07-03): a pin whose voice is ABSENT from an explicit
  // `voices` list must still route (union), not validate-then-silently-drop.
  const { overrides: unioned, resolutions: unionRes } = buildExternalOverrides(
    [{ device: 'spd-sx', track: 'midi2', voices: ['kick'], voice_notes: { busy_hat: 39 } }],
    hostCaps, ['kick', 'busy_hat'],
  );
  check('explicit voices + divergent pin: pinned voice still routes (no silent drop)',
    onlyExt(unioned.busy_hat, 4, 39) && onlyExt(unioned.kick, 4, spdsxMap.kick.note), JSON.stringify(unioned));
  // Review fix (2026-07-03): resolutions carry the final authored NOTE so the
  // compression report merges by physical pad, not display label.
  check('resolution carries the final note (pin + offset applied)',
    unionRes.busy_hat?.note === 39 && unionRes.kick?.note === spdsxMap.kick.note, JSON.stringify(unionRes));
}

console.log('\nvalidation (typed errors, no silent drop):');
{
  check('unknown host track → error', threw(() => buildExternalOverrides([{ device: 'spd-sx', track: 'midi9' }], hostCaps, ['kick'])));
  check('host with no external_tracks → error', threw(() => buildExternalOverrides([{ device: 'spd-sx', track: 'midi2' }], { external_tracks: undefined }, ['kick'])));
  check('explicit voices unmappable on device → error', threw(() => buildExternalOverrides([{ device: 'spd-sx', track: 'midi2', voices: ['nope'] }], hostCaps, ['nope'])));
  // M1: an explicit voice that the DEVICE maps but the PATTERN lacks → error (no silent no-op + lying hint).
  check('explicit voice absent from the pattern → error (M1)', threw(() => buildExternalOverrides([{ device: 'spd-sx', track: 'midi2', voices: ['kick'] }], hostCaps, ['snare'])));
  check('no track + no rig link → error', (() => { clearRigLinksCache(); delete process.env[RIG_LINKS_ENV]; return threw(() => buildExternalOverrides([{ device: 'spd-sx' }], hostCaps, ['kick'])); })());
}

console.log('\nrig links (MCP_RIG_LINKS → default track):');
{
  process.env[RIG_LINKS_ENV] = '{"midi2":"spd-sx"}';
  clearRigLinksCache();
  check('getRigLinks parses the env JSON', getRigLinks().midi2 === 'spd-sx');
  check('trackForDevice("spd-sx") → midi2', trackForDevice('spd-sx') === 'midi2');
  // A target with no explicit track now resolves midi2 from the rig link.
  const { overrides } = buildExternalOverrides([{ device: 'spd-sx', voices: ['kick'] }], hostCaps, ['kick']);
  check('target without track defaults to the rig-linked track (ch4)', overrides.kick?.[0]?.channel === 4, JSON.stringify(overrides.kick));
  // Malformed env → no links (graceful).
  process.env[RIG_LINKS_ENV] = 'not json';
  clearRigLinksCache();
  check('malformed MCP_RIG_LINKS → empty links (no throw)', Object.keys(getRigLinks()).length === 0);
  delete process.env[RIG_LINKS_ENV];
  clearRigLinksCache();
}

// note_offset: compensates the Circuit's octave-low MIDI-track transmission
// (confirmed 2026-06-28 by USB capture: authored 60 left the device as wire 48).
console.log('\nnote_offset (octave compensation for the external notes):');
{
  const base = buildExternalOverrides([{ device: 'spd-sx', track: 'midi2', voices: ['kick'] }], hostCaps, ['kick']);
  check('default note_offset = no shift (kick → SPD-SX GM note 36)', base.overrides.kick?.[0]?.note === 36, JSON.stringify(base.overrides.kick));

  const up = buildExternalOverrides([{ device: 'spd-sx', track: 'midi2', voices: ['kick', 'snare'], note_offset: 12 }], hostCaps, ['kick', 'snare']);
  check('note_offset:12 shifts kick 36 → 48 (so the Circuit transmits 36)', up.overrides.kick?.[0]?.note === 48, JSON.stringify(up.overrides.kick));
  check('note_offset:12 shifts snare 38 → 50', up.overrides.snare?.[0]?.note === 50, JSON.stringify(up.overrides.snare));
  check('note_offset:12 keeps the channel (ch4)', up.overrides.kick?.[0]?.channel === 4, JSON.stringify(up.overrides.kick));
  check('hint mentions the octave / capture-midi verification', /octave|note_offset|capture-midi/i.test(up.hints.join(' ')));

  const clamp = buildExternalOverrides([{ device: 'spd-sx', track: 'midi2', voices: ['perc'], note_offset: 48 }], hostCaps, ['perc']);
  check('note_offset clamps to MIDI 0..127 (perc 56 + 48 = 104, not >127)', (clamp.overrides.perc?.[0]?.note ?? 0) <= 127);

  // Negative offset shifts down (e.g. compensate a host that transmits an octave HIGH).
  const down = buildExternalOverrides([{ device: 'spd-sx', track: 'midi2', voices: ['kick'], note_offset: -12 }], hostCaps, ['kick']);
  check('negative note_offset:-12 shifts kick 36 → 24', down.overrides.kick?.[0]?.note === 24, JSON.stringify(down.overrides.kick));

  // Lower clamp: a small note + a big negative offset floors at 0, never negative.
  const floorClamp = buildExternalOverrides([{ device: 'spd-sx', track: 'midi2', voices: ['kick'], note_offset: -48 }], hostCaps, ['kick']);
  check('note_offset clamps to MIDI >= 0 (kick 36 - 48 → 0, never < 0)', (floorClamp.overrides.kick?.[0]?.note ?? -1) >= 0 && floorClamp.overrides.kick?.[0]?.note === 0);

  // Real ceiling trip: a high voice note + a positive offset that exceeds 127 clamps to 127.
  const ceil = buildExternalOverrides([{ device: 'spd-sx', track: 'midi2', voices: ['perc'], note_offset: 80 }], hostCaps, ['perc']);
  // perc=56; 56+80=136 → clamps to the MIDI ceiling 127.
  check('note_offset:80 on perc 56 → clamps to 127', ceil.overrides.perc?.[0]?.note === 127, JSON.stringify(ceil.overrides.perc));
}

console.log('\nnote_offset combines with also_internal (offset external only, internal untouched):');
{
  const { overrides } = buildExternalOverrides(
    [{ device: 'spd-sx', track: 'midi2', voices: ['kick'], also_internal: true, note_offset: 12 }], hostCaps, ['kick'],
  );
  const arr = overrides.kick ?? [];
  const internal = arr.find((d) => d.channel === hostCaps.voice_map!.kick.channel);
  const external = arr.find((d) => d.channel === 4);
  check('also_internal + note_offset: internal keeps its OWN note (no shift)', internal?.note === hostCaps.voice_map!.kick.note, JSON.stringify(internal));
  check('also_internal + note_offset: external is shifted (36 → 48)', external?.note === 48, JSON.stringify(external));
}

console.log('\nnote_offset applies to BOTH tracks when a voice routes to two:');
{
  const { overrides } = buildExternalOverrides([
    { device: 'spd-sx', track: 'midi1', voices: ['kick'], note_offset: 12 },
    { device: 'spd-sx', track: 'midi2', voices: ['kick'], note_offset: 12 },
  ], hostCaps, ['kick']);
  const arr = (overrides.kick ?? []).slice().sort((a, b) => a.channel - b.channel);
  check('both midi1 (ch3) and midi2 (ch4) destinations shifted 36 → 48',
    arr.length === 2 && arr[0].channel === 3 && arr[0].note === 48 && arr[1].channel === 4 && arr[1].note === 48,
    JSON.stringify(arr));
}

console.log(failures === 0 ? '\nAll external-routing goldens passed.' : `\n${failures} external-routing golden(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
