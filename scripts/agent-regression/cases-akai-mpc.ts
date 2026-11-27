/**
 * Akai MPC agent-regression cases (MPC One G2, standalone MPC OS).
 *
 * The MPC is a `generic-only` device with a deliberately small MIDI surface,
 * so these cases test two things an agent gets wrong on it:
 *
 *   - WHAT A "PRESET" IS. `switch_preset` selects a SEQUENCE of the project
 *     that is already loaded (Program Change N-1 = sequence N). It does not
 *     load a project, a program or a kit: those are files on the card and no
 *     MIDI message opens them. The failure to catch is an agent that says it
 *     loaded a song, or that reaches for a raw Program Change with the
 *     off-by-one applied twice or not at all.
 *   - HONESTY ABOUT AN EMPTY PARAMETER SURFACE. The MPC exposes no parameters
 *     over MIDI. Asked to change a pad level, a filter or the tempo, the agent
 *     must say so and point at the front panel, not hunt for a CC and report a
 *     blind write as done.
 *
 *   - CARD EDITS THROUGH THE SHARED VERB. A project on the card is edited by
 *     apply_preset(target_location = the project), not by a device tool. The
 *     mpc-card-* cases measure whether an agent finds that, reads before it
 *     writes, and writes only on save language.
 *
 * Every write here is fire-and-forget on real hardware too (the MPC sends
 * nothing back), so the cases run on the shared mock in
 * packages/core/src/midi/transport.ts with no hardware attached.
 */

import type { AgentRegressionCase } from './types.js';

const isMpcPort = (v: unknown): boolean => {
  const p = typeof v === 'string' ? v.toLowerCase().replace(/[\s_-]/g, '') : '';
  return p.includes('mpc');
};

