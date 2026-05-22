/**
 * One-time migration: split `docs/_private/STATE.md` into a slim
 * orchestrator file + per-device shards (`STATE-AM4.md`,
 * `STATE-AXEFX2.md`, `STATE-AXEFX3.md`, `STATE-HYDRA.md`).
 *
 * Why: STATE.md has grown to 14K+ lines, mostly chronological session
 * entries. Parallel agents working on different devices race on the
 * same file. The HARDWARE-TASKS-*.md split solved the same problem for
 * the hardware backlog; this mirrors that pattern for the session log.
 *
 * Algorithm:
 *
 *   1. Split STATE.md into preamble + session blocks + tail.
 *      - Preamble = everything before the first `> ### Session N ...` or
 *        `> ## Session N ...` heading.
 *      - Session blocks run from one session heading to just before the
 *        next, OR to the start of the tail.
 *      - Tail = from the first non-quoted `## Archived follow-ups` /
 *        `## How to use this file` / `---` section through EOF.
 *
 *   2. Tag each session by device using keyword counts. A session
 *      assigns to a device only if (a) that device has >= MIN_HITS
 *      keyword matches AND (b) it leads the next-highest device by a
 *      DOMINANCE factor. Otherwise the session stays in main STATE.md
 *      (cross-device / cookbook / MCP-server-architecture material).
 *
 *   3. Write the slim main STATE.md (preamble + cross-device sessions
 *      + per-device index pointers + tail) and four device shards.
 *
 * Modes: `--dry-run` prints the partition plan + line-count summary
 * without writing. Default mode writes the new files. STATE.md is
 * backed up to `STATE.md.pre-split-backup` before overwrite.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = path.resolve(HERE, '..');
const STATE_DIR = path.join(MCP_ROOT, 'docs', '_private');
const STATE_PATH = path.join(STATE_DIR, 'STATE.md');
const BACKUP_PATH = path.join(STATE_DIR, 'STATE.md.pre-split-backup');

const SESSION_HEADING_RE = /^>\s+#{2,4}\s+Session\s+(\d+)/i;
const TAIL_START_RES: RegExp[] = [
  /^##\s+Archived follow-ups/,
  /^##\s+How to use this file/,
];

const MIN_HITS = 3;
const DOMINANCE = 2; // primary device must have >= 2x the runner-up

type DeviceKey = 'AM4' | 'AXEFX2' | 'AXEFX3' | 'HYDRA';

interface DeviceProfile {
  key: DeviceKey;
  shardFile: string;
  shardTitle: string;
  /**
   * Strong patterns prove the session is "about" this device. Required
   * to be present (>=1 hit) before any bare patterns count.
   */
  strongPatterns: RegExp[];
  /**
   * Bare patterns inflate the score once a strong pattern is present.
   * Without a strong pattern's anchor, bare hits do NOT count, so
   * generic substrings like "II" / "III" in passing don't drag a
   * Hydra or cross-device session into a Fractal shard.
   */
  barePatterns: RegExp[];
}

const DEVICE_PROFILES: DeviceProfile[] = [
  {
    key: 'AM4',
    shardFile: 'STATE-AM4.md',
    shardTitle: 'Fractal AM4',
    strongPatterns: [
      /\bAM4\b/g,
      /\bam4_[a-z]/g,
      /\bAM4-Edit\b/gi,
    ],
    barePatterns: [],
  },
  {
    key: 'AXEFX2',
    shardFile: 'STATE-AXEFX2.md',
    shardTitle: 'Fractal Axe-Fx II XL+',
    strongPatterns: [
      /\bAxe-Fx II\b/g,
      /\baxefx2_[a-z]/g,
      /\bAxeEdit\.exe\b/g,
      /\baxe-edit-ii\b/gi,
      /\baxe-fx-ii\b/g,
    ],
    barePatterns: [
      // Bare "II" only counts when at least one strong pattern is
      // already present. The word-boundary check rules out matching
      // inside "III" (no boundary between second and third I).
      /\bII\b/g,
    ],
  },
  {
    key: 'AXEFX3',
    shardFile: 'STATE-AXEFX3.md',
    shardTitle: 'Fractal Axe-Fx III',
    strongPatterns: [
      /\bAxe-Fx III\b/g,
      /\baxefx3_[a-z]/g,
      /\baxe-edit-iii\b/gi,
      /\baxe-fx-iii\b/g,
      /\bAxeEdit III\b/g,
      /\bFM3\b/g,
      /\bFM9\b/g,
    ],
    barePatterns: [
      /\bIII\b/g,
    ],
  },
  {
    key: 'HYDRA',
    shardFile: 'STATE-HYDRA.md',
    shardTitle: 'ASM Hydrasynth Explorer',
    strongPatterns: [
      /\bHydrasynth\b/gi,
      /\bhydra_[a-z]/g,
      /\bHydra\b/g,
      /\bASM\b/g,
    ],
    barePatterns: [],
  },
];

