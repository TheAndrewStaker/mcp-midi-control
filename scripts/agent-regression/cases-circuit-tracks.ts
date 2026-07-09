/**
 * Novation Circuit Tracks agent-regression cases.
 *
 * These exercise the agent's INTERPRETATION of the destructive-transfer
 * overwrite gate (#0 in CIRCUIT-TRACKS-FIRST-CLASS-PLAN.md): does the model
 * pass `confirm_overwrite: true` ONLY when the user used save/overwrite/replace
 * language, and otherwise surface the refusal so the user can confirm? The
 * MECHANICAL gate behavior (refusal envelope, no-frames-on-refusal, occupancy
 * read, confirm-skip) is covered deterministically and offline by
 * `scripts/verify-circuit-ncs-transfer.ts`; these cases cover only the part a
 * golden can't — the LLM's reading of the tool description.
 *
 * RUN CONTEXT: there is no Circuit mock transport, so (like the FM9 / Hydra
 * cases) these run on a HARDWARE agent-sweep with a real Circuit connected on
 * port "circuit", NOT in the offline preflight gate. The upload tools read their
 * file argument before the gate fires, so the sweep machine must have the
 * referenced fixtures present:
 *   scripts/agent-regression/fixtures/circuit/kick.wav   (any WAV)
 * and, for the project case, project slot 33 already OCCUPIED on the device with
 * a known stored project.
 */

import type { AgentRegressionCase } from './types.js';

const KICK_WAV = 'scripts/agent-regression/fixtures/circuit/kick.wav';

