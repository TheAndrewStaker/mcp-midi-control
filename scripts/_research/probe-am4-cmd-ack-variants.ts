/**
 * AM4 cmd-ack-only opcode follow-up probe
 * =======================================
 *
 * Session 104 (2026-05-20). The initial Session 104 probe pack
 * (probe-am4-action-reads.ts + probe-am4-action-writes.ts) hit each
 * unverified action with a SINGLE addressing variant. 16 of those
 * actions returned 18-byte cmd-acks — meaning the device acknowledged
 * the action but didn't return data. Cmd-ack-only is interpretable
 * as "wire shape almost right; needs different payload or addressing".
 *
 * This follow-up probe re-tests each cmd-ack-only action with MULTIPLE
 * payload variants: empty / 4-byte u32 / 8-byte u64 / 32-byte ASCII /
 * different addressing scopes (block-level / preset-level / global).
 *
 * # Goal
 *
 * For each of the 16 cmd-ack-only opcodes, find the wire shape that
 * causes the device to return STRUCTURED DATA (>= 23-byte response)
 * instead of the bare 18-byte cmd-ack.
 *
 * Sub-goal: for the WRITE-style cmd-ack opcodes (TOGGLE, PLACE_EFFECT,
 * COPY_SCENE, SWAP_SCENES, etc.), confirm whether they ACTUALLY took
 * effect via a working-buffer read after each write.
 *
 * # Safety
 *
 *   - Read-style probes (Tier 1 in PROBES) are read-only.
 *   - Write-style probes (Tier 2 in PROBES) need --writes flag.
 *     Each writes uses a baseline AMP.GAIN read + after-state read
 *     to detect any side effect. Gated to Z04.
 *
 * # Run
 *
 *   Dry-run: npx tsx scripts/_research/probe-am4-cmd-ack-variants.ts
 *   Live:    npx tsx scripts/_research/probe-am4-cmd-ack-variants.ts --writes
 *
 * # Findings output
 *
 *   - samples/captured/probe-am4-cmd-ack-variants.syx
 *   - samples/captured/probe-am4-cmd-ack-variants-findings.md
 *
 * For each opcode, the findings file lists every (addressing × payload)
 * variant tried, with the response shape per variant. The shortest
 * route to "device returned structured data" wins.
 */

import midi from 'midi';
import { writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import {
  BLOCK_TYPE_VALUES,
  buildReadParam,
  buildSwitchPreset,
  buildSetParam,
  isReadResponse,
  parseReadResponse,
  KNOWN_PARAMS,
} from 'fractal-midi/am4';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const AM4_MODEL = 0x15;
const FUNC_PARAM_RW = 0x01;

function fractalChecksum(bytes: number[]): number {
  return bytes.reduce((acc, b) => acc ^ b, 0) & 0x7f;
}

function encode14(n: number): [number, number] {
  if (n < 0 || n > 0x3fff) throw new Error(`14-bit value out of range: ${n}`);
  return [n & 0x7f, (n >> 7) & 0x7f];
}

function packBytes(raw: number[]): number[] {
  if (raw.length === 0) return [];
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const b of raw) {
    buf |= (b & 0xff) << bits;
    bits += 8;
    while (bits >= 7) {
      out.push(buf & 0x7f);
      buf >>= 7;
      bits -= 7;
    }
  }
  if (bits > 0) out.push(buf & 0x7f);
  return out;
}

function buildFrame(opts: {
  pidLow: number; pidHigh: number; action: number;
  hdr3?: number; payload?: number[];
}): number[] {
  const { pidLow, pidHigh, action, hdr3 = 0x0000, payload = [] } = opts;
  const head = [
    SYSEX_START, ...FRACTAL_MFR, AM4_MODEL, FUNC_PARAM_RW,
    ...encode14(pidLow), ...encode14(pidHigh), ...encode14(action),
    ...encode14(hdr3), ...encode14(payload.length),
    ...packBytes(payload),
  ];
  const cs = fractalChecksum(head);
  return [...head, cs, SYSEX_END];
}

