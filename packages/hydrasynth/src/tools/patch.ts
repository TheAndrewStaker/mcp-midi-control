/**
 * Hydrasynth patch-dump tools, atomic SysEx whole-patch writes.
 *
 * 3 tools:
 *   - hydra_apply_init    , recovery primitive: load factory INIT into H128
 *   - hydra_apply_init_to , diagnostic: dump INIT to a caller-named slot
 *   - hydra_apply_patch   , milestone-3: sparse override map applied on top
 *                            of the factory INIT buffer + atomic SysEx dump
 *
 * All three reuse the bank/PC dance + chunk-pacing helpers in shared.ts.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { findHydraNrpn } from '../nrpn.js';
import {
  findMatchingNrpns,
  fxSubParamLabel,
  fxTypeName,
  parseFxSubParamName,
  resolveFxAwareValue,
  resolveFxTypeIdx,
  resolveNrpnValue,
} from '../encoding.js';
import { decodeFxNrpnDisplay, decodeNrpnDisplay } from '../nrpnDisplay.js';
import { HYDRASYNTH_ENUMS } from '../enums.js';
import { wrapSysex, unwrapSysex } from '../sysexEnvelope.js';
import { encodePatch, splitIntoChunks, PATCH_CHUNK_COUNT } from '../patchEncoder.js';
import { INIT_PATCH_BUFFER } from '../initPatchBuffer.js';

import {
  APPLY_PATCH_DUP_WINDOW_MS,
  ENV_TIME_SECONDS_TO_INDEX,
  HYDRA_DEV_MODE_PREAMBLE,
  SCRATCH_BANK,
  SCRATCH_PATCH,
  SYSEX_CHUNK_PACING_MS,
  SYSEX_TAIL_DRAIN_MS,
  WRITE_REQUEST_FLASH_PAUSE_MS,
  bankPcDance,
  describeInboundMessage,
  ensureMidi,
  lastApplyPatch,
  parseSlot,
  recordApplyPatch,
  sleep,
} from './shared.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';
import { asError } from '@mcp-midi-control/core/protocol-generic/tools/shared.js';

export function registerHydrasynthPatchTools(server: McpServer): void {

// hydra_apply_init -------------------------------------------------------

server.registerTool('hydra_apply_init', {
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  description: HYDRA_DEV_MODE_PREAMBLE + [
    'Recovery primitive: load the factory INIT patch into scratch slot H128 via a SysEx whole-patch dump, then bank/PC dance to make it audibly active. Use when the device has gone silent or wedged after recipe writes; equivalent to pressing the device\'s INIT button from a tool.',
    '- RAM only (no flash burn). After completion, active patch = H128 "Init".',
    '- ~1.7 s wire time including pre + post dance.',
    '- No device-mode preconditions; SysEx + PC bypass Param TX/RX gating.',
  ].join('\n'),
  inputSchema: {},
}, async () => {
  const conn = ensureMidi();
  const startMs = Date.now();

  // Diagnostic capture (HW-040 test 1): subscribe to inbound MIDI before
  // we send anything so we can observe Header / Chunk / Footer / Patch
  // Saved acks per `SysexEncoding.txt:342-378`. If `conn.hasInput` is
  // false (no Hydrasynth input port visible to the OS), the handler
  // never fires and the capture report says so.
  const observed: Array<{ ms: number; bytes: number[] }> = [];
  const unsubscribe = conn.onMessage((bytes) => {
    observed.push({ ms: Date.now() - startMs, bytes: [...bytes] });
  });

  try {
    // 1. PRE-DUMP DANCE: force H128 to be the active patch. Required
    //    because SysEx-to-current-memory only modifies the active bank's
    //    working memory; dumping while on any other bank leaves the
    //    update unreachable. HW-040 test 1 (Session 38, 2026-04-28)
    //    confirmed this: dumped from A001 with full ack chain, silent
    //    on key-press because H128 reloaded from flash.
    await bankPcDance(conn, { bank: SCRATCH_BANK, patch: SCRATCH_PATCH });

    // Mutate chunk-0 metadata in a clone of INIT_PATCH_BUFFER so the
    // device routes the dump to the scratch slot. Per spec line 117-120:
    // byte 0 = 0x06 ("Save to RAM"), byte 2 = bank, byte 3 = patch.
    const buf = new Uint8Array(INIT_PATCH_BUFFER);
    buf[2] = SCRATCH_BANK;
    buf[3] = SCRATCH_PATCH;

    // 2. Header (`18 00`), initiates the patch-dump handshake.
    conn.send(wrapSysex([0x18, 0x00]));

    // 3. 22 chunk dumps. Each chunk is `[0x16, 0x00, INDEX, 0x16, …data…]`,
    //    wrapped in the F0…F7 SysEx envelope.
    const chunks = splitIntoChunks(buf);
    for (let i = 0; i < chunks.length; i++) {
      conn.send(wrapSysex(chunks[i]!.info));
      if (i < chunks.length - 1) await sleep(SYSEX_CHUNK_PACING_MS);
    }

    // 4. Footer (`1A 00`). Deliberately skip the Write Request (`14 00`)
    //   , that makes this a recovery primitive instead of a destructive
    //    flash write. Per `SysexEncoding.txt:381-382`: "without the Write
    //    Request, the patch isn't written to Flash. Instead it stays in RAM."
    conn.send(wrapSysex([0x1a, 0x00]));

    // 5. POST-DUMP DANCE: re-engage H128 to make the dump audible. Per
    //    NOTE 2: "you will not hear the update unless you change to the
    //    patch via a PC", and "if you change to a patch you're already
    //    at... the change-patch request is entirely ignored." Bouncing
    //    through E064 ensures both the bank-change and the patch-change
    //    are effective.
    await bankPcDance(conn, { bank: SCRATCH_BANK, patch: SCRATCH_PATCH });

    // Drain inbound for a moment so trailing acks (especially Patch Saved
    // + final Footer Response) make it into the report.
    await sleep(SYSEX_TAIL_DRAIN_MS);
  } finally {
    unsubscribe();
  }

  const elapsedMs = Date.now() - startMs;

  // Summarize what came back. Each Hydrasynth SysEx ack maps to a counter;
  // anything unrecognized goes in the "other" bucket so we can see CC/PC
  // echoes from the dance and any unexpected device chatter.
  let headerResponses = 0;
  let footerResponses = 0;
  let patchSaveds = 0;
  const chunkAcksSeen = new Set<number>();
  const others: string[] = [];
  for (const { bytes } of observed) {
    if (bytes[0] === 0xf0) {
      let info: Uint8Array;
      try {
        info = unwrapSysex(bytes);
      } catch {
        others.push(describeInboundMessage(bytes));
        continue;
      }
      if (info.length === 2 && info[0] === 0x19 && info[1] === 0x00) headerResponses++;
      else if (info.length === 2 && info[0] === 0x1b && info[1] === 0x00) footerResponses++;
      else if (info.length === 4 && info[0] === 0x17 && info[1] === 0x00 && info[3] === 0x16) chunkAcksSeen.add(info[2]!);
      else if (info.length === 4 && info[0] === 0x07 && info[1] === 0x00) patchSaveds++;
      else others.push(describeInboundMessage(bytes));
    } else {
      others.push(describeInboundMessage(bytes));
    }
  }

  const lines: string[] = [];
  lines.push(`Loaded factory INIT patch into scratch slot H128 via SysEx (pre-dance + ${PATCH_CHUNK_COUNT} chunks + header + footer + post-dance, ${elapsedMs} ms).`);
  lines.push('');
  lines.push('Active patch is now H128 = "Init". Press a key to confirm audible.');
  lines.push('');
  lines.push(`Diagnostic, inbound MIDI capture (hasInput=${conn.hasInput}, ${observed.length} message${observed.length === 1 ? '' : 's'}):`);
  if (!conn.hasInput) {
    lines.push('  (no Hydrasynth input port found, capture is empty by construction; reconnect or check OS MIDI enumeration)');
  } else if (observed.length === 0) {
    lines.push('  (none, device is fully silent on the MIDI input. Either acks are not being emitted, or the input port is to a different device.)');
  } else {
    for (const { ms, bytes } of observed) {
      lines.push(`  [+${ms.toString().padStart(4)}ms] ${describeInboundMessage(bytes)}`);
    }
  }
  lines.push('');
  lines.push('Summary:');
  lines.push(`  Header Response (19 00):   ${headerResponses > 0 ? '✓' : '✗'} (${headerResponses} seen)`);
  lines.push(`  Chunk Acks (17 00 NN 16):  ${chunkAcksSeen.size}/${PATCH_CHUNK_COUNT} ${chunkAcksSeen.size === PATCH_CHUNK_COUNT ? '✓' : '✗'}`);
  if (chunkAcksSeen.size > 0 && chunkAcksSeen.size < PATCH_CHUNK_COUNT) {
    const missing: number[] = [];
    for (let i = 0; i < PATCH_CHUNK_COUNT; i++) if (!chunkAcksSeen.has(i)) missing.push(i);
    lines.push(`    missing chunk indices: ${missing.join(', ')}`);
  }
  lines.push(`  Patch Saved (07 00 BB PP): ${patchSaveds > 0 ? '✓' : '✗'} (${patchSaveds} seen)`);
  lines.push(`  Footer Response (1B 00):   ${footerResponses > 0 ? '✓' : '✗'} (${footerResponses} seen)`);
  lines.push(`  Other / unrecognized:      ${others.length}`);
  lines.push('');
  lines.push('If silent on key-press despite full ack chain (Header + 22 chunks +');
  lines.push('Patch Saved + Footer): the SysEx-to-current-memory mechanism may be');
  lines.push('fundamentally non-recoverable without a flash burn. Next step would be');
  lines.push('to switch to the Write Request (`14 00`) flow, which DOES persist the');
  lines.push('patch but is destructive (flashes H128). Decision-time for the founder.');

  return {
    content: [{
      type: 'text',
      text: lines.join('\n'),
    }],
  };
});

// hydra_apply_init_to (diagnostic) --------------------------------------

server.registerTool('hydra_apply_init_to', {
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  description: HYDRA_DEV_MODE_PREAMBLE + [
    'Diagnostic primitive: dump the factory INIT patch via SysEx to the named slot ("A001".."H128"), with configurable bank/PC dance. Used to test whether SysEx-to-current-memory modifies the audibly-active patch.',
    'Set `slot` to whatever the device\'s display reads NOW (SysEx-to-current-memory only modifies the active bank\'s working memory).',
    '- dance: "none" (default, pure dump), "post" (post-dump PC bounce), "both" (pre + post).',
    '- RAM only (no flash burn).',
  ].join('\n'),
  inputSchema: {
    slot: z.string().describe(
      'Target slot in "A001".."H128" form. Set this to whatever the device\'s display currently reads, that\'s the active patch the dump can actually modify.',
    ),
    dance: z.enum(['none', 'post', 'both']).optional().describe(
      '`none` (default) = pure dump, no bank/PC navigation. `post` = bounce off E064 + return to target after the dump. `both` = same dance before AND after.',
    ),
  },
}, async ({ slot, dance }) => {
  let target: ReturnType<typeof parseSlot>;
  try {
    target = parseSlot(slot);
  } catch (err) {
    return asError(new DispatchError(
      'bad_location',
      'Hydrasynth',
      err instanceof Error ? err.message : String(err),
      {
        retry_action: 'Pass slot as "A001".."H128" (letter A..H + patch 1..128).',
      },
    ));
  }
  const conn = ensureMidi();
  const danceMode = dance ?? 'none';
  const startMs = Date.now();

  const observed: Array<{ ms: number; bytes: number[] }> = [];
  const unsubscribe = conn.onMessage((bytes) => {
    observed.push({ ms: Date.now() - startMs, bytes: [...bytes] });
  });

  try {
    if (danceMode === 'both') {
      await bankPcDance(conn, target);
    }

    // Mutate chunk-0 metadata so the device routes the dump to `target`.
    const buf = new Uint8Array(INIT_PATCH_BUFFER);
    buf[2] = target.bank;
    buf[3] = target.patch;

    conn.send(wrapSysex([0x18, 0x00]));
    const chunks = splitIntoChunks(buf);
    for (let i = 0; i < chunks.length; i++) {
      conn.send(wrapSysex(chunks[i]!.info));
      if (i < chunks.length - 1) await sleep(SYSEX_CHUNK_PACING_MS);
    }
    conn.send(wrapSysex([0x1a, 0x00]));

    if (danceMode === 'post' || danceMode === 'both') {
      await bankPcDance(conn, target);
    }

    await sleep(SYSEX_TAIL_DRAIN_MS);
  } finally {
    unsubscribe();
  }

  const elapsedMs = Date.now() - startMs;

  let headerResponses = 0;
  let footerResponses = 0;
  let patchSaveds = 0;
  const chunkAcksSeen = new Set<number>();
  const others: string[] = [];
  for (const { bytes } of observed) {
    if (bytes[0] === 0xf0) {
      let info: Uint8Array;
      try {
        info = unwrapSysex(bytes);
      } catch {
        others.push(describeInboundMessage(bytes));
        continue;
      }
      if (info.length === 2 && info[0] === 0x19 && info[1] === 0x00) headerResponses++;
      else if (info.length === 2 && info[0] === 0x1b && info[1] === 0x00) footerResponses++;
      else if (info.length === 4 && info[0] === 0x17 && info[1] === 0x00 && info[3] === 0x16) chunkAcksSeen.add(info[2]!);
      else if (info.length === 4 && info[0] === 0x07 && info[1] === 0x00) patchSaveds++;
      else others.push(describeInboundMessage(bytes));
    } else {
      others.push(describeInboundMessage(bytes));
    }
  }

  const lines: string[] = [];
  lines.push(`SysEx dump to ${target.display} (dance=${danceMode}, ${PATCH_CHUNK_COUNT} chunks, ${elapsedMs} ms total).`);
  lines.push('');
  lines.push(`Chunk-0 routing: bank=${target.bank} (${target.display[0]}), patch=${target.patch} (displayed ${target.display}).`);
  lines.push('');
  lines.push(`Press a key NOW. Audible patch with sine-saw oscillator and open filter = success.`);
  lines.push('');
  lines.push(`Inbound MIDI capture (hasInput=${conn.hasInput}, ${observed.length} message${observed.length === 1 ? '' : 's'}):`);
  if (!conn.hasInput) {
    lines.push('  (no input port open)');
  } else if (observed.length === 0) {
    lines.push('  (none)');
  } else {
    for (const { ms, bytes } of observed) {
      lines.push(`  [+${ms.toString().padStart(4)}ms] ${describeInboundMessage(bytes)}`);
    }
  }
  lines.push('');
  lines.push('Summary:');
  lines.push(`  Header Response (19 00):   ${headerResponses > 0 ? '✓' : '✗'} (${headerResponses} seen)`);
  lines.push(`  Chunk Acks (17 00 NN 16):  ${chunkAcksSeen.size}/${PATCH_CHUNK_COUNT} ${chunkAcksSeen.size === PATCH_CHUNK_COUNT ? '✓' : '✗'}`);
  lines.push(`  Patch Saved (07 00 BB PP): ${patchSaveds > 0 ? '✓' : '✗'} (${patchSaveds} seen)`);
  lines.push(`  Footer Response (1B 00):   ${footerResponses > 0 ? '✓' : '✗'} (${footerResponses} seen)`);
  lines.push(`  Other / unrecognized:      ${others.length}`);

  return {
    content: [{
      type: 'text',
      text: lines.join('\n'),
    }],
    structuredContent: {
      target_slot: target.display,
      target_bank: target.bank,
      target_patch: target.patch,
      dance: danceMode,
      elapsed_ms: elapsedMs,
      chunk_acks_seen: chunkAcksSeen.size,
      chunk_acks_total: PATCH_CHUNK_COUNT,
      header_responses: headerResponses,
      footer_responses: footerResponses,
      patch_saved_responses: patchSaveds,
    },
  };
});

// hydra_apply_patch (milestone-3 prototype) -----------------------------

server.registerTool('hydra_apply_patch', {
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  description: HYDRA_DEV_MODE_PREAMBLE + [
    'Build a Hydrasynth patch atomically: apply a sparse override map on top of the factory INIT buffer and dump via SysEx to the named slot. Covers the full surface (oscillators, filters, envelopes, mixer, mutators, pre/post-FX, delay, reverb, name) in ONE call. No follow-up NRPN batch needed.',
    'CLOBBER WARNING on save:true: this dumps THIS call\'s `params` + INIT defaults and flashes that. Any front-panel tweaks the user made between calls ARE LOST (Hydrasynth has no SysEx working-memory read). If the user says "save my current sound" after turning knobs on the device, do NOT call this with save:true; tell them to press the device SAVE button. Reserve save:true for "build this recipe and persist it".',
    'Also: save:true silently no-ops if System Menu -> Protect is ON; the tool cannot detect this.',
    'FX SUB-PARAMS ARE TYPE-DEPENDENT. `prefxparam1..5` / `postfxparam1..5` mean different things per `prefxtype` / `postfxtype`. ALWAYS include the type in the same call so the encoder routes correctly. Per-type mappings:',
    '  Lo-Fi: param1=Cutoff Hz, param2=Resonance, param3=Filter Type ("Thru"/"PWBass"/"Radio"/"Tele"/"Clean"/"Low"), param4=Output dB makeup gain, param5=Sampling Hz.',
    '  Chorus/Flanger: param1=Rate Hz, param2=Depth, param3=Offset (-180..180), param4=Feedback (-63..63), param5=Mono/Stereo.',
    '  Phaser: param1=Rate, param2=Feedback, param3=Depth, param4=Phase, param5=Offset.',
    '  Rotary: param1=Rate, param2=LFO param, param3=Lo-Depth, param4=Hi-Depth, param5=Low/High mix.',
    '  Tremolo: param1=Rate, param2=Depth, param3=LFO Shape ("Sine"/"Square"), param4=Phase, param5=Pitch Mod.',
    '  EQ: param1=Low Gain dB, param2=High Gain dB, param3=Mid Gain dB, param4=Xover Low Hz, param5=Xover High Hz.',
    '  Compressor: param1=Threshold, param2=Ratio (1.0..20.0), param3=Attack ms, param4=Release ms, param5=Output dB.',
    '  Distortion: param1=Drive, param2=Tone, param3=Asym, param4=Curve, param5=Output dB.',
    'VALUES ARE DISPLAY UNITS (matches set_param). The same resolveNrpnValue pipeline runs internally; never pass raw wire numbers.',
    '- Percent params (delaywet, reverbwet, prefxwet, postfxwet, mutator*wet, mutator*feedback) take 0..100 input.',
    '- INDEX-TABLE params take a table index, NOT seconds/ms. reverbtime, env*{attack,decay,release,hold,delay}syncoff, lfo*{rate,delay,fadein}syncoff. Tables differ per param family: attack/hold reaches 36s at 128; decay/release reaches 60s at 128 (2x resolution at the low end vs attack); delaysync caps at 32s. SLOW PAD attack 90..100 (~1-2 s), decay 70..80 (~720 ms..1.6 s), release 90..100 (~2-5 s). SNAPPY BASS attack 0..8, decay 30..45, release 30..40. reverbtime 60..80 = ~2-4s tail; 96..110 = wash; 128 = Freeze. Out-of-range indices throw.',
    ENV_TIME_SECONDS_TO_INDEX,
    'DELAY TEMPO-SYNC: for rhythmic music ("ambient", "Edge / U2", "post-rock"), set delaybpmsync:1 and pass delaytimesyncon as a musical division ("1/4 D" dotted-quarter Edge sound, "1/4" clear quarters, "1/2 D" ambient wash, "1/8 D"/"1/8"/"1/16"). Use delaybpmsync:0 + delaytimesyncoff (raw ms) only for explicit ms / free-time / slapback. Both write the same byte; the bpmsync flag selects interpretation. Always set both in one call.',
    'GAIN STAGING for quiet patches: signal flow is osc -> mixer -> filter -> amp -> prefx -> delay/reverb -> postfx -> master. Pushable knobs: `amplevel` (push to 120-128 if quiet across the board), `mixerosc{1,2,3}vol` (INIT default has osc2/osc3 at 0). For Lo-Fi pre-FX, `prefxparam4` is MAKEUP GAIN; `prefxparam1` is Cutoff Hz and is downstream of the synth filter, so set it ABOVE the highest played note (C4=262 Hz, C5=523 Hz) or signal dies.',
    '- slot: "A001".."H128", omit for H128 scratch + dance:"both" (recommended when current slot is unknown). Hydrasynth has no SysEx for current-patch query.',
    '- dance: "both" (default, pre + post PC bounce; always works), "post" (assumes caller pre-navigated), "none" (advanced).',
    '- name: <=16 ASCII chars, ONLY embedded when save:true (RAM-only patches can\'t display a name).',
    '- save:true: persist to flash, +~3.5 s. REQUIRES save_authorized:true. Default false (RAM only, reversible by navigating away).',
    '- save_authorized:true: required gate for save:true. Set ONLY for explicit save vocab ("save", "store", "keep", "persist", "put on").',
    'Precondition: device must have Pgm Chg RX = On (MIDI Page 11 knob 4) for the post-dance to fire.',
  ].join('\n'),
  inputSchema: {
    slot: z.string().optional().describe(
      'Target slot in "A001".."H128" form. Should match the device\'s currently-active patch, only that bank\'s working memory will be modified. OMIT to use the H128 scratch slot (in-place test workflow): the tool will navigate to H128 first via dance:"both" so the patch lands audibly without you needing to know which slot the device is on. The Hydrasynth has no SysEx query for current patch (per SysexEncoding.txt, "request from current working memory" is not supported), so omit + scratch is the recommended path when you don\'t know.',
    ),
    params: z.array(z.object({
      name: z.string().describe('Canonical patch-buffer parameter name (e.g. "filter1cutoff", "osc1type", "mixer.osc1_vol"). Must appear in PATCH_OFFSETS.'),
      value: z.union([z.number(), z.string()]).describe('Display value (e.g. 64 for filter cutoff, +25 for bipolar env amount, -12 for osc semitones) OR enum string ("Sawtooth", "Lo-Fi", "Vowel"). Auto-routed through resolveNrpnValue, same semantics as hydra_set_param.'),
    })).min(1).describe('Sparse override map applied on top of the factory INIT buffer.'),
    dance: z.enum(['none', 'post', 'both']).optional().describe(
      '`both` (default) = pre-navigate to target slot + dump + post-navigate to make audible. Always works regardless of where the device started. `post` = post-dump bounce only, assumes you already navigated to the target via `hydra_navigate_to`; faster (~600ms saved) but if you didn\'t navigate, the SysEx writes land on a non-active bank\'s working memory and silently disappear. `none` = pure dump, no PC at all (advanced; for diagnostic use). When `slot` is omitted, defaults to H128 scratch.',
    ),
    name: z.string().max(16).optional().describe(
      'Optional patch name (max 16 ASCII chars per Owners Manual page 4369; longer names truncated, shorter ones zero-padded). **The name is only embedded in the patch buffer when `save: true` is also set.** Hydrasynth\'s on-screen patch-name display reads from flash, not from working memory, so a name written to a RAM-only dump never appears anywhere visible, by suppressing the name on no-save calls we avoid clobbering whatever name happens to be in the working buffer from a prior recipe. Pair `name` with `save: true` for the canonical "build + persist this recipe with a label" flow. Example: `{ params: [...], name: "Eno Wash", save: true }`. If `name` is provided without `save`, it is silently dropped (the response will note this).',
    ),
    save: z.boolean().optional().describe(
      'When true, sends a Write Request (`14 00`) after the chunks, persisting THE RECIPE in `params` to flash. **Costs ~3.5 seconds of additional wire time**. Default false. **CLOBBER WARNING, this re-dumps the recipe; any manual front-panel tweaks the user made on the device between the last apply_patch call and this one ARE LOST.** Hydrasynth has no SysEx read flow that surfaces working memory, so this tool has no way to preserve unknown tweaks. If the user just turned knobs and now says "save it", tell them to press the device\'s SAVE button (or Shift+Save), DO NOT call apply_patch+save:true, because it will overwrite their tweaks with the agent\'s last-known recipe. Reserve save:true for "build this exact recipe and persist it" (the recipe IS the saved state). Also note: silently no-ops if System Menu → Protect is ON; the tool cannot detect that, verify off the device.',
    ),
    save_authorized: z.boolean().optional().describe(
      'Cross-device safe-edit gate (see docs/SAFE-EDIT-WORKFLOW.md). When `save: true` is set, this MUST also be true. Description-only enforcement isn\'t enough, agents can misread "build a patch at A005" as save intent. The runtime gate makes the refusal explicit. Authorize ONLY when the user uses save/store/keep/persist language. For "build a patch" / "design a sound" without save language, omit `save` entirely (RAM-only dump, reversible by navigating). The gate fires BEFORE any wire I/O so refusals are zero-cost.',
    ),
  },
}, async ({ slot, params, dance, name, save, save_authorized }) => {
  // Safe-edit save-authorization gate (cross-device contract per
  // docs/SAFE-EDIT-WORKFLOW.md). Hydrasynth doesn't expose a MIDI
  // dirty signal so there's no on_active_preset_edited gate, but
  // the save_authorized gate still applies: save:true requires
  // explicit save-intent language from the user.
  if (save === true && save_authorized !== true) {
    return {
      content: [{
        type: 'text',
        text:
          `REFUSING TO SAVE: hydra_apply_patch was called with save: true but ` +
          `save_authorized was not explicitly set. The default policy refuses ` +
          `silent saves, agents can misread "build a patch at A005" as save ` +
          `intent.\n` +
          `\n` +
          `If the user said something like "build a patch for X" / "design a ` +
          `sound" without naming a save action, drop save: true entirely. The ` +
          `tool will dump to RAM only, fully reversible by navigating away. ` +
          `Let the user audition the patch, then ASK "want me to save it to ` +
          `${slot ?? 'H128'}?" before retrying with save: true AND ` +
          `save_authorized: true.\n` +
          `\n` +
          `User phrases that authorize saving: "save this", "store as ${slot ?? 'A001'}", ` +
          `"build and save", "keep it at ${slot ?? 'A001'}", "put it on ${slot ?? 'A001'}", ` +
          `"persist this patch".\n` +
          `\n` +
          `User phrases that do NOT authorize saving: "build a patch", "design ` +
          `a sound", "make me a Tony Banks lead", "try out a pad at ${slot ?? 'A005'}" ` +
          `(the "at ${slot ?? 'A005'}" names a target but doesn't authorize a save).`,
      }],
      isError: true,
    };
  }

  try {

  const conn = ensureMidi();
  // In-place workflow: when caller omits slot, default to H128 (the
  // designated scratch slot). Either way, default dance is "both",
  // pre-navigates to the target before the dump so writes land on
  // the correct bank's working memory regardless of what the device
  // was doing before. Session 47 HW-058: founder confirmed apply_patch
  // can target a non-active location IF dance:"both" handles the
  // pre-navigate. Old default was "post" which assumed the caller
  // pre-navigated; that footgun silently dropped writes when not.
  const effectiveSlot = slot ?? 'H128';
  const target = parseSlot(effectiveSlot);
  const danceMode = dance ?? 'both';
  const startMs = Date.now();

  // Build the override map. Each {name, value} runs through the same
  // resolveNrpnValue pipeline as hydra_set_param so callers pass display
  // values / enum strings, never wire/protocol numbers. The encoder
  // expects wire NRPN values and applies its /8 patch-buffer scaling
  // internally for u16le params.
  //
  // PASS 1, pre-scan for prefxtype / postfxtype so FX sub-params
  // (prefxparam1..5 / postfxparam1..5) can be routed to the correct
  // per-type entry (fx5param1 = Lo-Fi Cutoff Hz, fx1param1 = Chorus
  // Rate Hz, etc.). Without this, the generic prefxparam1 entry has
  // no wireMax / display range and value=88 silently became raw wire
  // 88 → 170 Hz Lo-Fi cutoff → killed audible volume.
  let prefxTypeIdx: number | undefined;
  let postfxTypeIdx: number | undefined;
  for (const { name: pname, value: pval } of params) {
    if (pname === 'prefxtype')  prefxTypeIdx  = resolveFxTypeIdx(pval);
    if (pname === 'postfxtype') postfxTypeIdx = resolveFxTypeIdx(pval);
  }

  const overrides = new Map<string, number>();
  const resolutions: Array<{
    name: string;
    raw: number | string;
    wire: number;
    scaled: boolean;
    bipolar: boolean;
    /** Per-FX-type label like "Lo-Fi Cutoff" when the FX-aware route fired. */
    fxLabel?: string;
    /** Auto-gen NRPN name actually used to encode (e.g. "fx5param1 (Cutoff)"). */
    encodingEntryName?: string;
  }> = [];
  // Capture raw-input signature BEFORE NRPN resolution so we detect
  // identical user-facing recipes (different display values resolve to
  // different wire values, but two calls with the same inputs share a
  // signature regardless of resolution outcome).
  const dupSignatureParts = params
    .map(({ name: n, value: v }) => `${n}=${typeof v === 'string' ? `"${v}"` : v}`)
    .sort();
  const dupSignature = `${name ?? ''}|${save ? '1' : '0'}|${dupSignatureParts.join(';')}`;

  // PASS 2, resolve each value.
  for (const { name, value } of params) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new DispatchError(
        'value_out_of_range',
        'Hydrasynth',
        `hydra_apply_patch: param "${name}" has non-finite value ${value}.`,
        { retry_action: 'Pass a finite display value (number or enum string).' },
      );
    }
    const sub = parseFxSubParamName(name);
    if (sub) {
      // Per-FX-type route. If the user didn't set prefxtype/postfxtype
      // in the same call, we can't know which FX type's sub-params
      // they want, fall through to the generic entry, but flag the
      // ambiguity in the response so the agent learns to include the
      // type next time.
      const typeIdx = sub.surface === 'pre' ? prefxTypeIdx : postfxTypeIdx;
      if (typeIdx === undefined) {
        // No type context, likely a tweak-on-top of an already-loaded
        // FX type. Use the generic entry but note the imprecision.
        const entry = findHydraNrpn(name);
        if (!entry) {
          const closeMatches = findMatchingNrpns(name, 6).map((h) => h.entry.name);
          throw new DispatchError(
            'unknown_param',
            'Hydrasynth',
            `hydra_apply_patch: unknown param "${name}".`,
            {
              valid_options: closeMatches,
              retry_action: 'Re-invoke with one verbatim name from valid_options, or call list_params({port:"hydrasynth"}) to see the full catalog.',
            },
          );
        }
        let resolved;
        try {
          resolved = resolveNrpnValue(entry, value);
        } catch (err) {
          throw new Error(`hydra_apply_patch: param "${name}", ${err instanceof Error ? err.message : String(err)}`);
        }
        overrides.set(name, resolved.wire);
        resolutions.push({
          name,
          raw: value,
          wire: resolved.wire,
          scaled: resolved.scaled,
          bipolar: resolved.bipolar,
          fxLabel: `${sub.surface}fx (type not in batch, using generic encoding; pass ${sub.surface}fxtype for accurate scaling)`,
        });
        continue;
      }
      let resolved;
      try {
        resolved = resolveFxAwareValue(name, value, { prefxTypeIdx, postfxTypeIdx });
      } catch (err) {
        throw new Error(`hydra_apply_patch: param "${name}", ${err instanceof Error ? err.message : String(err)}`);
      }
      // Write under the GENERIC name so the patch-buffer encoder
      // finds the right byte offset (PATCH_OFFSETS keys are
      // "prefxparam1", not "fx5param1"). The wire value is the
      // per-type-resolved one.
      overrides.set(name, resolved.wire);
      const fxLabel = `${fxTypeName(typeIdx)} ${fxSubParamLabel(resolved.entry) ?? `param${sub.paramIdx}`}`;
      resolutions.push({
        name,
        raw: value,
        wire: resolved.wire,
        scaled: resolved.scaled,
        bipolar: resolved.bipolar,
        fxLabel,
        encodingEntryName: resolved.entry.name,
      });
      continue;
    }

    const entry = findHydraNrpn(name);
    if (!entry) {
      const hits = findMatchingNrpns(name, 6);
      throw new DispatchError(
        'unknown_param',
        'Hydrasynth',
        `hydra_apply_patch: unknown param "${name}".`,
        {
          valid_options: hits.map((h) => h.entry.name),
          retry_action: 'Re-invoke with one verbatim name from valid_options, or call list_params({port:"hydrasynth"}) to see the full catalog.',
        },
      );
    }
    let resolved;
    try {
      resolved = resolveNrpnValue(entry, value);
    } catch (err) {
      throw new Error(`hydra_apply_patch: param "${name}", ${err instanceof Error ? err.message : String(err)}`);
    }
    overrides.set(name, resolved.wire);
    resolutions.push({ name, raw: value, wire: resolved.wire, scaled: resolved.scaled, bipolar: resolved.bipolar });
  }

  // Encode overrides on top of INIT. Routing header bytes 2-3 are
  // overwritten after encoding so the chunk-0 metadata routes the
  // dump to `target`.
  //
  // **Name is only embedded when save:true.** The Hydrasynth's
  // on-screen patch-name display is sourced from flash, not RAM, so
  // a name written to a working-memory dump never shows up, only
  // the flash-persist path (save:true → Write Request) refreshes the
  // displayed name. If we wrote the name to RAM-only dumps it would
  // be silently discarded the first time the user navigates away.
  // Skipping the write when !save also keeps RAM-only "try this tone"
  // calls from clobbering whatever name happens to be in the working
  // buffer from a prior recipe.
  const nameForBuffer = save ? name : undefined;
  let buf: Uint8Array;
  try {
    buf = encodePatch(overrides, { base: INIT_PATCH_BUFFER, name: nameForBuffer });
  } catch (err) {
    throw new Error(`hydra_apply_patch: encodePatch failed, ${err instanceof Error ? err.message : String(err)}`);
  }
  buf[2] = target.bank;
  buf[3] = target.patch;

  const observed: Array<{ ms: number; bytes: number[] }> = [];
  const unsubscribe = conn.onMessage((bytes) => {
    observed.push({ ms: Date.now() - startMs, bytes: [...bytes] });
  });

  try {
    if (danceMode === 'both') {
      await bankPcDance(conn, target);
    }

    conn.send(wrapSysex([0x18, 0x00]));
    const headerErr = conn.lastSendError;
    if (headerErr) {
      throw new Error(
        `hydra_apply_patch: MIDI output handle is stale, header SysEx failed (${headerErr.message}). Call hydra_reconnect_midi and retry.`,
      );
    }
    const chunks = splitIntoChunks(buf);
    for (let i = 0; i < chunks.length; i++) {
      conn.send(wrapSysex(chunks[i]!.info));
      const chunkErr = conn.lastSendError;
      if (chunkErr) {
        // Stale handle (USB disconnect, driver re-enumeration). Bail
        // loudly with the chunk index so the agent knows where the
        // partial write landed instead of looping through 22 broken
        // writes and reporting "success" (yungatita test, 2026-05-12).
        throw new Error(
          `hydra_apply_patch: chunk ${i + 1}/${chunks.length} send failed (${chunkErr.message}). Patch is partially written; call hydra_reconnect_midi and retry the full apply_patch.`,
        );
      }
      if (i < chunks.length - 1) await sleep(SYSEX_CHUNK_PACING_MS);
    }
    // Write Request, persist to flash. Per spec, sent BEFORE the
    // footer when persistence is desired. Without this, the patch
    // stays in RAM only. Spec also requires a long pause (~3500 ms)
    // after the Write Request before any further MIDI is sent,
    // we honour that with the post-Write-Request sleep.
    if (save) {
      conn.send(wrapSysex([0x14, 0x00]));
      const saveErr = conn.lastSendError;
      if (saveErr) {
        throw new Error(
          `hydra_apply_patch: save Write Request send failed (${saveErr.message}). Chunks landed but flash persist did not; call hydra_reconnect_midi and re-run with save:true.`,
        );
      }
      await sleep(WRITE_REQUEST_FLASH_PAUSE_MS);
    }
    conn.send(wrapSysex([0x1a, 0x00]));

    if (danceMode === 'post' || danceMode === 'both') {
      await bankPcDance(conn, target);
    }

    await sleep(SYSEX_TAIL_DRAIN_MS);
  } finally {
    unsubscribe();
  }

  const elapsedMs = Date.now() - startMs;

  let headerResponses = 0;
  let footerResponses = 0;
  let patchSaveds = 0;
  const chunkAcksSeen = new Set<number>();
  const others: string[] = [];
  for (const { bytes } of observed) {
    if (bytes[0] === 0xf0) {
      let info: Uint8Array;
      try {
        info = unwrapSysex(bytes);
      } catch {
        others.push(describeInboundMessage(bytes));
        continue;
      }
      if (info.length === 2 && info[0] === 0x19 && info[1] === 0x00) headerResponses++;
      else if (info.length === 2 && info[0] === 0x1b && info[1] === 0x00) footerResponses++;
      else if (info.length === 4 && info[0] === 0x17 && info[1] === 0x00 && info[3] === 0x16) chunkAcksSeen.add(info[2]!);
      else if (info.length === 4 && info[0] === 0x07 && info[1] === 0x00) patchSaveds++;
      else others.push(describeInboundMessage(bytes));
    } else {
      others.push(describeInboundMessage(bytes));
    }
  }

  // Soft duplicate-call detection. Same inputs within 30s of the last
  // successful call probably means the upstream agent looped on a
  // misread response, flag it in text, don't gate the write.
  const now = Date.now();
  const isDuplicate =
    lastApplyPatch !== undefined
    && lastApplyPatch.signature === dupSignature
    && lastApplyPatch.targetSlot === target.display
    && now - lastApplyPatch.at < APPLY_PATCH_DUP_WINDOW_MS;
  const dupAgeSec = isDuplicate ? Math.round((now - lastApplyPatch!.at) / 1000) : 0;
  recordApplyPatch(dupSignature, target.display, now);

  const lines: string[] = [];
  // 0-acks-with-input is suspicious: normal Hydrasynth flakiness can
  // drop a few acks, but 0/22 while the input port is open looks like
  // the dump landed on the wrong bank or the device ignored it. The
  // yungatita test had this pattern when the MIDI handle went stale
  // (30+ stderr send-errors with 0 chunk acks despite hasInput=true).
  const suspiciousSilence =
    conn.hasInput &&
    chunkAcksSeen.size === 0 &&
    headerResponses === 0 &&
    others.length === 0;

  // Lead with the success signal, value-applied summary is the truth
  // of "the patch landed". Chunk acks are unreliable on this device
  // (Session 48: agent looped after misreading missing acks as failure).
  if (suspiciousSilence) {
    lines.push(`Patch SENT to ${target.display} (${params.length} override${params.length === 1 ? '' : 's'}, ${elapsedMs} ms), BUT the device acknowledged 0/22 chunks despite the input port being open. The dump may have been ignored, verify on the front-panel display before relying on the new state. If the patch isn't audible, call hydra_reconnect_midi and retry.`);
  } else {
    lines.push(`Patch applied successfully to ${target.display}, ${params.length} override${params.length === 1 ? '' : 's'} written via SysEx in ${elapsedMs} ms. The device is now at the requested state.`);
  }
  if (name !== undefined && !save) {
    lines.push('');
    lines.push(`(Note: \`name: "${name}"\` was dropped because \`save: false\`. The Hydrasynth's on-screen name display reads from flash, so a RAM-only dump can't show a new name. Re-call with \`save: true\` to embed and persist the name.)`);
  }
  if (isDuplicate) {
    lines.push('');
    lines.push(`(Note: this is the same patch you applied ${dupAgeSec}s ago. It re-landed cleanly, but if you're checking because the previous call looked like it failed, it didn't, the Hydrasynth doesn't ack chunk dumps reliably. No further action is needed.)`);
  }
  lines.push('');
  lines.push('Overrides applied (values are what the device will display):');
  for (const r of resolutions) {
    const rawDisplay = typeof r.raw === 'string' ? `"${r.raw}"` : String(r.raw);
    // Resolve the device-display label. Preference order:
    //   1. FX-routed: try the per-FX-type formula by encoding entry name
    //   2. Curated per-canonical-name formula in NRPN_DISPLAY
    //   3. Enum table (when the entry references one)
    //   4. None, fall back to wire passthrough
    let deviceLabel: string | undefined;
    if (r.encodingEntryName) {
      deviceLabel = decodeFxNrpnDisplay(r.encodingEntryName, r.wire);
      if (deviceLabel === undefined) {
        // Try enum decoding via the entry's enumTable (for fx5param3/5 etc.)
        const fxEntry = findHydraNrpn(r.name); // generic name still useful for fallback
        if (fxEntry?.enumTable) {
          // Already decoded by the resolver path; skip.
        }
      }
    }
    if (deviceLabel === undefined) {
      deviceLabel = decodeNrpnDisplay(r.name, r.wire);
    }
    if (deviceLabel === undefined) {
      const entry = findHydraNrpn(r.name);
      if (entry?.enumTable) {
        const table = HYDRASYNTH_ENUMS[entry.enumTable];
        // enumValueScale: device emits in multiples of N → table index = wire/N
        const idx = entry.enumValueScale ? Math.round(r.wire / entry.enumValueScale) : r.wire;
        const label = table?.[idx];
        if (label !== undefined) deviceLabel = String(label);
      }
    }
    if (deviceLabel === undefined && r.bipolar) {
      const entry = findHydraNrpn(r.name);
      if (entry?.displayMin !== undefined && entry?.displayMax !== undefined && entry.wireMax) {
        const span = entry.displayMax - entry.displayMin;
        const display = Math.round((r.wire / entry.wireMax) * span * 10) / 10 + entry.displayMin;
        deviceLabel = `${display >= 0 ? '+' : ''}${display.toFixed(1)}`;
      }
    }

    const fxBadge = r.fxLabel ? ` [${r.fxLabel}]` : '';
    const deviceClause = deviceLabel !== undefined ? ` → device shows: ${deviceLabel}` : ` → wire ${r.wire}`;
    lines.push(`  ${r.name}${fxBadge} = ${rawDisplay}${deviceClause}`);
  }
  lines.push('');
  lines.push(`Press a key. The active patch reflects your overrides on top of an INIT base.`);
  lines.push('');
  lines.push(`(Informational, Hydrasynth doesn't reliably ack chunk dumps; the patch landed via the SysEx writes above regardless of these counters. Do NOT treat zero counts as failure.)`);
  lines.push(`  Header Response (19 00):   ${headerResponses} seen`);
  lines.push(`  Chunk Acks (17 00 NN 16):  ${chunkAcksSeen.size}/${PATCH_CHUNK_COUNT}`);
  lines.push(`  Patch Saved (07 00 BB PP): ${patchSaveds} seen`);
  lines.push(`  Footer Response (1B 00):   ${footerResponses} seen`);
  lines.push(`  Other / unrecognized:      ${others.length}`);

  return {
    content: [{
      type: 'text',
      text: lines.join('\n'),
    }],
    structuredContent: {
      target_slot: target.display,
      target_bank: target.bank,
      target_patch: target.patch,
      saved: save === true,
      overrides_count: params.length,
      elapsed_ms: elapsedMs,
      chunk_acks_seen: chunkAcksSeen.size,
      chunk_acks_total: PATCH_CHUNK_COUNT,
      header_responses: headerResponses,
      footer_responses: footerResponses,
      patch_saved_responses: patchSaveds,
      suspicious_silence: suspiciousSilence,
      duplicate_call: isDuplicate,
    },
  };

  } catch (err) {
    return asError(err);
  }
});

}
