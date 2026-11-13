/**
 * Gate: stdout is the MCP protocol channel; nothing in the server's package
 * sources may write to it.
 *
 * The server redirects `process.stdout.write` to stderr after handing the
 * transport its own fd-1 stream (server-all/src/server/index.ts), so a stray
 * `console.log` cannot corrupt a JSON-RPC frame at runtime; this gate is the
 * static half, so the stray write is caught in review rather than silently
 * rerouted forever. Scans every packages/<pkg>/src .ts file for stdout WRITE
 * CALLS (`console.log(` / `process.stdout.write(`).
 *
 * Allowlisted: `packages/server-all/src/cli/` (user-facing CLIs like
 * verify-midi run in their own terminal; stdout is theirs by design).
 * `scripts/` is out of scope entirely: scripts are never in the server's
 * import graph (that separation is what chunk 2 of the Rig Console workplan
 * enforced by extracting the renderer).
 *
 * Run: npx tsx scripts/verify-stdout-discipline.ts   (registered in preflight)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWLIST_PREFIXES = [
  join('packages', 'server-all', 'src', 'cli') + '\\',
  join('packages', 'server-all', 'src', 'cli') + '/',
];

const OFFENDERS = [/\bconsole\.log\s*\(/, /\bprocess\.stdout\.write\s*\(/];

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
}

let failures = 0;
let scanned = 0;
const packages = readdirSync('packages').filter((p) => {
  try { return statSync(join('packages', p, 'src')).isDirectory(); } catch { return false; }
});

for (const pkg of packages) {
  const files: string[] = [];
  walk(join('packages', pkg, 'src'), files);
  for (const file of files) {
    if (ALLOWLIST_PREFIXES.some((p) => file.startsWith(p))) continue;
    scanned++;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const code = line.split('//')[0];
      if (OFFENDERS.some((re) => re.test(code))) {
        console.error(`  FAIL ${file}:${i + 1} writes to stdout: ${line.trim()}`);
        failures++;
      }
    });
  }
}

if (scanned === 0) {
  console.error('verify-stdout-discipline scanned nothing; the gate is misconfigured.');
  process.exit(1);
}
if (failures === 0) {
  console.log(`verify-stdout-discipline passed (${scanned} files clean).`);
  process.exit(0);
}
console.error(`${failures} stdout write(s) found in server package sources.`);
process.exit(1);