interface SessionBlock {
  sessionNum: number;
  headingLine: string;
  startLine: number;
  endLine: number;
  text: string;
  /** Strong-pattern hit count (high-confidence device anchor). */
  strongScores: Record<DeviceKey, number>;
  /** Total hit count (strong + bare, where bare counts only if strong > 0). */
  scores: Record<DeviceKey, number>;
  assignedTo: DeviceKey | 'main';
  rationale: string;
}

function loadStateMd(): string {
  if (!existsSync(STATE_PATH)) {
    throw new Error(`STATE.md not found at ${STATE_PATH}`);
  }
  return readFileSync(STATE_PATH, 'utf8');
}

function findTailStart(lines: string[]): number {
  // Tail is the first non-quoted line matching ## Archived follow-ups
  // or ## How to use this file. Walk from the bottom so we don't catch
  // an in-session "## How to..." header.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    for (const re of TAIL_START_RES) {
      if (re.test(line)) {
        // Step backward to capture any `---` separator immediately above.
        let probe = i - 1;
        while (probe >= 0 && lines[probe].trim() === '') probe -= 1;
        if (probe >= 0 && lines[probe].trim() === '---') {
          return probe;
        }
        return i;
      }
    }
  }
  return lines.length;
}

function partitionFile(source: string): {
  preamble: string[];
  sessions: SessionBlock[];
  tail: string[];
} {
  const lines = source.split(/\r?\n/);
  // Find first session heading
  let firstSession = -1;
  for (let i = 0; i < lines.length; i++) {
    if (SESSION_HEADING_RE.test(lines[i])) {
      firstSession = i;
      break;
    }
  }
  if (firstSession < 0) {
    throw new Error('No session headings found — STATE.md may already be split.');
  }
  const tailStart = findTailStart(lines);
  if (tailStart <= firstSession) {
    throw new Error(
      `tailStart (${tailStart}) <= firstSession (${firstSession}); ` +
        `boundary detection failed.`,
    );
  }
  const preamble = lines.slice(0, firstSession);
  const tail = lines.slice(tailStart);

  // Walk session region and collect blocks.
  const sessions: SessionBlock[] = [];
  let cursor = firstSession;
  while (cursor < tailStart) {
    const m = lines[cursor].match(SESSION_HEADING_RE);
    if (!m) {
      // skip stray non-heading lines (shouldn't happen if first is a heading)
      cursor += 1;
      continue;
    }
    const sessionNum = Number(m[1]);
    const headingLine = lines[cursor];
    const start = cursor;
    let end = cursor + 1;
    while (end < tailStart && !SESSION_HEADING_RE.test(lines[end])) {
      end += 1;
    }
    const text = lines.slice(start, end).join('\n');
    sessions.push({
      sessionNum,
      headingLine,
      startLine: start,
      endLine: end,
      text,
      strongScores: { AM4: 0, AXEFX2: 0, AXEFX3: 0, HYDRA: 0 },
      scores: { AM4: 0, AXEFX2: 0, AXEFX3: 0, HYDRA: 0 },
      assignedTo: 'main',
      rationale: '',
    });
    cursor = end;
  }
  return { preamble, sessions, tail };
}