export const CIRCUIT_TRACKS_CASES: AgentRegressionCase[] = [
  // Overwrite gate — BARE request (no save-language) → refuse + ask ──────────
  {
    id: 'circuit-overwrite-gate-refuses-bare-request',
    device: 'circuit',
    requiresHardware: true, // upload_sample transfer is ack-gated; mock can't synthesize the ack
    description:
      'Overwrite gate, refusal path: a bare "load this sample to slot 5" is NOT overwrite-authorization. The agent should call upload_sample WITHOUT confirm_overwrite, hit the refusal (sample slots cannot be read to confirm they are empty), and surface that to the user to confirm — NOT silently re-call with confirm_overwrite:true. Catches an agent that treats any upload as overwrite-intent and clobbers a user sample slot.',
    prompt: `Load the sample at ${KICK_WAV} onto the Circuit Tracks drum sample slot 5.`,
    expectations: {
      must_call: ['upload_sample'],
      must_not_call: ['upload_kit'],
      max_tools: 4,
      max_repeats: { upload_sample: 1 },
      tool_call_validators: [{
        tool: 'upload_sample',
        call_index: 0,
        check: (args) => {
          if (args.confirm_overwrite === true) {
            return 'first upload_sample passed confirm_overwrite:true on a bare request (no save/overwrite/replace language) — the gate must be surfaced to the user, not bypassed.';
          }
          if (args.slot !== 5) return `upload_sample slot should be 5, got ${JSON.stringify(args.slot)}.`;
          return true;
        },
      }],
      // The agent should explain the slot would be overwritten and ask to confirm.
      text_contains_any: [['overwrit'], ['confirm'], ['replace']],
      max_wall_seconds: 90,
    },
  },

  // Overwrite gate — explicit "replace" → authorize ─────────────────────────
  {
    id: 'circuit-overwrite-gate-authorizes-on-replace-language',
    device: 'circuit',
    requiresHardware: true, // upload_sample transfer is ack-gated; mock can't synthesize the ack
    description:
      'Overwrite gate, authorized path: "replace the sample in slot 5" IS overwrite-authorization. The agent should call upload_sample with confirm_overwrite:true so the write goes through without a second round-trip. Catches an over-cautious agent that refuses to overwrite even when the user explicitly asked to replace.',
    prompt: `Replace the sample in Circuit Tracks drum slot 5 with ${KICK_WAV}.`,
    expectations: {
      must_call: ['upload_sample'],
      max_tools: 4,
      max_repeats: { upload_sample: 1 },
      tool_call_validators: [{
        tool: 'upload_sample',
        call_index: 'last',
        check: (args) => {
          if (args.confirm_overwrite !== true) {
            return 'upload_sample should pass confirm_overwrite:true — the user used explicit replace language.';
          }
          if (args.slot !== 5) return `upload_sample slot should be 5, got ${JSON.stringify(args.slot)}.`;
          return true;
        },
      }],
      max_wall_seconds: 90,
    },
  },

  // Read a stored project — get_preset by slot ──────────────────────────────
  {
    id: 'circuit-read-stored-project',
    device: 'circuit',
    requiresHardware: true, // get_preset reads a stored .ncs via SysEx; mock has no Circuit responder
    description:
      'Read path: "what is stored on project slot 0" should call get_preset({port:"circuit", location}) — get_param reads only the WORKING-buffer synth patch (osc/filter/env/lfo/mixer/fx/eq), not a stored project slot, so get_preset is the only read for stored content. Catches an agent that reaches for get_param (wrong scope for a stored slot) or fabricates the project content.',
    prompt: 'What is stored on project slot 0 of my Circuit Tracks? Read it off the device.',
    expectations: {
      must_call: ['get_preset'],
      must_not_call: ['get_param'],
      max_tools: 4,
      tool_call_validators: [{
        tool: 'get_preset',
        check: (args) => {
          const port = typeof args.port === 'string' ? args.port.toLowerCase() : '';
          if (!port.includes('circuit')) return `get_preset port should target circuit, got ${String(args.port)}.`;
          const loc = args.location;
          if (typeof loc !== 'number' || loc < 0 || loc > 63) return `get_preset location should be a slot 0..63, got ${JSON.stringify(loc)}.`;
          return true;
        },
      }],
      max_wall_seconds: 90,
    },
  },

  // Author/audition a beat — apply_pattern live_stream (non-destructive) ─────
  {
    id: 'circuit-audition-house-beat',
    device: 'circuit',
    description:
      'Pattern authoring: "play a four-on-the-floor house beat" should call apply_pattern at the requested bpm, auditioning (live_stream / default) NOT writing a stored project. Catches an agent that reaches for ncs_upload (which would overwrite a slot) when the user only asked to hear it.',
    prompt: 'Play me a four-on-the-floor house beat on the Circuit Tracks at 124 bpm — just audition it, do not save it anywhere.',
    expectations: {
      must_call: ['apply_pattern'],
      max_tools: 5,
      tool_call_validators: [{
        tool: 'apply_pattern',
        check: (args) => {
          const port = typeof args.port === 'string' ? args.port.toLowerCase() : '';
          if (!port.includes('circuit')) return `apply_pattern port should target circuit, got ${String(args.port)}.`;
          if (args.bpm !== 124) return `apply_pattern bpm should be 124, got ${JSON.stringify(args.bpm)}.`;
          // Audition only: must not write a stored project (no ncs_upload / ncs_slot).
          if (args.mode === 'ncs_upload') return 'apply_pattern should audition (live_stream / default), not ncs_upload — the user said do not save.';
          if (args.ncs_slot !== undefined) return 'apply_pattern should not target a project slot for an audition.';
          return true;
        },
      }],
      max_wall_seconds: 120,
    },
  },

  // ── Large coverage: discover → audition → tweak (all mock-friendly) ────────
  {
    id: 'circuit-archetype-discover-audition-tweak',
    device: 'circuit',
    description:
      'Sequencer archetype, large coverage: a multi-step "what can it do, play a beat, tweak a sound" request should walk the introspection + audition + live-edit surface — list_pattern_recipes (the named library), apply_pattern in live_stream/audition (NOT ncs_upload), and set_param on a synth knob (fire-and-forget CC). All three are mock-friendly (introspection + fire-and-forget), so the envelope is stable without hardware. Catches an agent that writes a stored project for an audition, or fabricates the recipe list.',
    prompt:
      'On my Circuit Tracks: first list the drum-pattern recipes you can play, then audition a boom-bap beat at 90 bpm (just play it, do not save), ' +
      'and open up Synth 1 by setting its filter cutoff to about 70%. Tell me what you did.',
    expectations: {
      must_call: ['list_pattern_recipes', 'apply_pattern', 'set_param'],
      max_tools: 9,
      min_tools: 3,
      tool_call_validators: [
        {
          tool: 'apply_pattern',
          check: (args) => {
            const port = typeof args.port === 'string' ? args.port.toLowerCase() : '';
            if (!port.includes('circuit')) return `apply_pattern port should target circuit, got ${String(args.port)}.`;
            if (args.bpm !== 90) return `apply_pattern bpm should be 90, got ${JSON.stringify(args.bpm)}.`;
            if (args.mode === 'ncs_upload') return 'apply_pattern should audition (live_stream / default), not ncs_upload — the user said do not save.';
            if (args.ncs_slot !== undefined) return 'apply_pattern should not target a project slot for an audition.';
            return true;
          },
        },
        {
          tool: 'set_param',
          call_index: 'last',
          check: (args) => {
            const port = typeof args.port === 'string' ? args.port.toLowerCase() : '';
            if (!port.includes('circuit')) return `set_param port should target circuit, got ${String(args.port)}.`;
            return true;
          },
        },
      ],
      max_wall_seconds: 150,
    },
  },
];
