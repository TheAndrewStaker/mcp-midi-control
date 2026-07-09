/**
 * Rig topology links — which of a host sequencer's outward MIDI tracks drives
 * which external device.
 *
 * The Circuit Tracks has two outward MIDI tracks (MIDI 1 / MIDI 2). When the
 * user wires an external sound module (e.g. a Roland SPD-SX) to one of them, the
 * server can't see that cable. This optional config records it so the agent can
 * resolve "the SPD-SX connected to MIDI 2" without the user restating the wiring
 * every call: `apply_pattern external_targets` defaults a target's `track` from
 * it, and `describe_rig` surfaces it.
 *
 * Source: the `MCP_RIG_LINKS` env var, a JSON object mapping a host track name to
 * the connected device's id or name, e.g.
 *
 *     MCP_RIG_LINKS={"midi2":"spd-sx","midi1":"hydrasynth"}
 *
 * Absent / malformed ⇒ no links (the feature is purely additive; external_targets
 * still works with an explicit `track`). Parsed once and cached; call
 * `clearRigLinksCache()` in tests to re-read.
 */

export const RIG_LINKS_ENV = 'MCP_RIG_LINKS';

/** track name (lower-case) → external device id/name (verbatim). */
export type RigLinks = Readonly<Record<string, string>>;

let cache: RigLinks | undefined;

function parse(raw: string | undefined): RigLinks {
  if (raw === undefined || raw.trim() === '') return {};
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return {};
  const out: Record<string, string> = {};
  for (const [track, device] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof device === 'string' && device.trim() !== '') {
      out[track.trim().toLowerCase()] = device.trim();
    }
  }
  return out;
}

/** The configured rig links (track → external device id/name). Cached. */
export function getRigLinks(): RigLinks {
  if (cache === undefined) cache = parse(process.env[RIG_LINKS_ENV]);
  return cache;
}

/** Reverse lookup: the host track wired to `deviceIdOrName`, if any. */
export function trackForDevice(deviceIdOrName: string): string | undefined {
  const want = deviceIdOrName.trim().toLowerCase();
  for (const [track, device] of Object.entries(getRigLinks())) {
    if (device.toLowerCase() === want) return track;
  }
  return undefined;
}

/** Clear the parsed-env cache (tests). */
export function clearRigLinksCache(): void {
  cache = undefined;
}