function scoreSession(block: SessionBlock): void {
  for (const profile of DEVICE_PROFILES) {
    let strong = 0;
    for (const re of profile.strongPatterns) {
      const matches = block.text.match(re);
      if (matches) strong += matches.length;
    }
    let bare = 0;
    if (strong > 0) {
      for (const re of profile.barePatterns) {
        const matches = block.text.match(re);
        if (matches) bare += matches.length;
      }
    }
    block.strongScores[profile.key] = strong;
    block.scores[profile.key] = strong + bare;
  }
  // Rank by TOTAL score (strong + bare). The leader must have a strong
  // anchor; dominance is checked against the runner-up's STRONG score,
  // not its total. Two reasons:
  //   1. Lets III-heavy sessions win where qualified "Axe-Fx III" is
  //      sparse but bare "III" is dense.
  //   2. Prevents Hydra-focused sessions from losing to bare-II
  //      false amplification (Hydra has no bare patterns, so it would
  //      otherwise always lose the total-score race).
  const ranked = (Object.entries(block.scores) as [DeviceKey, number][])
    .sort((a, b) => b[1] - a[1]);
  const [topKey, topScore] = ranked[0];
  const [runnerKey, runnerScore] = ranked[1];
  if (block.strongScores[topKey] === 0) {
    block.assignedTo = 'main';
    block.rationale = `top ${topKey} has zero strong anchor hits`;
    return;
  }
  if (topScore < MIN_HITS) {
    block.assignedTo = 'main';
    block.rationale = `top ${topKey} total=${topScore} < MIN_HITS=${MIN_HITS}`;
    return;
  }
  const runnerStrong = block.strongScores[runnerKey];
  if (runnerStrong > 0 && topScore < runnerStrong * DOMINANCE) {
    block.assignedTo = 'main';
    block.rationale =
      `top ${topKey}=${topScore} fails dominance vs runner ${runnerKey}-strong=${runnerStrong}`;
    return;
  }
  block.assignedTo = topKey;
  block.rationale =
    `top ${topKey}=${topScore} strong=${block.strongScores[topKey]} (runner ${runnerKey}-strong=${runnerStrong})`;
}

function buildShard(
  profile: DeviceProfile,
  sessions: SessionBlock[],
  preamble: string[],
): string {
  const lines: string[] = [];
  lines.push(`# Project State — ${profile.shardTitle} shard`);
  lines.push('');
  lines.push(`> Per-device session log for **${profile.shardTitle}**.`);
  lines.push(`> Split from \`STATE.md\` on 2026-05-22 (Session 117 cont 2) to`);
  lines.push(`> reduce parallel-agent races on the chronological log.`);
  lines.push(`>`);
  lines.push(`> Read alongside:`);
  lines.push(`> - \`STATE.md\` — orchestrator + cross-device sessions`);
  lines.push(`>   (cookbook progress, MCP-server architecture, MVP scope).`);
  lines.push(`> - \`HARDWARE-TASKS-${profile.key === 'AM4' ? 'AM4' : profile.key === 'AXEFX2' ? 'AXEFX2' : profile.key === 'AXEFX3' ? 'AXEFX3' : 'HYDRASYNTH'}.md\` —`);
  lines.push(`>   the founder-facing hardware backlog for this device.`);
  lines.push('');
  // Newest first (sessions array is currently in source order, which is
  // already newest-first per STATE.md convention).
  lines.push(`## Sessions (newest first)`);
  lines.push('');
  for (const s of sessions) {
    lines.push(s.text);
    lines.push('');
  }
  return lines.join('\n');
}

function buildMain(
  preamble: string[],
  crossSessions: SessionBlock[],
  shardCounts: Record<DeviceKey, number>,
  tail: string[],
): string {
  const lines: string[] = [];
  lines.push(...preamble);
  // Insert a per-device pointer block after preamble so readers see it
  // before the cross-device log.
  lines.push('');
  lines.push('## Per-device session shards');
  lines.push('');
  lines.push('Device-specific session entries split out of this file on');
  lines.push('2026-05-22 (Session 117 cont 2) to reduce parallel-agent races.');
  lines.push('Open the device shard for that device\'s chronological log;');
  lines.push('cross-device + cookbook + MCP-server-architecture sessions stay');
  lines.push('here.');
  lines.push('');
  lines.push('| Device | Sessions in shard | File |');
  lines.push('|---|---|---|');
  for (const profile of DEVICE_PROFILES) {
    lines.push(`| ${profile.shardTitle} | ${shardCounts[profile.key]} | \`${profile.shardFile}\` |`);
  }
  lines.push('');
  lines.push('## Cross-device session log (newest first)');
  lines.push('');
  for (const s of crossSessions) {
    lines.push(s.text);
    lines.push('');
  }
  lines.push(...tail);
  return lines.join('\n');
}

