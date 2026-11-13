/**
 * The unit's own MIDI system settings, read from `DATA/SYSTEM1.RC0` while the
 * drive is mounted.
 *
 * The RX CTL channel decides whether a memory recall lands: a Program Change on
 * any other channel is ignored without a word, and the unit cannot be asked for
 * it over MIDI. It is reported in a storage-mode read so the agent can tell the
 * user and send on it. Nothing is remembered between modes.
 *
 * Decoded on the RC-505mk2: `<sys><MIDI><A>` is the RX CTL channel, stored
 * 0-indexed (4 = channel 5). Confirmed on the maintainer's unit, where a recall
 * on channel 5 changed the memory and a recall on channel 1 did not.
 *
 * The rest of the MIDI section was pinned on the same unit by changing one
 * setting on the panel and diffing the file: C rhythm channel, D voice channel,
 * E transmit channel (16 = "RX CTL"), F sync clock, G clock out, H start sync,
 * J thru. I (PC OUT) is bracketed between confirmed H and J. The mk2 has no B.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseRc0 } from '../codec/rc0.js';

export interface RcSystemSettings {
  /** RX CTL channel, 1..16. */
  rx_ctl_channel: number;
  /** The MIDI menu as the panel words it, for the fields that decoded to a known value. */
  midi: Record<string, string | number>;
}

const SYNC_CLOCK = ['AUTO', 'INTERNAL', 'MIDI', 'USB'];
const START_SYNC = ['OFF', 'ALL', 'RHYTHM'];
const THRU = ['OFF', 'MIDI OUT', 'USB OUT', 'USB & MIDI'];
const ON_OFF = ['OFF', 'ON'];

/** Read the settings off the mounted drive, or undefined when the file is absent or unreadable. */
export function readSystemSettings(root: string): RcSystemSettings | undefined {
  const file = join(root, 'DATA', 'SYSTEM1.RC0');
  if (!existsSync(file)) return undefined;
  try {
    const doc = parseRc0(readFileSync(file, 'latin1'));
    const leaf = doc.leaves.find((l) => !l.path.includes('mem#') && l.path.endsWith('/MIDI/A'));
    if (!leaf) return undefined;
    const stored = Number.parseInt(leaf.value, 10);
    if (!Number.isInteger(stored) || stored < 0 || stored > 15) return undefined;
    const prefix = leaf.path.slice(0, -1);
    const raw = (tag: string): number | undefined => {
      const v = doc.byPath.get(prefix + tag)?.value;
      const n = v === undefined ? Number.NaN : Number.parseInt(v, 10);
      return Number.isInteger(n) ? n : undefined;
    };
    const midi: Record<string, string | number> = { rx_ctl_channel: stored + 1 };
    const channel = (key: string, tag: string): void => {
      const n = raw(tag);
      if (n !== undefined && n >= 0 && n <= 15) midi[key] = n + 1;
    };
    const pick = (key: string, tag: string, table: readonly string[]): void => {
      const n = raw(tag);
      if (n !== undefined && table[n] !== undefined) midi[key] = table[n];
    };
    channel('rx_rhythm_channel', 'C');
    channel('rx_voice_channel', 'D');
    const tx = raw('E');
    if (tx === 16) midi.tx_channel = 'RX CTL';
    else if (tx !== undefined && tx >= 0 && tx <= 15) midi.tx_channel = tx + 1;
    pick('sync_clock', 'F', SYNC_CLOCK);
    pick('clock_out', 'G', ON_OFF);
    pick('start_sync', 'H', START_SYNC);
    pick('pc_out', 'I', ON_OFF);
    pick('thru', 'J', THRU);
    return { rx_ctl_channel: stored + 1, midi };
  } catch {
    return undefined;
  }
}
