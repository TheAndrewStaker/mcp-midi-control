/**
 * Per-device config for an Akai MPC running the standalone MPC OS (3.x).
 *
 * Every MPC on this OS shares one MIDI behaviour (Program Change selects a
 * Sequence, pads play from incoming notes, clock / MMC are received), so a new
 * model is a config, not a second descriptor.
 */
import type { SupportTier } from '@mcp-midi-control/core/protocol-generic/types.js';

export interface MpcConfig {
  /** Descriptor id; also the contribution-page filename. */
  id: string;
  display_name: string;
  /**
   * USB MIDI port matchers, most specific first. The MPC exposes several
   * ports (its own engine plus the DIN jacks forwarded over USB); only the
   * engine port may match, or a note meant for the MPC leaves through DIN.
   */
  port_match: readonly RegExp[];
  /**
   * The port pair that reaches the MPC's own sequencer while it runs
   * STANDALONE with USB connected. Named from the computer's side: its output
   * is the MPC's input.
   */
  engine_ports: { output: RegExp; input: RegExp };
  /**
   * A port that exists only in CONTROLLER MODE, where the unit is a control
   * surface for the desktop app and plays nothing itself. Seeing it means a
   * MIDI verb cannot work until the unit is back in standalone.
   */
  controller_mode_port: RegExp;
  /** Sequences addressable by Program Change (PC 0..127 -> sequence 1..128). */
  sequence_count: number;
  /** Env var naming the channel (1..16) Program Change is sent on. */
  channel_env: string;
  /** Env var naming the channel (1..16) drum-pad notes are sent on. */
  drum_channel_env: string;
  support_tier: SupportTier;
  verification: string;
  agent_guidance: Readonly<Record<string, string>>;
}