export const AKAI_MPC_CASES: AgentRegressionCase[] = [
  // §1 Sequence recall goes through the unified verb, in the panel's numbering
  {
    id: 'mpc-switch-sequence-uses-unified-verb',
    device: 'mpc-one-g2',
    description:
      'A sequence change should be switch_preset({port:"mpc-one-g2", location:5}) with the '
      + 'number the MPC screen shows. Catches an agent that sends a raw Program Change '
      + '(where it has to do the N-1 arithmetic itself and often gets it wrong) or passes 4.',
    prompt: 'On my MPC One, jump to sequence 5.',
    expectations: {
      must_call: ['switch_preset'],
      must_not_call: ['send_program_change', 'send_sysex', 'save_preset', 'import_preset'],
      max_tools: 6,
      tool_call_validators: [
        {
          tool: 'switch_preset',
          check: (args) => {
            if (!isMpcPort(args.port)) return `switch_preset should target the MPC, got ${String(args.port)}`;
            const loc = Number(args.location);
            if (loc !== 5) return `expected sequence 5 as shown on the MPC, got ${JSON.stringify(args.location)}`;
            return true;
          },
        },
      ],
    },
  },

  // §2 The reply must not claim the change was confirmed, or that it is instant while playing
  {
    id: 'mpc-switch-sequence-reports-queued-while-playing',
    device: 'mpc-one-g2',
    description:
      'The MPC answers nothing, and while it is playing a sequence change is QUEUED to the end '
      + 'of the current sequence. The agent must pass that on instead of saying the MPC is now '
      + 'on the new sequence.',
    prompt: 'My MPC One is playing right now. Switch it to sequence 3 and tell me exactly when it will change.',
    expectations: {
      must_call: ['switch_preset'],
      must_not_call: ['send_program_change', 'send_clock_stop'],
      max_tools: 6,
      text_contains_any: [
        ['end', 'sequence'],
        ['queued'],
        ['finishes'],
        ['when', 'current', 'ends'],
      ],
    },
  },

  // §3 A project is a file on the card: no MIDI message loads it
  {
    id: 'mpc-cannot-load-a-project-over-midi',
    device: 'mpc-one-g2',
    description:
      'Asked to load a song project, the agent must say that projects are opened on the MPC '
      + 'itself and that only sequences inside the loaded project can be selected over MIDI. '
      + 'Catches an agent that calls switch_preset and reports the project as loaded.',
    prompt: 'Load my "Night Drive" project on the MPC One.',
    expectations: {
      must_not_call: ['send_sysex', 'import_preset', 'save_preset', 'send_program_change'],
      min_tools: 0,
      max_tools: 6,
      text_contains_any: [
        ['project', 'MPC', 'itself'],
        ['project', 'by hand'],
        ['project', 'front panel'],
        ['project', 'touchscreen'],
        ['project', 'on the MPC'],
        ['cannot', 'project'],
        ["can't", 'project'],
      ],
      text_not_contains: ['loaded the project', 'project is now loaded', 'Night Drive is loaded'],
    },
  },

  // §4 No parameter surface: refuse plainly, do not hunt for a CC
  {
    id: 'mpc-no-parameter-surface',
    device: 'mpc-one-g2',
    description:
      'The MPC exposes no parameters over MIDI. Asked to change a pad level, the agent must '
      + 'say it cannot from here and point at the MPC, not send a guessed CC and call it done.',
    prompt: 'Turn the snare pad down about 3 dB on my MPC One.',
    expectations: {
      must_not_call: ['send_cc', 'send_nrpn', 'send_sysex', 'save_preset'],
      min_tools: 0,
      max_tools: 6,
      text_contains_any: [
        ['no', 'parameter'],
        ['cannot', 'MIDI'],
        ["can't", 'MIDI'],
        ['on the MPC'],
        ['front panel'],
        ['pad mixer'],
      ],
    },
  },

  // §5 Out-of-range sequence: the refusal is passed on, not papered over
  {
    id: 'mpc-sequence-out-of-range',
    device: 'mpc-one-g2',
    description:
      'A Program Change addresses sequences 1..128. Asked for sequence 200, the agent must '
      + 'report the limit rather than wrapping the number or sending a bank select guess.',
    prompt: 'Go to sequence 200 on the MPC One.',
    expectations: {
      must_not_call: ['send_cc', 'send_sysex', 'send_program_change'],
      min_tools: 0,
      max_tools: 6,
      text_contains_any: [['128'], ['out of range'], ['1', 'to', '128']],
    },
  },

  // ── Song plans: the declared song book drives several devices ────────────
  //
  // These run against fixtures/song-rig (an MPC and an AM4, two songs). The
  // plan comes from describe_rig({song, section}); the agent executes its
  // steps with the ordinary verbs. There is no "apply a song" tool, on purpose.

  // §6 A section of a song: plan first, then exactly the plan's steps
  {
    id: 'song-plan-section-drives-both-devices',
    device: 'mpc-one-g2',
    rigFixture: 'song-rig',
    description:
      'Asked to set the rig up for a song section, the agent reads the plan with '
      + 'describe_rig({song, section}) and calls its steps: the MPC sequence that plays the '
      + 'section (4, not 3: the project interleaves a fill), then the AM4 preset, then the AM4 '
      + 'scene. Catches an agent that guesses "third section = sequence 3", switches the scene '
      + 'before the preset recall, or saves.',
    prompt: 'Set my rig up for the chorus of Night Drive.',
    expectations: {
      must_call: ['describe_rig', 'switch_preset', 'switch_scene'],
      must_not_call: ['save_preset', 'apply_preset', 'send_program_change', 'send_sysex', 'edit_rig'],
      max_tools: 10,
      tool_call_validators: [
        {
          tool: 'describe_rig',
          call_index: 'last',
          check: (args) => {
            const song = String(args.song ?? '').toLowerCase();
            if (!song.includes('night')) return `describe_rig should ask for the song, got ${JSON.stringify(args)}`;
            return true;
          },
        },
        {
          tool: 'switch_preset',
          call_index: 0,
          check: (args) => {
            if (isMpcPort(args.port)) {
              return Number(args.location) === 4 ? true : `MPC should go to sequence 4 for the chorus, got ${JSON.stringify(args.location)}`;
            }
            if (String(args.port).toLowerCase().includes('am4')) {
              return String(args.location).toUpperCase() === 'B02' ? true : `AM4 should recall B02, got ${JSON.stringify(args.location)}`;
            }
            return `unexpected switch_preset target ${String(args.port)}`;
          },
        },
        {
          tool: 'switch_scene',
          call_index: 'last',
          check: (args) => {
            if (!String(args.port).toLowerCase().includes('am4')) return `switch_scene should target the AM4, got ${String(args.port)}`;
            return Number(args.scene) === 3 ? true : `the chorus is AM4 scene 3, got ${JSON.stringify(args.scene)}`;
          },
        },
      ],
      // The project has to be opened on the MPC by hand; the plan says so and
      // the agent has to pass it on.
      text_contains_any: [['Night Drive', 'project'], ['Night Drive.xpj'], ['load', 'MPC']],
    },
  },

  // §7 A tone nobody chose is reported, never invented
  {
    id: 'song-plan-owed-tone-is-not-invented',
    device: 'mpc-one-g2',
    rigFixture: 'song-rig',
    description:
      'Slow Tide has no AM4 tone chosen (an owed unit). The agent must set what the plan '
      + 'holds (the MPC sequence) and say the guitar tone is still to be chosen, not pick an '
      + 'AM4 preset or build one.',
    prompt: 'Get the rig ready for Slow Tide.',
    expectations: {
      must_call: ['describe_rig'],
      must_not_call: ['apply_preset', 'save_preset', 'set_block', 'set_params', 'edit_rig', 'send_program_change'],
      max_tools: 8,
      tool_call_validators: [
        {
          tool: 'switch_preset',
          optional: true,
          check: (args) => (isMpcPort(args.port)
            ? true
            : `no AM4 preset is chosen for this song; switch_preset went to ${String(args.port)}`),
        },
      ],
      text_contains_any: [
        ['tone', 'chosen'],
        ['tone', 'decide'],
        ['guitar', 'not', 'yet'],
        ['AM4', 'not', 'chosen'],
        ['owed'],
      ],
    },
  },

  // §8 An unknown song lists what the book holds instead of guessing
  {
    id: 'song-plan-unknown-song-lists-the-book',
    device: 'mpc-one-g2',
    rigFixture: 'song-rig',
    description:
      'A song that is not in the book: the agent must say so and name the songs that are, '
      + 'and must not move any device. The prompt asks only about the book: asked to SET UP '
      + 'an absent song, building it from scratch is a fair answer and an open-ended one.',
    prompt: 'Is Paranoid Android in my song book? If it is not, tell me which songs are.',
    expectations: {
      must_call: ['describe_rig'],
      must_not_call: ['switch_preset', 'switch_scene', 'apply_preset', 'save_preset', 'edit_rig', 'import_songsterr'],
      max_tools: 6,
      text_contains_any: [['Night Drive'], ['Slow Tide']],
    },
  },

  // ── Project edits on the card: apply_preset(target_location = a project) ──
  //
  // These run against a fresh card (mpcCard) holding "Night Drive": tracks
  // Drums 0 dB, Bass -2 dB, Keys 0 dB, Lead -4 dB. They measure whether an agent
  // finds the edit through the shared apply_preset verb (there is no MPC tool),
  // reads the project first, and writes only on save language.

  // §9 A relative level change: read first, then write the absolute value
  {
    id: 'mpc-card-edit-track-level-and-save',
    device: 'mpc-one-g2',
    mpcCard: true,
    description:
      'Asked to turn a track down 3 dB and save it, the agent reads the project (get_preset) to find '
      + 'the Bass track and its level (-2 dB), then calls apply_preset on that project with '
      + 'track 2 level_db -5 and save_authorized. Catches an agent that says the MPC has no parameters, '
      + 'writes -3 instead of -5, guesses the track number, or saves without being asked.',
    prompt: 'In the Night Drive project on my MPC card, turn the Bass track down 3 dB and save that to the card.',
    expectations: {
      must_call: ['get_preset', 'apply_preset'],
      must_not_call: ['send_cc', 'send_sysex', 'save_preset', 'send_program_change'],
      max_tools: 8,
      tool_call_validators: [
        {
          tool: 'apply_preset',
          call_index: 'last',
          check: (args) => {
            if (!isMpcPort(args.port)) return `apply_preset should target the MPC, got ${String(args.port)}`;
            if (!String(args.target_location ?? '').toLowerCase().includes('night')) return `target_location should be the Night Drive project, got ${JSON.stringify(args.target_location)}`;
            if (args.save_authorized !== true) return 'the user asked to save; save_authorized should be true';
            const slots = ((args.spec as { slots?: unknown[] } | undefined)?.slots ?? []) as Array<{ slot?: unknown; block_type?: unknown; params?: Record<string, unknown> }>;
            const bass = slots.find((s) => s.block_type === 'track' && Number(s.slot) === 2);
            if (bass === undefined) return `expected a track 2 (Bass) row, got ${JSON.stringify(slots)}`;
            const db = Number(bass.params?.level_db);
            if (!(Math.abs(db + 5) <= 0.15)) return `Bass is at -2 dB, so 3 dB down is -5; got level_db ${JSON.stringify(bass.params?.level_db)}`;
            if (slots.length !== 1) return `only the Bass row should be listed, got ${slots.length} rows`;
            return true;
          },
        },
      ],
    },
  },

  // §10 No save language: a preview, or nothing, but never a write
  {
    id: 'mpc-card-edit-preview-without-save',
    device: 'mpc-one-g2',
    mpcCard: true,
    description:
      'Asked what a change would do and told not to write, the agent may preview with apply_preset '
      + 'but must not pass save_authorized. Catches an agent that writes the card on a question.',
    prompt: 'If I muted the Keys track in my MPC project Night Drive, what exactly would change in the file? Do not change anything yet.',
    expectations: {
      must_not_call: ['save_preset', 'send_cc', 'send_sysex'],
      min_tools: 0,
      max_tools: 8,
      tool_call_validators: [
        {
          tool: 'apply_preset',
          optional: true,
          check: (args) => (args.save_authorized === true ? 'the user said not to change anything; save_authorized must not be set' : true),
        },
      ],
      text_contains_any: [['Keys', 'mute'], ['Keys', 'muted']],
    },
  },

  // §11 Rename a sequence by the number get_preset shows
  {
    id: 'mpc-card-rename-sequence',
    device: 'mpc-one-g2',
    mpcCard: true,
    description:
      'A sequence rename on the card goes through apply_preset with a "sequence" row: slot = the '
      + 'sequence number, params.name = the new name, saved because the user asked. Catches an agent '
      + 'that renames the project instead, or reports it cannot be done.',
    prompt: 'On my MPC card, rename the chorus sequence in Night Drive to "02 Big Chorus" and write it to the card.',
    expectations: {
      must_call: ['apply_preset'],
      must_not_call: ['save_preset', 'send_sysex'],
      max_tools: 8,
      tool_call_validators: [
        {
          tool: 'apply_preset',
          call_index: 'last',
          check: (args) => {
            if (args.save_authorized !== true) return 'the user asked to write it; save_authorized should be true';
            const spec = (args.spec ?? {}) as { name?: unknown; slots?: Array<{ slot?: unknown; block_type?: unknown; params?: Record<string, unknown> }> };
            if (spec.name !== undefined) return `spec.name renames the project; the sequence is a row. Got spec.name ${JSON.stringify(spec.name)}`;
            const row = (spec.slots ?? []).find((s) => s.block_type === 'sequence');
            if (row === undefined || Number(row.slot) !== 2) return `expected a sequence row for sequence 2, got ${JSON.stringify(spec.slots)}`;
            return row.params?.name === '02 Big Chorus' ? true : `expected name "02 Big Chorus", got ${JSON.stringify(row.params?.name)}`;
          },
        },
      ],
    },
  },

  // list_midi_ports' verdict is device-neutral (2026-11-14 audit): it used to
  // open with "AM4 not visible ... install the AM4 driver" whatever was asked,
  // and agents relayed that to MPC owners.
  {
    id: 'mpc-connection-check-not-am4-centric',
    device: 'mpc-one-g2',
    description:
      'A "is my MPC connected?" check should read the port list (list_midi_ports or describe_rig) and answer about the MPC. '
      + 'Catches an agent relaying an AM4 driver hint to someone asking about a different device.',
    prompt: 'Can you see my MPC One over USB right now?',
    expectations: {
      must_call_any: [['list_midi_ports'], ['describe_rig'], ['describe_device']],
      must_not_call: ['send_program_change', 'switch_preset', 'reconnect_midi'],
      max_tools: 4,
      text_not_contains: ['AM4 driver', 'am4-downloads'],
    },
  },
];
