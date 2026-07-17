/**
 * Mizuchi-style primitive-mining loop.
 *
 * Spawns a fresh-context Claude sub-agent against a single target dump
 * file (typically a Ghidra decompile output) and produces a structured
 * mining report listing:
 *
 *   - Instances of existing primitives present in the dump
 *     (e.g. "lines 47-58 are a vendor-envelope-descriptor-table
 *     instance at RVA 0x...").
 *   - Candidate net-new primitives the dump exposes that the primitives corpus
 *     does NOT yet have an entry for, with full proposed frontmatter.
 *
 * The script is **founder-gated** by design. Output goes to a
 * mining-log file under `fractal-midi/docs/research/synthesis-log/`
 * for founder review; promotion to actual primitive entries is an
 * explicit follow-up action the founder takes by reading the report
 * and either editing primitive entries by hand or asking an agent to.
 *
 * **NEVER add this script to npm run preflight.** It is opt-in,
 * potentially long-running, and may spawn many sub-agent turns.
 *
 * Differs from synthesis-review:
 *   - synthesis-review scans the whole project for cross-cutting
 *     connections agents working in isolation have missed.
 *   - primitives-mine scans a single named dump file for primitives-
 *     relevant primitives. Narrower input, more structured output,
 *     promotion-candidate-shaped findings.
 *
 * Usage:
 *   npx tsx scripts/primitives-mine.ts <dump-file>
 *   npx tsx scripts/primitives-mine.ts <dump-file> --slug iii-preset-receiver
 *   npx tsx scripts/primitives-mine.ts <dump-file> --dry-run
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = path.resolve(HERE, '..');
const FRACTAL_MIDI_ROOT = process.env.FRACTAL_MIDI_ROOT ?? path.join(MCP_ROOT, 'packages', 'fractal-midi');
const PRIMITIVES_ROOT = path.join(FRACTAL_MIDI_ROOT, 'docs', 'research', 'primitives');
const PRIMITIVES_INDEX = path.join(PRIMITIVES_ROOT, 'INDEX.md');
const MINING_LOG_DIR = path.join(FRACTAL_MIDI_ROOT, 'docs', 'research', 'synthesis-log');
const TRACES_DIR = path.join(MINING_LOG_DIR, 'traces');

const DEFAULT_MODEL = 'claude-opus-4-7';
const DEFAULT_TIMEOUT_SECONDS = 1800;

// Built-in tools the sub-agent is allowed to use. The filtered surface is
// the actual safety boundary under bypassPermissions, not prompt-text
// pleading. Read+Grep+Glob to mine the dump; Write to produce the report.
// No Edit, no Bash, no WebFetch, no Skill, no Task.
const ALLOWED_TOOLS = 'Read,Grep,Glob,Write';

// Bounds the sub-agent's reading scope so it does not chase the project
// CLAUDE.md "read STATE.md / HARDWARE-TASKS first" reflex. Affirmative
// voice only — the agent-regression harness learned the hard way that
// "do NOT read X" negations get treated as emphasis by Sonnet (and
// possibly Opus) and produce the exact opposite of the intended effect
// (see scripts/agent-regression/runner.ts:139-147). Declare scope
// positively instead.
const APPEND_SYSTEM_PROMPT =
  'You are a reverse-engineering primitive-mining agent. Your reading ' +
  'scope is limited to the primitive entries the user prompt names and ' +
  'the target dump file. Conduct all investigation within that scope. ' +
  'Use the Write tool with file_path set to the exact path the user ' +
  'prompt specifies.';

interface Args {
  dumpFile: string;
  slug: string;
  model: string;
  dryRun: boolean;
  timeoutSeconds: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let dumpFile: string | null = null;
  let slug: string | null = null;
  let model = DEFAULT_MODEL;
  let dryRun = false;
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--slug') { slug = argv[++i]; continue; }
    if (a === '--model') { model = argv[++i]; continue; }
    if (a === '--timeout') {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`primitives-mine: --timeout must be a positive number of seconds (got "${raw}")`);
        process.exit(2);
      }
      timeoutSeconds = n;
      continue;
    }
    if (a === '--dry-run') { dryRun = true; continue; }
    if (a === '-h' || a === '--help') {
      console.log(
        'Usage: primitives-mine.ts <dump-file> [--slug NAME] [--model ID] [--timeout SECONDS] [--dry-run]',
      );
      process.exit(0);
    }
    if (a.startsWith('--')) {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
    if (dumpFile === null) { dumpFile = a; continue; }
    console.error(`unexpected positional arg: ${a}`);
    process.exit(2);
  }
  if (dumpFile === null) {
    console.error('primitives-mine: missing required positional <dump-file>. Use --help.');
    process.exit(2);
  }
  if (!existsSync(dumpFile)) {
    console.error(`primitives-mine: dump file not found: ${dumpFile}`);
    process.exit(2);
  }
  const st = statSync(dumpFile);
  if (!st.isFile()) {
    console.error(`primitives-mine: ${dumpFile} is not a file`);
    process.exit(2);
  }
  const absoluteDump = path.resolve(dumpFile);
  // Include HHMM so same-day re-runs don't collide with the output-exists
  // guard and force a manual --slug. UTC keeps it deterministic across DST.
  const now = new Date();
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const stamp = `${now.toISOString().slice(0, 10)}-${hh}${mm}`;
  const defaultSlug = `mine-${path.basename(absoluteDump, path.extname(absoluteDump))}-${stamp}`;
  return {
    dumpFile: absoluteDump,
    slug: slug ?? defaultSlug,
    model,
    dryRun,
    timeoutSeconds,
  };
}

function ensureMiningLogDir(): void {
  if (!existsSync(MINING_LOG_DIR)) {
    mkdirSync(MINING_LOG_DIR, { recursive: true });
  }
}

function assemblePrompt(args: Args, outputPath: string): string {
  if (!existsSync(PRIMITIVES_INDEX)) {
    throw new Error(`primitives INDEX not found: ${PRIMITIVES_INDEX}`);
  }
  const dumpSize = statSync(args.dumpFile).size;
  return `# Primitive-mining task: ${path.basename(args.dumpFile)}

You are a Senior Reverse Engineering Engineer mining a single decompile
dump file for primitive-relevant findings. The primitives corpus is the canonical
encoding-primitive Rosetta at \`${PRIMITIVES_ROOT}\`; read its INDEX.md
first to know what primitives are already registered.

## Inputs

1. **Primitives INDEX**: \`${PRIMITIVES_INDEX}\`
   Read in full. The "Status legend" tells you what \`matched\` /
   \`matched-singleton\` / \`partial-N1\` / \`scratch\` mean.

2. **Sample primitive entries**: read 3-5 entries that match your mining
   focus (e.g. for a Ghidra decompile dump, read
   \`vendor-envelope-descriptor-table.md\`, \`xor-fold-hash.md\`,
   \`param-descriptor-16byte.md\`).

3. **Target dump file**: \`${args.dumpFile}\` (${dumpSize.toLocaleString()} bytes).
   This is what you mine. Use grep / read / glob freely.

## Output structure

Write your full mining report as a markdown file to:

  \`${outputPath}\`

The report has THREE sections:

### 1. Instances of existing primitives

For each match you find, list:
- The primitive (cite by slug, e.g. \`[[vendor-envelope-descriptor-table]]\`)
- The byte range / line range / function name in the dump where it
  appears
- A snippet of the matched content (5-10 lines max)
- The new "consumed_in:" path that should be added to the primitives
  entry (the dump file's path)

### 2. Candidate net-new primitives

For each candidate new primitive the dump exposes that the primitives corpus
does NOT yet have, propose:
- A short slug (e.g. \`iii-routing-fn33-descriptor\`)
- Full proposed frontmatter (class, status, verified_on,
  firmware_sensitive, relates_to, consumed_in) matching the existing
  18-entry shape
- A one-line summary of what the primitive verifies
- The exact byte range / function name in the dump that supports the
  claim
- N=1 vs N>=2: state whether the candidate has multiple fixtures
  (matched) or just one (matched-singleton / partial-N1) per the
  primitives fixture-count rule

### 3. Negative findings

If the dump file demonstrates that some hypothesis is WRONG (e.g. a
transfer candidate that fails), propose a \`_negative/<slug>.md\`
entry per the primitives discipline. Include the search terms a future
agent would use to avoid re-attempting.

## Constraints

- Read-only. Do not edit primitive entries or other files. Your output
  is the markdown report.
- Navigation: the Read tool caps at ~2000 lines per call. Use Grep
  to find regions of interest first, then Read with offset/limit to
  navigate. Do not assume one Read covers the file.
- Cite specific byte ranges, line numbers, RVA addresses, function
  names. Generic claims do not survive the founder's review.
- Never use em dashes. Use commas, periods, colons, or parens.
- Length cap: 5000 words. If you find more than 5000 words of
  material, prioritize the highest-leverage findings (largest
  primitives, most reusable, highest cross-device transfer potential).
- For candidate new primitives, propose status accurately:
  - \`matched\` requires verified_on to list >= 2 axis points.
  - \`matched-singleton\` requires verified_on >= 1 with explanation.
  - \`partial-N1\` for one-fixture findings with a path-to-matched in
    the body.
- Do not propose anything as \`matched\` with only 1 fixture.

## Promotion is founder-gated

You write the report. The founder reads it. Promotion of candidates
to actual primitive entries is an explicit follow-up action by the
founder. **Do not write to the primitives directory directly.** Only
write to the output path above.

When done, return a one-sentence confirmation as your final message.
The full report should be on disk at the output path; do not paste
it into chat.
`;
}

interface SpawnResult {
  exitCode: number;
  rawLines: string[];
  finalText: string;
  writePathsSeen: string[];
  toolCallCount: number;
  timedOut: boolean;
}

function spawnClaude(prompt: string, model: string, timeoutMs: number): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    // Arg shape mirrors scripts/agent-regression/runner.ts so the spawn
    // semantics stay consistent across our claude -p harnesses. Differences:
    //   no --strict-mcp-config / --mcp-config: mining a static file, no
    //     MCP server involved.
    //   --tools <list>: positive set of built-ins (Read/Grep/Glob/Write)
    //     instead of runner's `""` (MCP-only). With bypassPermissions, this
    //     filtered surface is the actual safety boundary, not prompt text.
    //   --append-system-prompt: suppresses the project CLAUDE.md
    //     "read STATE.md / HARDWARE-TASKS first" reflex the sub-agent
    //     would otherwise inherit.
    //   --output-format stream-json + --verbose: per-tool-call progress
    //     visibility on a multi-minute Opus run and lets us detect
    //     wrong-path Write failures explicitly.
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--model', model,
      '--permission-mode', 'bypassPermissions',
      '--append-system-prompt', APPEND_SYSTEM_PROMPT,
      '--tools', ALLOWED_TOOLS,
    ];
    const child = spawn('claude', args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    const rawLines: string[] = [];
    let finalText = '';
    const writePathsSeen: string[] = [];
    let toolCallCount = 0;
    let buffer = '';
    let timedOut = false;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.length === 0) continue;
        rawLines.push(line);
        let event: unknown;
        try { event = JSON.parse(line); } catch { continue; }
        if (event === null || typeof event !== 'object') continue;
        const e = event as { type?: string; message?: unknown };
        if (e.type !== 'assistant') continue;
        const msg = e.message as { content?: unknown } | null;
        if (msg === null || typeof msg !== 'object' || !Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
          if (block === null || typeof block !== 'object') continue;
          const b = block as { type?: string; name?: string; input?: unknown; text?: string };
          if (b.type === 'tool_use' && typeof b.name === 'string') {
            toolCallCount++;
            const input = (b.input ?? {}) as Record<string, unknown>;
            const summary =
              typeof input.file_path === 'string' ? ` ${input.file_path}` :
              typeof input.pattern === 'string'   ? ` /${input.pattern}/` :
              typeof input.path === 'string'      ? ` ${input.path}` : '';
            console.log(`  [${toolCallCount}] ${b.name}${summary}`);
            if (b.name === 'Write' && typeof input.file_path === 'string') {
              writePathsSeen.push(input.file_path);
            }
          } else if (b.type === 'text' && typeof b.text === 'string') {
            finalText += b.text;
          }
        }
      }
    });

    const timeout = setTimeout(() => {
      if (!child.killed) {
        timedOut = true;
        console.error(`primitives-mine: timeout after ${timeoutMs / 1000}s; killing sub-agent.`);
        child.kill('SIGTERM');
      }
    }, timeoutMs);

    child.on('error', (err) => { clearTimeout(timeout); reject(err); });
    child.on('exit', (exitCode) => {
      clearTimeout(timeout);
      resolve({
        exitCode: exitCode ?? 1,
        rawLines,
        finalText,
        writePathsSeen,
        toolCallCount,
        timedOut,
      });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function validateLayout(): void {
  if (!existsSync(FRACTAL_MIDI_ROOT)) {
    console.error(
      `primitives-mine: expected fractal-midi checkout at ${FRACTAL_MIDI_ROOT}. ` +
        `Set FRACTAL_MIDI_ROOT to override.`,
    );
    process.exit(2);
  }
  if (!existsSync(PRIMITIVES_INDEX)) {
    console.error(`primitives-mine: primitives INDEX not found at ${PRIMITIVES_INDEX}`);
    process.exit(2);
  }
}

function dumpTrace(rawLines: string[], slug: string): string | null {
  if (rawLines.length === 0) return null;
  try {
    mkdirSync(TRACES_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const tracePath = path.join(TRACES_DIR, `${slug}-${stamp}.ndjson`);
    writeFileSync(tracePath, rawLines.join('\n') + '\n', 'utf8');
    return tracePath;
  } catch (err) {
    console.error(`primitives-mine: trace dump failed: ${(err as Error).message}`);
    return null;
  }
}

async function main(): Promise<void> {
  validateLayout();
  const args = parseArgs();
  const outputPath = path.join(MINING_LOG_DIR, `${args.slug}.md`);
  ensureMiningLogDir();
  const prompt = assemblePrompt(args, outputPath);

  if (args.dryRun) {
    console.log('--- dry run: assembled prompt ---');
    console.log(prompt);
    console.log('--- end prompt ---');
    console.log(`would spawn: claude -p --model ${args.model} --tools ${ALLOWED_TOOLS} ...`);
    console.log(`target dump:           ${args.dumpFile}`);
    console.log(`would write report to: ${outputPath}`);
    console.log(`timeout:               ${args.timeoutSeconds}s`);
    return;
  }

  if (existsSync(outputPath)) {
    console.error(
      `primitives-mine: output file already exists at ${outputPath}. ` +
        `Choose a different --slug to avoid clobbering.`,
    );
    process.exit(2);
  }

  const promptStagePath = path.join(MINING_LOG_DIR, `.${args.slug}.prompt.md`);
  writeFileSync(promptStagePath, prompt, 'utf8');
  console.log(`primitives-mine: spawning Claude (${args.model}); prompt staged at ${promptStagePath}`);
  console.log(`target dump:        ${args.dumpFile}`);
  console.log(`expected report at: ${outputPath}`);
  console.log(`timeout:            ${args.timeoutSeconds}s`);
  console.log('--- agent progress ---');

  const startedAt = Date.now();
  const result = await spawnClaude(prompt, args.model, args.timeoutSeconds * 1000);
  const wallSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`--- agent done in ${wallSeconds}s (${result.toolCallCount} tool calls) ---`);

  const reportWritten = existsSync(outputPath);
  const wroteExpectedPath = result.writePathsSeen.some(
    (p) => path.resolve(p) === outputPath,
  );
  const failed = result.exitCode !== 0 || result.timedOut || !reportWritten;

  if (failed) {
    if (result.timedOut) {
      console.error(`primitives-mine: sub-agent hit the ${args.timeoutSeconds}s timeout`);
    } else if (result.exitCode !== 0) {
      console.error(`primitives-mine: claude exited with code ${result.exitCode}`);
    }
    if (!reportWritten) {
      console.error(`primitives-mine: expected report at ${outputPath} was not written.`);
      if (result.writePathsSeen.length > 0) {
        console.error(`primitives-mine: agent wrote to these paths instead:`);
        for (const p of result.writePathsSeen) console.error(`  - ${p}`);
      } else {
        console.error(`primitives-mine: agent issued no Write tool calls at all.`);
      }
    }
    const tracePath = dumpTrace(result.rawLines, args.slug);
    if (tracePath) console.error(`primitives-mine: trace at ${tracePath}`);
    console.error(`primitives-mine: prompt stage retained at ${promptStagePath} for diagnostics.`);
    process.exit(result.exitCode || 1);
  }

  if (!wroteExpectedPath) {
    console.error(
      `primitives-mine: report exists at ${outputPath} but the agent's Write ` +
        `tool calls did not target that exact path. Inspect for partial writes.`,
    );
  }

  // Success: clean up the stage file. Retained on failure for diagnostics.
  try { unlinkSync(promptStagePath); } catch { /* best-effort */ }

  console.log(`primitives-mine: ok. report at ${outputPath}`);
  console.log(`next step: founder review. Promotion to primitive entries is explicit.`);
}

main().catch((e) => {
  console.error(`primitives-mine failed: ${(e as Error).message}`);
  process.exit(1);
});
