/**
 * Axe-Fx Standard/Ultra (gen-1) connection wiring.
 *
 * Registers the connector factory for the `axe-fx-gen1` connection label.
 * Without a registered factory, `ensureConnection` falls back to using the
 * label string itself as the port-name substring, and no real gen-1 unit
 * enumerates as "axe-fx-gen1", so this module is what makes the device
 * reachable at all. Port needles mirror the descriptor's
 * `/axe-?fx.*(?:ultra|standard)/i` routing pattern.
 *
 * It also records WHICH port name matched, because of the Standard
 * model-byte risk: every gen-1 SysEx frame this codec builds uses the
 * Ultra model byte 0x01, while the published gen-1 spec and the community
 * model-ID table both list Standard = 0x00 (assumed). Neither value is
 * hardware-confirmed for the Standard. `gen1PortLooksLikeStandard()` lets
 * the writer/reader attach a runtime warning when the matched port name
 * says "standard", instead of silently sending possibly-misaddressed
 * frames. (Plain MIDI Program Change, i.e. switch_preset, carries no model
 * byte and is unaffected.)
 */

import {
  connect,
  listMidiPorts,
  type MidiConnection,
} from '@mcp-midi-control/core/midi/transport.js';
import { registerConnector } from '@mcp-midi-control/core/server-shared/connections.js';

export const AXEFXGEN1_LABEL = 'axe-fx-gen1';

/** Mirrors the descriptor's port_match pattern; keep the two in step. */
const GEN1_PORT_PATTERN = /axe-?fx.*(?:ultra|standard)/i;

/** Fallback substrings when no enumerated port matches the pattern. */
const GEN1_PORT_NEEDLES = ['axe-fx ultra', 'axefx ultra', 'axe-fx standard', 'axefx standard'];

let matchedPortName: string | undefined;

/** The OS port name the last (re)connect matched, if any. */
export function gen1MatchedPortName(): string | undefined {
  return matchedPortName;
}

/**
 * True when the connected port name looks like an Axe-Fx STANDARD (not an
 * Ultra). Drives the model-byte runtime warning on SysEx-based ops.
 */
export function gen1PortLooksLikeStandard(): boolean {
  return matchedPortName !== undefined && /standard/i.test(matchedPortName);
}

/**
 * The Standard model-byte warning text, or undefined when the matched port
 * does not look like a Standard. Appended to SysEx-op receipts by the
 * writer/reader.
 */
export function gen1StandardModelByteWarning(): string | undefined {
  if (!gen1PortLooksLikeStandard()) return undefined;
  return (
    `This port ("${matchedPortName}") looks like an Axe-Fx STANDARD. All gen-1 SysEx frames ` +
    'use the Ultra model byte 0x01; the published spec and the community model-ID table list ' +
    'Standard = 0x00 (assumed). Neither value is hardware-confirmed for the Standard. If the ' +
    'unit ignores these commands, that is the likely cause; please report it ' +
    '(docs/contributing/devices/axe-fx-gen1.md, ask REPORT-2).'
  );
}

function connectAxeFxGen1(): MidiConnection {
  // Record the matched output-port name for the Standard warning. Best-effort:
  // enumeration failure must not block the connect (connect() will produce its
  // own, fuller not-found diagnostics).
  try {
    const { outputs } = listMidiPorts();
    matchedPortName = outputs.find((p) => GEN1_PORT_PATTERN.test(p.name))?.name;
  } catch {
    matchedPortName = undefined;
  }
  return connect({
    // Prefer the exact enumerated name (needle matching is substring-based);
    // fall back to the generic gen-1 needles so the not-found error lists
    // what WAS present.
    needles: matchedPortName !== undefined ? [matchedPortName] : GEN1_PORT_NEEDLES,
    notFoundLeadIn: 'Axe-Fx Standard/Ultra not found in the MIDI device list. Common causes:',
    notFoundHints: [
      '  - the unit is powered off, or its MIDI interface is not connected',
      '  - the port enumerates under a name without "Ultra"/"Standard" (e.g. a generic USB-MIDI',
      '    interface name): call `list_midi_ports` and report the exact name',
      '    (docs/contributing/devices/axe-fx-gen1.md, ask REPORT-1)',
      '',
      'Once the unit is visible, retry. Use `reconnect_midi` to force a fresh handle.',
    ],
  });
}

registerConnector(AXEFXGEN1_LABEL, connectAxeFxGen1);