function toHex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function findPort(io: midi.Input | midi.Output, needles: string[]): number {
  for (let i = 0; i < io.getPortCount(); i++) {
    const name = io.getPortName(i);
    for (const n of needles) {
      if (name.toLowerCase().includes(n.toLowerCase())) {
        console.log(`  matched port [${i}] ${name}`);
        return i;
      }
    }
  }
  return -1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Common addressing scopes to try per opcode.
const AMP_PID = BLOCK_TYPE_VALUES.amp;
const DRIVE_PID = BLOCK_TYPE_VALUES.drive;
const REVERB_PID = BLOCK_TYPE_VALUES.reverb;
const PRESET_LEVEL_PIDLOW = 0x00ce;
const PRESET_LEVEL_PIDHIGH = 0x000b;

const AMP_GAIN = KNOWN_PARAMS['amp.gain']!;

function buildPayload(kind: 'empty' | 'u32-zero' | 'u32-one' | 'u32-current' | 'u64-zero' | 'ascii-32'): number[] {
  switch (kind) {
    case 'empty': return [];
    case 'u32-zero': return [0, 0, 0, 0];
    case 'u32-one': return [1, 0, 0, 0];
    case 'u32-current': return [0, 0, 0, 0]; // current scene/loc — same as 0
    case 'u64-zero': return [0, 0, 0, 0, 0, 0, 0, 0];
    case 'ascii-32': return Array.from('Z'.repeat(32)).map(c => c.charCodeAt(0));
  }
}

interface VariantSpec {
  pidLow: number;
  pidHigh: number;
  payload: number[];
  label: string;
}

interface ProbeDef {
  action: number;
  opcodeName: string;
  /** Variants to try in order. */
  variants: VariantSpec[];
  /** If true, this is a write — require --writes flag. */
  isWrite?: boolean;
  /** Notes about what we're looking for. */
  hypothesis?: string;
}

const PROBES: ProbeDef[] = [
  // ── READS that came back cmd-ack only ──────────────────────────

  // 0x1A MESSAGE_GET_VAL_AND_STR
  {
    action: 0x1a, opcodeName: 'MESSAGE_GET_VAL_AND_STR',
    hypothesis: 'value + display string in one response',
    variants: [
      { pidLow: AMP_PID, pidHigh: AMP_GAIN.pidHigh, payload: [], label: 'AMP.GAIN, empty' },
      { pidLow: AMP_PID, pidHigh: AMP_GAIN.pidHigh, payload: [0,0,0,0], label: 'AMP.GAIN, u32-zero (maybe scene selector?)' },
      { pidLow: AMP_PID, pidHigh: AMP_GAIN.pidHigh, payload: [0,0,0,0,0,0,0,0], label: 'AMP.GAIN, u64-zero' },
      { pidLow: REVERB_PID, pidHigh: 0x0001, payload: [], label: 'REVERB.MIX, empty' },
    ],
  },

  // 0x1D MESSAGE_GET_PATCH_NAME_BY_NUM
  {
    action: 0x1d, opcodeName: 'MESSAGE_GET_PATCH_NAME_BY_NUM',
    hypothesis: 'preset-name read by location (alternate to working action=0x12)',
    variants: [
      { pidLow: 0x0000, pidHigh: 0x0000, payload: [0,0,0,0], label: 'global, location-0' },
      { pidLow: 0x0000, pidHigh: 0x0000, payload: [103,0,0,0], label: 'global, location-103 (Z04)' },
      { pidLow: 0x00ce, pidHigh: 0x000a, payload: [0,0,0,0], label: 'preset-level pidHigh=0x0A (SWITCH addr), loc-0' },
      { pidLow: 0x00ce, pidHigh: 0x000b, payload: [0,0,0,0], label: 'preset-level pidHigh=0x0B (RENAME addr), loc-0' },
    ],
  },

  // 0x1E MESSAGE_GET_ALL_SCENE_NAMES
  {
    action: 0x1e, opcodeName: 'MESSAGE_GET_ALL_SCENE_NAMES',
    hypothesis: 'bulk-return all 4 scene names',
    variants: [
      { pidLow: 0x0000, pidHigh: 0x0000, payload: [], label: 'global, empty' },
      { pidLow: 0x0000, pidHigh: 0x0000, payload: [0,0,0,0], label: 'global, u32-zero' },
      { pidLow: 0x00ce, pidHigh: 0x000d, payload: [], label: 'preset-level pidHigh=0x0D (SCENE_SWITCH addr), empty' },
      { pidLow: 0x00ce, pidHigh: 0x0037, payload: [], label: 'preset-level pidHigh=0x37 (SCENE_RENAME base), empty' },
    ],
  },

  // 0x20 MESSAGE_GET_GRID_INFO
  {
    action: 0x20, opcodeName: 'MESSAGE_GET_GRID_INFO',
    hypothesis: 'grid layout via dispatcher (vs top-level fn 0x20)',
    variants: [
      { pidLow: 0x0000, pidHigh: 0x0000, payload: [], label: 'global, empty' },
      { pidLow: 0x0000, pidHigh: 0x0000, payload: [0,0,0,0], label: 'global, u32-zero' },
      { pidLow: 0x00ce, pidHigh: 0x000f, payload: [], label: 'preset-level pidHigh=0x0F (slot-1 base), empty' },
    ],
  },

  // 0x25 MESSAGE_GET_EFFECT_AVAIL
  {
    action: 0x25, opcodeName: 'MESSAGE_GET_EFFECT_AVAIL',
    hypothesis: 'list of available effect types',
    variants: [
      { pidLow: 0x0000, pidHigh: 0x0000, payload: [], label: 'global, empty' },
      { pidLow: 0x0000, pidHigh: 0x0000, payload: [0,0,0,0], label: 'global, u32-zero' },
      { pidLow: 0x00ce, pidHigh: 0x000f, payload: [], label: 'preset-level slot-1, empty' },
      { pidLow: 0x00ce, pidHigh: 0x0010, payload: [], label: 'preset-level slot-2, empty' },
    ],
  },

  // 0x2C MESSAGE_GET_SPI_ADC
  {
    action: 0x2c, opcodeName: 'MESSAGE_GET_SPI_ADC',
    hypothesis: 'hardware diagnostic — knob/pedal ADC reading',
    variants: [
      { pidLow: 0x0000, pidHigh: 0x0000, payload: [], label: 'global, empty' },
      { pidLow: 0x0000, pidHigh: 0x0001, payload: [], label: 'pidHigh=1 (channel 1?), empty' },
      { pidLow: 0x0000, pidHigh: 0x0002, payload: [], label: 'pidHigh=2 (channel 2?), empty' },
      { pidLow: 0x0000, pidHigh: 0x0000, payload: [0,0,0,0], label: 'global, u32-zero (channel id?)' },
    ],
  },

  // 0x31 MESSAGE_GET_SCENE_NAME_BY_NUM
  {
    action: 0x31, opcodeName: 'MESSAGE_GET_SCENE_NAME_BY_NUM',
    hypothesis: 'single scene name by index',
    variants: [
      { pidLow: 0x0000, pidHigh: 0x0000, payload: [0,0,0,0], label: 'global, scene 0' },
      { pidLow: 0x0000, pidHigh: 0x0000, payload: [1,0,0,0], label: 'global, scene 1' },
      { pidLow: 0x00ce, pidHigh: 0x000d, payload: [0,0,0,0], label: 'preset-level pidHigh=0x0D, scene 0' },
      { pidLow: 0x00ce, pidHigh: 0x0037, payload: [0,0,0,0], label: 'preset-level pidHigh=0x37 (RENAME base), scene 0' },
    ],
  },

  // ── 0x2B MESSAGE_GET_METER — confirmed dead-end ────────────────
  // 100-sample variance test in probe-am4-meter.ts returned constant
  // cmd-ack even during active guitar playing. SKIPPED here.
  // (We could try a SUBSCRIBE-style payload, but that's a research
  // bet without strong evidence; deferred.)

  // ── WRITES that came back cmd-ack only ─────────────────────────

  // 0x07 MESSAGE_TOGGLE
  {
    action: 0x07, opcodeName: 'MESSAGE_TOGGLE', isWrite: true,
    hypothesis: 'toggle bypass; baseline=AMP.GAIN read before+after',
    variants: [
      { pidLow: AMP_PID, pidHigh: 0x0003, payload: [], label: 'AMP bypass register' },
      // Try AMP.GAIN directly (toggle on continuous? maybe wraps around midpoint).
      { pidLow: AMP_PID, pidHigh: AMP_GAIN.pidHigh, payload: [], label: 'AMP.GAIN (continuous param toggle?)' },
    ],
  },

  // 0x1C MESSAGE_RECALL_PATCH — already gated to Z04.
  // Front-panel verification needed; baseline read alone won't detect.
  // Re-test with location index 5 (something OTHER than Z04) and see
  // if the preset display changes.
  {
    action: 0x1c, opcodeName: 'MESSAGE_RECALL_PATCH', isWrite: true,
    hypothesis: 'load preset from location',
    variants: [
      { pidLow: PRESET_LEVEL_PIDLOW, pidHigh: PRESET_LEVEL_PIDHIGH, payload: [103,0,0,0], label: 'pidHigh=0x0B, Z04 (no-change)' },
      { pidLow: PRESET_LEVEL_PIDLOW, pidHigh: 0x000a, payload: [103,0,0,0], label: 'pidHigh=0x0A (SWITCH addr), Z04' },
    ],
  },

  // 0x22 MESSAGE_PLACE_EFFECT
  {
    action: 0x22, opcodeName: 'MESSAGE_PLACE_EFFECT', isWrite: true,
    hypothesis: 'place block in slot — verify via grid read after',
    variants: [
      { pidLow: 0x00ce, pidHigh: 0x0012, payload: [REVERB_PID, 0, 0, 0], label: 'pidHigh=0x12 (slot-4), payload REVERB' },
      { pidLow: 0x00ce, pidHigh: 0x000f, payload: [REVERB_PID, 0, 0, 0], label: 'pidHigh=0x0F (slot-1), payload REVERB' },
      // Try without preset-level address — maybe the block id IS the pidLow.
      { pidLow: REVERB_PID, pidHigh: 0x0012, payload: [], label: 'pidLow=REVERB, pidHigh=0x12 (slot)' },
    ],
  },

  // 0x2D MESSAGE_COPY_CHANNEL
  {
    action: 0x2d, opcodeName: 'MESSAGE_COPY_CHANNEL', isWrite: true,
    hypothesis: 'copy channel A→B',
    variants: [
      { pidLow: AMP_PID, pidHigh: 0x0000, payload: [0, 1, 0, 0], label: 'AMP, payload [src=0, dst=1]' },
      { pidLow: AMP_PID, pidHigh: 0x0000, payload: [0, 0, 0, 0, 1, 0, 0, 0], label: 'AMP, 8-byte payload [u32 src, u32 dst]' },
    ],
  },

  // 0x2E MESSAGE_COPY_SCENE
  {
    action: 0x2e, opcodeName: 'MESSAGE_COPY_SCENE', isWrite: true,
    hypothesis: 'copy scene 0→1',
    variants: [
      { pidLow: PRESET_LEVEL_PIDLOW, pidHigh: PRESET_LEVEL_PIDHIGH, payload: [0, 1, 0, 0], label: 'preset-level, payload [src=0, dst=1]' },
      { pidLow: PRESET_LEVEL_PIDLOW, pidHigh: 0x000d, payload: [0, 1, 0, 0], label: 'pidHigh=0x0D (SCENE_SWITCH addr), payload [0,1]' },
      { pidLow: PRESET_LEVEL_PIDLOW, pidHigh: PRESET_LEVEL_PIDHIGH, payload: [0, 0, 0, 0, 1, 0, 0, 0], label: 'preset-level, 8-byte payload' },
    ],
  },

  // 0x32 MESSAGE_SWAP_SCENES
  {
    action: 0x32, opcodeName: 'MESSAGE_SWAP_SCENES', isWrite: true,
    hypothesis: 'swap scenes 0↔1',
    variants: [
      { pidLow: PRESET_LEVEL_PIDLOW, pidHigh: PRESET_LEVEL_PIDHIGH, payload: [0, 1, 0, 0], label: 'preset-level, payload [s1=0, s2=1]' },
      { pidLow: PRESET_LEVEL_PIDLOW, pidHigh: 0x000d, payload: [0, 1, 0, 0], label: 'pidHigh=0x0D, payload [0,1]' },
    ],
  },

  // 0x23 MESSAGE_RESET_EFFECT — initial probe got 0 inbound. Retry.
  {
    action: 0x23, opcodeName: 'MESSAGE_RESET_EFFECT', isWrite: true,
    hypothesis: 'reset block to defaults',
    variants: [
      { pidLow: AMP_PID, pidHigh: 0x0000, payload: [], label: 'AMP, empty' },
      { pidLow: AMP_PID, pidHigh: 0x0000, payload: [0, 0, 0, 0], label: 'AMP, u32-zero' },
      { pidLow: REVERB_PID, pidHigh: 0x0000, payload: [], label: 'REVERB, empty' },
    ],
  },

  // 0x08 MESSAGE_DEFAULT — no specific target. Probably no-op.
  {
    action: 0x08, opcodeName: 'MESSAGE_DEFAULT', isWrite: true,
    hypothesis: 'broad default (likely no-op probe)',
    variants: [
      { pidLow: 0x0000, pidHigh: 0x0000, payload: [], label: 'global, empty' },
      { pidLow: AMP_PID, pidHigh: 0x0000, payload: [], label: 'AMP-scope, empty' },
    ],
  },

  // 0x18 MESSAGE_EXECUTE
  {
    action: 0x18, opcodeName: 'MESSAGE_EXECUTE', isWrite: true,
    hypothesis: 'no-arg side effect',
    variants: [
      { pidLow: 0x0000, pidHigh: 0x0000, payload: [], label: 'global, empty' },
      { pidLow: 0x0000, pidHigh: 0x0000, payload: [0, 0, 0, 0], label: 'global, u32-zero' },
    ],
  },
];

// ──────────────────────────────────────────────────────────────────
// Runner
// ──────────────────────────────────────────────────────────────────

async function readAmpGainBaseline(output: midi.Output, collected: number[][]): Promise<number | null> {
  const req = buildReadParam(AMP_GAIN, 0x0e);
  const before = collected.length;
  output.sendMessage(req);
  await sleep(300);
  for (const f of collected.slice(before)) {
    if (isReadResponse(req, f)) {
      const p = parseReadResponse(f);
      return p.asUInt32LE();
    }
  }
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const liveWrites = args.includes('--writes');

  console.log('AM4 cmd-ack-only follow-up probe');
  console.log('═════════════════════════════════');
  console.log(`Live writes: ${liveWrites ? '🔴 YES' : '⚪ dry-run only'}`);

  const input = new midi.Input();
  const output = new midi.Output();
  console.log('\nInput ports:');
  for (let i = 0; i < input.getPortCount(); i++) console.log(`  [${i}] ${input.getPortName(i)}`);
  console.log('Output ports:');
  for (let i = 0; i < output.getPortCount(); i++) console.log(`  [${i}] ${output.getPortName(i)}`);

  const needles = ['AM4', 'Fractal', 'Axe Effects'];
  const outIdx = findPort(output, needles);
  if (outIdx < 0) { console.error('ERROR: AM4 output port not found'); process.exit(1); }
  const inIdx = findPort(input, needles);
  if (inIdx < 0) { console.error('ERROR: AM4 input port not found'); process.exit(1); }

  output.openPort(outIdx);
  input.ignoreTypes(false, true, true);
  const collected: number[][] = [];
  input.on('message', (_dt, bytes) => {
    if (bytes[0] === 0xf0) collected.push(bytes.slice());
  });
  input.openPort(inIdx);

  await sleep(500);
  collected.length = 0;

  // Setup: switch to Z04 for safety on writes.
  output.sendMessage(buildSwitchPreset(103));
  await sleep(800);
  collected.length = 0;

  interface VariantResult {
    variant: VariantSpec;
    inbound: number[][];
    baselineBefore?: number | null;
    baselineAfter?: number | null;
    notes: string[];
  }
  interface ProbeResult {
    def: ProbeDef;
    variants: VariantResult[];
  }
  const results: ProbeResult[] = [];

  for (const def of PROBES) {
    if (def.isWrite && !liveWrites) {
      console.log(`\n⏭  SKIP write (no --writes): action=0x${def.action.toString(16)} ${def.opcodeName}`);
      continue;
    }
    console.log(`\n══ action=0x${def.action.toString(16).padStart(2, '0')} ${def.opcodeName} ══`);
    if (def.hypothesis) console.log(`   ${def.hypothesis}`);
    const variantResults: VariantResult[] = [];
    for (const v of def.variants) {
      console.log(`\n  → ${v.label}`);
      const req = buildFrame({ pidLow: v.pidLow, pidHigh: v.pidHigh, action: def.action, payload: v.payload });
      console.log(`    SEND (${req.length}B): ${toHex(req)}`);

      let baselineBefore: number | null = null;
      if (def.isWrite) {
        baselineBefore = await readAmpGainBaseline(output, collected);
      }
      const before = collected.length;
      output.sendMessage(req);
      await sleep(500);
      const inbound = collected.slice(before);
      console.log(`    RX: ${inbound.length} frames`);
      for (const f of inbound) {
        console.log(`      len=${f.length} ${toHex(f.slice(0, Math.min(24, f.length)))}${f.length > 24 ? ' …' : ''}`);
      }

      let baselineAfter: number | null = null;
      if (def.isWrite) {
        baselineAfter = await readAmpGainBaseline(output, collected);
      }

      const notes: string[] = [];
      const nonEcho = inbound.filter((f) =>
        !(f.length === req.length && f.every((b, i) => b === req[i]))
      );
      if (nonEcho.length === 0) {
        notes.push('🔴 silent (no inbound except echo)');
      } else {
        const lengths = nonEcho.map((f) => f.length).sort((a, b) => b - a);
        const maxLen = lengths[0] ?? 0;
        if (maxLen <= 18) {
          notes.push(`⚪ cmd-ack only (len=${maxLen})`);
        } else if (maxLen === 23) {
          notes.push(`🟢 short-resp (23B) — structured payload`);
        } else {
          notes.push(`🟢 structured response (${maxLen}B)`);
        }
      }
      if (def.isWrite && baselineBefore !== null && baselineAfter !== null) {
        if (baselineBefore !== baselineAfter) {
          notes.push(`🟢 AMP.GAIN changed ${baselineBefore} → ${baselineAfter}`);
        } else {
          notes.push(`⚪ AMP.GAIN unchanged (${baselineBefore})`);
        }
      }
      for (const n of notes) console.log(`    ${n}`);

      variantResults.push({ variant: v, inbound, baselineBefore, baselineAfter, notes });
      await sleep(100);
    }
    results.push({ def, variants: variantResults });

    // After each write probe, reset AMP.GAIN to a known baseline.
    if (def.isWrite) {
      output.sendMessage(buildSetParam('amp.gain', 5.0));
      await sleep(200);
      collected.length = 0;
    }
  }

  // Cleanup
  output.sendMessage(buildSwitchPreset(103));
  await sleep(500);

  // ── Save outputs ────────────────────────────────────────────
  mkdirSync('samples/captured', { recursive: true });
  const syxOut = path.resolve('samples/captured/probe-am4-cmd-ack-variants.syx');
  const concat = results.flatMap((r) =>
    r.variants.flatMap((v) => {
      const req = buildFrame({ pidLow: v.variant.pidLow, pidHigh: v.variant.pidHigh, action: r.def.action, payload: v.variant.payload });
      return [...req, ...v.inbound.flat()];
    })
  );
  writeFileSync(syxOut, Uint8Array.from(concat));

  const md: string[] = [
    `# AM4 cmd-ack-only opcode follow-up — findings`,
    ``,
    `> Auto-generated by \`scripts/_research/probe-am4-cmd-ack-variants.ts\` at ${new Date().toISOString()}`,
    ``,
    `## Per-opcode best variant`,
    ``,
    `| Action | Opcode | Best variant | Verdict |`,
    `|---|---|---|---|`,
  ];
  for (const r of results) {
    const best = r.variants
      .map((v) => ({ v, score: scoreVariant(v) }))
      .sort((a, b) => b.score - a.score)[0];
    if (!best) continue;
    const verdict = best.v.notes.find((n) => n.startsWith('🟢')) ?? best.v.notes[0] ?? '—';
    md.push(`| 0x${r.def.action.toString(16).padStart(2, '0')} | ${r.def.opcodeName} | ${best.v.variant.label} | ${verdict} |`);
  }
  md.push('', '## Per-variant details', '');
  for (const r of results) {
    md.push(`### 0x${r.def.action.toString(16).padStart(2, '0')} ${r.def.opcodeName}`, '');
    if (r.def.hypothesis) md.push(`Hypothesis: ${r.def.hypothesis}`, '');
    for (const v of r.variants) {
      md.push(`**${v.variant.label}**`);
      const req = buildFrame({ pidLow: v.variant.pidLow, pidHigh: v.variant.pidHigh, action: r.def.action, payload: v.variant.payload });
      md.push('');
      md.push(`SEND: \`${toHex(req)}\``);
      md.push('');
      if (v.inbound.length === 0) {
        md.push('No inbound frames.');
      } else {
        md.push('Inbound:');
        md.push('```');
        for (const f of v.inbound) md.push(toHex(f));
        md.push('```');
      }
      if (v.baselineBefore !== undefined) md.push(`baseline AMP.GAIN before: ${v.baselineBefore}, after: ${v.baselineAfter}`);
      for (const n of v.notes) md.push(`- ${n}`);
      md.push('');
    }
    md.push('');
  }
  const mdOut = path.resolve('samples/captured/probe-am4-cmd-ack-variants-findings.md');
  writeFileSync(mdOut, md.join('\n'));
  console.log(`\nWrote findings to ${mdOut}`);

  input.closePort();
  output.closePort();
  process.exit(0);
}

function scoreVariant(v: { inbound: number[][]; notes: string[] }): number {
  let score = 0;
  for (const f of v.inbound) {
    if (f.length === 18) score += 1;
    else if (f.length === 23) score += 10;
    else if (f.length === 64) score += 30;
    else if (f.length > 64) score += 50;
  }
  if (v.notes.some((n) => n.includes('changed'))) score += 100;
  return score;
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
