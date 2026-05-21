/**
 * Mizuchi-style cookbook mining loop.
 *
 * Spawns a fresh-context Claude sub-agent against a single target dump
 * file (typically a Ghidra decompile output) and produces a structured
 * mining report listing:
 *
 *   - Instances of existing cookbook primitives present in the dump
 *     (e.g. "lines 47-58 are a vendor-envelope-descriptor-table
 *     instance at RVA 0x...").
 *   - Candidate net-new primitives the dump exposes that the cookbook
 *     does NOT yet have an entry for, with full proposed frontmatter.
 *
 * The script is **founder-gated** by design. Output goes to a
 * mining-log file under `fractal-midi/docs/research/synthesis-log/`
 * for founder review; promotion to actual cookbook entries is an
 * explicit follow-up action the founder takes by reading the report
 * and either editing cookbook entries by hand or asking an agent to.
 *
 * **NEVER add this script to npm run preflight.** It is opt-in,
 * potentially long-running, and may spawn many sub-agent turns.
 *
 * Differs from synthesis-review:
 *   - synthesis-review scans the whole project for cross-cutting
 *     connections agents working in isolation have missed.
 *   - cookbook-mine scans a single named dump file for cookbook-
 *     relevant primitives. Narrower input, more structured output,
 *     promotion-candidate-shaped findings.
 *
 * Usage:
 *   npx tsx scripts/cookbook-mine.ts <dump-file>
 *   npx tsx scripts/cookbook-mine.ts <dump-file> --slug iii-preset-receiver
 *   npx tsx scripts/cookbook-mine.ts <dump-file> --dry-run
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = path.resolve(HERE, '..');
const REPO_PARENT = path.resolve(MCP_ROOT, '..');
const FRACTAL_MIDI_ROOT = path.join(REPO_PARENT, 'fractal-midi');
const COOKBOOK_ROOT = path.join(FRACTAL_MIDI_ROOT, 'docs', 'research', 'cookbook');
const COOKBOOK_INDEX = path.join(COOKBOOK_ROOT, 'INDEX.md');
const MINING_LOG_DIR = path.join(FRACTAL_MIDI_ROOT, 'docs', 'research', 'synthesis-log');

const DEFAULT_MODEL = 'claude-opus-4-7';

interface Args {
  dumpFile: string;
  slug: string;
  model: string;
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let dumpFile: string | null = null;
  let slug: string | null = null;
  let model = DEFAULT_MODEL;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--slug') { slug = argv[++i]; continue; }
    if (a === '--model') { model = argv[++i]; continue; }
    if (a === '--dry-run') { dryRun = true; continue; }
    if (a === '-h' || a === '--help') {
      console.log(
        'Usage: cookbook-mine.ts <dump-file> [--slug NAME] [--model ID] [--dry-run]',
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
    console.error('cookbook-mine: missing required positional <dump-file>. Use --help.');
    process.exit(2);
  }
  if (!existsSync(dumpFile)) {
    console.error(`cookbook-mine: dump file not found: ${dumpFile}`);
    process.exit(2);
  }
  const st = statSync(dumpFile);
  if (!st.isFile()) {
    console.error(`cookbook-mine: ${dumpFile} is not a file`);
    process.exit(2);
  }
  const absoluteDump = path.resolve(dumpFile);
  const today = new Date().toISOString().slice(0, 10);
  const defaultSlug = `mine-${path.basename(absoluteDump, path.extname(absoluteDump))}-${today}`;
  return {
    dumpFile: absoluteDump,
    slug: slug ?? defaultSlug,
    model,
    dryRun,
  };
}

function ensureMiningLogDir(): void {
  if (!existsSync(MINING_LOG_DIR)) {
    mkdirSync(MINING_LOG_DIR, { recursive: true });
  }
}

function assemblePrompt(args: Args, outputPath: string): string {
  if (!existsSync(COOKBOOK_INDEX)) {
    throw new Error(`cookbook INDEX not found: ${COOKBOOK_INDEX}`);
  }
  const dumpSize = statSync(args.dumpFile).size;
  return `# Cookbook mining task: ${path.basename(args.dumpFile)}

You are a Senior Reverse Engineering Engineer mining a single decompile
dump file for cookbook-relevant findings. The cookbook is the canonical
encoding-primitive Rosetta at \`${COOKBOOK_ROOT}\`; read its INDEX.md
first to know what primitives are already registered.

## Inputs

1. **Cookbook INDEX**: \`${COOKBOOK_INDEX}\`
   Read in full. The "Status legend" tells you what \`matched\` /
   \`matched-singleton\` / \`partial-N1\` / \`scratch\` mean.

2. **Sample cookbook entries**: read 3-5 entries that match your mining
   focus (e.g. for a Ghidra decompile dump, read
   \`vendor-envelope-descriptor-table.md\`, \`xor-fold-hash.md\`,
   \`param-descriptor-16byte.md\`).

3. **Target dump file**: \`${args.dumpFile}\` (${dumpSize.toLocaleString()} bytes).
   This is what you mine. Use grep / read / glob freely.

## Output structure

Write your full mining report as a markdown file to:

  \`${outputPath}\`

The report has THREE sections:

### 1. Instances of existing cookbook primitives

For each match you find, list:
- The cookbook primitive (cite by slug, e.g. \`[[vendor-envelope-descriptor-table]]\`)
- The byte range / line range / function name in the dump where it
  appears
- A snippet of the matched content (5-10 lines max)
- The new "consumed_in:" path that should be added to the cookbook
  entry (the dump file's path)

### 2. Candidate net-new primitives

For each candidate new primitive the dump exposes that the cookbook
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
  cookbook fixture-count rule

### 3. Negative findings

If the dump file demonstrates that some hypothesis is WRONG (e.g. a
transfer candidate that fails), propose a \`_negative/<slug>.md\`
entry per the cookbook discipline. Include the search terms a future
agent would use to avoid re-attempting.

## Constraints

- Read-only. Do not edit cookbook entries or other files. Your output
  is the markdown report.
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
to actual cookbook entries is an explicit follow-up action by the
founder. **Do not write to the cookbook directory directly.** Only
write to the output path above.

When done, return a one-sentence confirmation as your final message.
The full report should be on disk at the output path; do not paste
it into chat.
`;
}

function spawnClaude(prompt: string, model: string): Promise<{ exitCode: number }> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--no-session-persistence',
      '--model', model,
      '--permission-mode', 'bypassPermissions',
    ];
    const child = spawn('claude', args, {
      shell: false,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', (exitCode) => resolve({ exitCode: exitCode ?? 1 }));
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function main(): Promise<void> {
  const args = parseArgs();
  const outputPath = path.join(MINING_LOG_DIR, `${args.slug}.md`);
  ensureMiningLogDir();
  const prompt = assemblePrompt(args, outputPath);

  if (args.dryRun) {
    console.log('--- dry run: assembled prompt ---');
    console.log(prompt);
    console.log('--- end prompt ---');
    console.log(`would spawn: claude -p --model ${args.model} ...`);
    console.log(`target dump: ${args.dumpFile}`);
    console.log(`would write report to: ${outputPath}`);
    return;
  }

  if (existsSync(outputPath)) {
    console.error(
      `cookbook-mine: output file already exists at ${outputPath}. ` +
        `Choose a different --slug to avoid clobbering.`,
    );
    process.exit(2);
  }

  const promptStagePath = path.join(MINING_LOG_DIR, `.${args.slug}.prompt.md`);
  writeFileSync(promptStagePath, prompt, 'utf8');
  console.log(`cookbook-mine: spawning Claude (${args.model}); prompt staged at ${promptStagePath}`);
  console.log(`target dump:    ${args.dumpFile}`);
  console.log(`expected report at: ${outputPath}`);

  const { exitCode } = await spawnClaude(prompt, args.model);
  if (exitCode !== 0) {
    console.error(`cookbook-mine: claude exited with code ${exitCode}`);
    process.exit(exitCode);
  }
  if (!existsSync(outputPath)) {
    console.error(
      `cookbook-mine: claude exited 0 but the expected report at ` +
        `${outputPath} was not written. Inspect the staged prompt at ` +
        `${promptStagePath} and the claude stdout above for clues.`,
    );
    process.exit(1);
  }
  console.log(`cookbook-mine: ok. report at ${outputPath}`);
  console.log(`next step: founder review. Promotion to cookbook entries is explicit.`);
}

main().catch((e) => {
  console.error(`cookbook-mine failed: ${(e as Error).message}`);
  process.exit(1);
});
