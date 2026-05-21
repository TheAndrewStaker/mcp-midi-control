/**
 * Synthesis review runner.
 *
 * Spawns a fresh-context Claude sub-agent with the canonical synthesis
 * prompt template at `docs/process/synthesis-prompt.md`. The sub-agent
 * reads accumulated findings holistically and produces a synthesis
 * report identifying connections agents working in isolation have
 * missed. The report writes to
 * `fractal-midi/docs/research/synthesis-log/<YYYY-MM-DD>-<slug>.md`.
 *
 * Per the cookbook discipline (CLAUDE.md "Synthesis cadence"), call
 * this script when any of these triggers fires:
 *
 *   - Cookbook primitive promoted (partial-N1 -> matched, scratch -> matched).
 *   - New `cookbook/_negative/` entry landed.
 *   - BK-NNN workstream flipped to done.
 *   - Major Ghidra dump output committed.
 *   - >= 10 sessions since last synthesis.
 *
 * Usage:
 *   npx tsx scripts/synthesis-review.ts                       (manual trigger; default slug)
 *   npx tsx scripts/synthesis-review.ts --slug cookbook-audit (custom slug)
 *   npx tsx scripts/synthesis-review.ts --trigger "BK-070 closure"
 *   npx tsx scripts/synthesis-review.ts --dry-run             (print prompt + target path; do not spawn)
 *
 * The spawn invocation mirrors the agent-regression runner: `claude -p`
 * with no MCP filter (synthesis needs the default Claude Code tool
 * surface for Read/Grep/Glob/WebFetch over the project). Permission
 * mode is bypassPermissions so the agent can read freely without
 * blocking. The sub-agent runs read-only (it produces a markdown
 * report, not file edits); permission-bypass + read-only-by-discipline
 * is the same shape agent-regression uses.
 *
 * Model: Opus 4.7 (synthesis needs deep cross-document reasoning).
 *
 * Notes vs cookbook-mine (Mizuchi-style): synthesis-review is a single
 * pass per invocation, not a loop. cookbook-mine is the iterative
 * mining variant; both share the spawn machinery + the prompt-template
 * registry but have different cadence.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = path.resolve(HERE, '..');
const REPO_PARENT = path.resolve(MCP_ROOT, '..');
const FRACTAL_MIDI_ROOT = path.join(REPO_PARENT, 'fractal-midi');

const PROMPT_TEMPLATE_PATH = path.join(MCP_ROOT, 'docs', 'process', 'synthesis-prompt.md');
const SYNTHESIS_LOG_DIR = path.join(FRACTAL_MIDI_ROOT, 'docs', 'research', 'synthesis-log');

const DEFAULT_MODEL = 'claude-opus-4-7';

interface Args {
  slug: string;
  trigger: string | null;
  model: string;
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let slug: string | null = null;
  let trigger: string | null = null;
  let model = DEFAULT_MODEL;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--slug') { slug = argv[++i]; continue; }
    if (a === '--trigger') { trigger = argv[++i]; continue; }
    if (a === '--model') { model = argv[++i]; continue; }
    if (a === '--dry-run') { dryRun = true; continue; }
    if (a === '-h' || a === '--help') {
      console.log(
        'Usage: synthesis-review.ts [--slug NAME] [--trigger REASON] [--model ID] [--dry-run]',
      );
      process.exit(0);
    }
    console.error(`unknown arg: ${a}`);
    process.exit(2);
  }
  const today = new Date().toISOString().slice(0, 10);
  const finalSlug = slug ?? `synthesis-${today}`;
  return { slug: finalSlug, trigger, model, dryRun };
}

function ensureSynthesisLogDir(): void {
  if (!existsSync(SYNTHESIS_LOG_DIR)) {
    mkdirSync(SYNTHESIS_LOG_DIR, { recursive: true });
  }
}

function assemblePrompt(args: Args, today: string, outputPath: string): string {
  if (!existsSync(PROMPT_TEMPLATE_PATH)) {
    throw new Error(`synthesis prompt template not found: ${PROMPT_TEMPLATE_PATH}`);
  }
  const template = readFileSync(PROMPT_TEMPLATE_PATH, 'utf8');
  // Extract the "Prompt" body from the template (everything between the
  // first `## Prompt` heading and the next `## Refinement history` or end
  // of file). The header sections of the template are explanation for a
  // human; the body is what gets handed to the agent.
  const promptStartIdx = template.indexOf('## Prompt');
  const refinementIdx = template.indexOf('## Refinement history');
  const promptBody = promptStartIdx >= 0
    ? template.slice(promptStartIdx, refinementIdx > 0 ? refinementIdx : undefined)
    : template;
  const triggerLine = args.trigger
    ? `## Trigger\n\nThis synthesis was invoked with trigger: ${args.trigger}.\n\n`
    : '';
  return [
    `# Synthesis review (${today}, slug: ${args.slug})`,
    '',
    triggerLine,
    promptBody.trim(),
    '',
    '---',
    '',
    '## Output destination',
    '',
    `Write your full deliverable as a markdown report to the file at:`,
    '',
    `  \`${outputPath}\``,
    '',
    'Use the Write tool to create that file with your complete report as',
    'the content. After writing, return a one-sentence confirmation as',
    'your final message; do not paste the full report into chat (it is',
    'already on disk).',
  ].join('\n');
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
  const today = new Date().toISOString().slice(0, 10);
  const outputPath = path.join(SYNTHESIS_LOG_DIR, `${args.slug}.md`);
  ensureSynthesisLogDir();
  const prompt = assemblePrompt(args, today, outputPath);

  if (args.dryRun) {
    console.log('--- dry run: assembled prompt ---');
    console.log(prompt);
    console.log('--- end prompt ---');
    console.log(`would spawn: claude -p --model ${args.model} ...`);
    console.log(`would write report to: ${outputPath}`);
    return;
  }

  if (existsSync(outputPath)) {
    console.error(
      `synthesis-log file already exists at ${outputPath}. ` +
        `Choose a different --slug to avoid clobbering.`,
    );
    process.exit(2);
  }

  // Stage the prompt to a temp file so the founder can inspect what was
  // actually sent to the sub-agent if anything goes wrong.
  const promptStagePath = path.join(SYNTHESIS_LOG_DIR, `.${args.slug}.prompt.md`);
  writeFileSync(promptStagePath, prompt, 'utf8');
  console.log(`synthesis-review: spawning Claude (${args.model}); prompt staged at ${promptStagePath}`);
  console.log(`expected report at: ${outputPath}`);

  const { exitCode } = await spawnClaude(prompt, args.model);
  if (exitCode !== 0) {
    console.error(`synthesis-review: claude exited with code ${exitCode}`);
    process.exit(exitCode);
  }
  if (!existsSync(outputPath)) {
    console.error(
      `synthesis-review: claude exited 0 but the expected report at ` +
        `${outputPath} was not written. Inspect the staged prompt at ` +
        `${promptStagePath} and the claude stdout above for clues.`,
    );
    process.exit(1);
  }
  console.log(`synthesis-review: ok. report at ${outputPath}`);
}

main().catch((e) => {
  console.error(`synthesis-review failed: ${(e as Error).message}`);
  process.exit(1);
});