function fmtScores(strong: Record<DeviceKey, number>, total: Record<DeviceKey, number>): string {
  const cell = (k: DeviceKey, label: string) => `${label}=${strong[k]}/${total[k]}`;
  return `${cell('AM4', 'AM4')} ${cell('AXEFX2', 'II')} ${cell('AXEFX3', 'III')} ${cell('HYDRA', 'HY')}`;
}

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const source = loadStateMd();
  const { preamble, sessions, tail } = partitionFile(source);
  for (const s of sessions) scoreSession(s);

  const byTarget: Record<DeviceKey | 'main', SessionBlock[]> = {
    AM4: [],
    AXEFX2: [],
    AXEFX3: [],
    HYDRA: [],
    main: [],
  };
  for (const s of sessions) {
    byTarget[s.assignedTo].push(s);
  }
  const shardCounts: Record<DeviceKey, number> = {
    AM4: byTarget.AM4.length,
    AXEFX2: byTarget.AXEFX2.length,
    AXEFX3: byTarget.AXEFX3.length,
    HYDRA: byTarget.HYDRA.length,
  };
  // Report
  const totalSessionLines = sessions.reduce(
    (acc, s) => acc + (s.endLine - s.startLine),
    0,
  );
  console.log('split-state-per-device');
  console.log('======================');
  console.log(`source:       ${STATE_PATH}`);
  console.log(`total lines:  ${source.split(/\r?\n/).length}`);
  console.log(`preamble:     ${preamble.length} lines`);
  console.log(`tail:         ${tail.length} lines`);
  console.log(`sessions:     ${sessions.length} blocks, ${totalSessionLines} lines`);
  console.log('');
  console.log('per-device assignment:');
  for (const profile of DEVICE_PROFILES) {
    const sList = byTarget[profile.key];
    const total = sList.reduce((acc, s) => acc + (s.endLine - s.startLine), 0);
    console.log(`  ${profile.key.padEnd(8)} ${String(sList.length).padStart(3)} sessions  ${String(total).padStart(5)} lines`);
  }
  console.log(`  ${'main'.padEnd(8)} ${String(byTarget.main.length).padStart(3)} sessions  ${String(byTarget.main.reduce((a, s) => a + (s.endLine - s.startLine), 0)).padStart(5)} lines  (cross-device)`);
  console.log('');
  console.log('session-by-session decisions (newest first):');
  for (const s of sessions) {
    console.log(
      `  S${String(s.sessionNum).padStart(3)} → ${s.assignedTo.padEnd(8)} ` +
        `[${fmtScores(s.strongScores, s.scores)}] ${s.rationale}`,
    );
  }
  console.log('');

  if (dryRun) {
    console.log('--dry-run: no files written.');
    return;
  }

  // Backup STATE.md.
  writeFileSync(BACKUP_PATH, source, 'utf8');
  console.log(`backup written: ${BACKUP_PATH}`);

  // Write shards.
  for (const profile of DEVICE_PROFILES) {
    const shardPath = path.join(STATE_DIR, profile.shardFile);
    const shardBody = buildShard(profile, byTarget[profile.key], preamble);
    writeFileSync(shardPath, shardBody, 'utf8');
    console.log(`shard written: ${shardPath}  (${byTarget[profile.key].length} sessions)`);
  }

  // Write slim main.
  const mainBody = buildMain(preamble, byTarget.main, shardCounts, tail);
  writeFileSync(STATE_PATH, mainBody, 'utf8');
  console.log(`new STATE.md written: ${STATE_PATH}`);
  console.log('');
  console.log('done. The script is a one-shot — no need to run again.');
  console.log('Verify by reading the new STATE.md + a spot-check of each shard.');
  console.log('If the partition is wrong, restore from STATE.md.pre-split-backup.');
}

main();
