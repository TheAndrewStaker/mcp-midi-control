/**
 * probe-host-delivery-cliff.ts — MEASURE the host's tool-result delivery cliff
 * instead of inferring it from a bracket.
 *
 * WHY THIS EXISTS. `verify-describe-device-budget.ts` hard-fails a device whose
 * `describe_device` response reaches HOST_DELIVERY_CLIFF_CHARS, and
 * `dispatcher/discovery.ts` rations guidance to stay under
 * DESCRIBE_DEVICE_BUDGET_CHARS. Both numbers were, until this script ran,
 * derived from an OBSERVATIONAL bracket over the trace corpus — the largest
 * payload seen delivered whole and the smallest seen replaced by a stub — with
 * the exact boundary picked out of that gap because it was a round number. A
 * round number inside a 2,634-char gap is a guess, and the whole budget
 * architecture rested on it.
 *
 * WHAT IT DOES. Runs the host as an EXPERIMENT rather than reading its exhaust:
 *
 *   --serve   Behave as a minimal MCP server exposing one tool, `probe_payload`,
 *             that returns a result of EXACTLY `PROBE_PAYLOAD_CHARS` compact
 *             characters, shaped exactly like `asText` in
 *             packages/core/src/protocol-generic/tools/shared.ts (a text block
 *             carrying the compact JSON, plus the same object as
 *             `structuredContent`). Same wire shape as every unified tool, so
 *             whatever the host measures, it measures it the same way here.
 *
 *   (default) Drive that server through `claude -p` the way
 *             `scripts/agent-regression/runner.ts` does — `--strict-mcp-config`
 *             against a generated config, `--tools ""` so the agent is MCP-only
 *             with no filesystem escape — and read the verdict off the
 *             stream-json trace.
 *
 * HOW A VERDICT IS READ. Not from the model's behaviour, which would be a
 * proxy. The `user` envelope in the stream-json trace carries the tool_result
 * content AS THE HOST DELIVERED IT, so the classification is direct:
 *
 *   delivered   result length == N and it ends with the canary token
 *   stub        result contains `<persisted-output>` / "Output too large"
 *   token-error result contains "exceeds maximum allowed tokens"
 *
 * THE CANARY IS THE POINT. It is the LAST field of the payload, so "delivered
 * whole" is proven by its presence rather than inferred from a length that a
 * truncation could coincidentally match. The model is also asked to echo it,
 * which is a second, independent signal: an MCP-only agent handed a stub cannot
 * produce it, because the sidecar file needs a filesystem tool it does not have.
 *
 * CHARACTERS OR TOKENS. `--filler lo|hi` decides the payload's entropy: `lo`
 * repeats one character (compresses to very few tokens), `hi` is random
 * alphanumeric (near worst-case, ~2-3 chars/token). Probing the same N both
 * ways separates the two hypotheses. If both cliff at the same N the limit is
 * CHARACTER-based; if `hi` cliffs earlier the limit is TOKEN-based and this
 * gate is measuring the wrong quantity. That question is live because the trace
 * corpus contains a SECOND, explicitly token-based limit ("result (N
 * characters) exceeds maximum allowed tokens", 13 occurrences, all from
 * `list_params`).
 *
 * USAGE
 *   npx tsx scripts/probe-host-delivery-cliff.ts --at 51200,51199
 *   npx tsx scripts/probe-host-delivery-cliff.ts --at 51200 --filler hi
 *   npx tsx scripts/probe-host-delivery-cliff.ts --search 48599:51233
 *
 * Each probe spawns a real `claude -p` run and bills the operator's
 * subscription, same as the agent-regression harness. Results append to
 * `probe-host-delivery-cliff.jsonl` next to this script's output dir so a
 * bisection can be resumed across invocations.
 */
import { spawn, execSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Payload construction (shared by both modes) ─────────────────────────────

/**
 * The token the model is asked to echo, and the last field of the payload.
 * Fixed rather than random so a resumed bisection produces comparable rows and
 * so the driver can grep a trace for it without threading state.
 */
const CANARY = 'CANARY-8f3a2b7c-TAIL-OK';

const LO_ALPHABET = 'a';
const HI_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Build an object whose COMPACT serialization is exactly `chars` long.
 *
 * The filler alphabet is restricted to characters JSON never escapes, so one
 * filler character is one serialized character and the arithmetic is exact
 * rather than approximate. `hi` is seeded off `chars` so a given (N, filler)
 * pair reproduces byte-for-byte between runs.
 */
export function buildProbePayload(chars: number, filler: 'lo' | 'hi'): Record<string, unknown> {
  const skeleton = { probe: 'host-delivery-cliff', target_chars: chars, filler: '', canary: CANARY };
  const overhead = JSON.stringify(skeleton).length;
  const padLen = chars - overhead;
  if (padLen < 0) {
    throw new Error(`target of ${chars} chars is below the ${overhead}-char envelope minimum`);
  }
  let pad: string;
  if (filler === 'lo') {
    pad = LO_ALPHABET.repeat(padLen);
  } else {
    // Deterministic LCG: reproducible without pulling in a PRNG dependency.
    let seed = (chars * 2654435761) >>> 0;
    const out = new Array<string>(padLen);
    for (let i = 0; i < padLen; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      out[i] = HI_ALPHABET[seed % HI_ALPHABET.length];
    }
    pad = out.join('');
  }
  return { ...skeleton, filler: pad };
}

// ── Server mode ─────────────────────────────────────────────────────────────

async function serve(): Promise<void> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');

  const chars = Number(process.env.PROBE_PAYLOAD_CHARS ?? '1000');
  const filler = (process.env.PROBE_FILLER === 'hi' ? 'hi' : 'lo') as 'lo' | 'hi';
  const payload = buildProbePayload(chars, filler);
  const text = JSON.stringify(payload);

  const server = new McpServer({ name: 'cliff-probe', version: '0.1.0' });
  server.registerTool('probe_payload', {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description:
      'Return a fixed diagnostic payload. Takes no arguments. The result carries a `canary` field as its LAST key; '
      + 'report that value verbatim.',
    inputSchema: {},
  }, async () => ({
    // Mirrors `asText`: compact text block + the same object as
    // structuredContent, with no outputSchema (so the SDK does not validate
    // and the shape stays byte-identical to every unified tool result).
    content: [{ type: 'text' as const, text }],
    structuredContent: payload,
  }));

  await server.connect(new StdioServerTransport());
}

// ── Driver mode ─────────────────────────────────────────────────────────────

type Verdict = 'delivered' | 'stub' | 'token-error' | 'no-call' | 'unknown';

interface ProbeResult {
  chars: number;
  filler: 'lo' | 'hi';
  verdict: Verdict;
  /** Length of the tool_result content the host actually handed the model. */
  observed_len: number;
  /** True when the canary (last field of the payload) survived. */
  canary_in_result: boolean;
  /** True when the model echoed the canary in its final text. */
  canary_echoed: boolean;
  /** The host's own size string from a stub ("50.9KB"), when present. */
  host_reported_size?: string;
  /**
   * First 400 chars of whatever the host actually delivered. On a refusal this
   * IS the whole diagnostic — the host quotes its own limit back, and that
   * wording is the difference between a character budget and a token one.
   */
  result_head: string;
  wall_seconds: number;
  at: string;
}

const SCRATCH = path.resolve(process.cwd(), 'samples', 'cliff-probe');
const RESULTS = path.join(SCRATCH, 'probe-host-delivery-cliff.jsonl');
const SELF = fileURLToPath(import.meta.url);
const TSX_CLI = path.resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');

const PROMPT =
  'Call the probe_payload tool (it takes no arguments). Its result is a JSON object whose LAST key is `canary`. '
  + 'Reply with the value of that `canary` field and nothing else. '
  + 'If the result you received does not contain a `canary` field, reply with exactly: MISSING';

function forceKillTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch { /* already exited */ }
}

async function probe(chars: number, filler: 'lo' | 'hi', verbose: boolean): Promise<ProbeResult> {
  const startedAt = Date.now();
  mkdirSync(SCRATCH, { recursive: true });

  const configPath = path.join(SCRATCH, `mcp-config-${chars}-${filler}.json`);
  writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      'cliff-probe': {
        type: 'stdio',
        command: process.execPath,
        args: [TSX_CLI, SELF, '--serve'],
        alwaysLoad: true,
        // Set on the server entry explicitly AS WELL AS inherited through
        // claude's own env, so the payload size cannot depend on whether the
        // host forwards its environment to MCP children.
        env: { PROBE_PAYLOAD_CHARS: String(chars), PROBE_FILLER: filler },
      },
    },
  }, null, 2));

  // Same flag set as scripts/agent-regression/runner.ts. `--tools ""` is
  // load-bearing: it removes every Claude Code built-in, so the agent has no
  // Read tool with which to open a sidecar file and the stub is genuinely
  // terminal, exactly as it is for an MCP-only Desktop user.
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--mcp-config', configPath,
    '--model', process.env.PROBE_MODEL ?? 'claude-sonnet-5',
    '--permission-mode', 'bypassPermissions',
    '--append-system-prompt',
    'You are running a diagnostic. The MCP tools in your tool surface are your only tools: there is no file system, '
    + 'shell, or web access in this session, and no Read, Bash, Grep, Write, or WebFetch tools. If a tool result is '
    + 'replaced by a truncation notice pointing at a file, you cannot open that file; say so instead.',
    '--tools', '',
  ];

  const child = spawn(process.env.CLAUDE_BIN ?? 'claude', args, {
    shell: false,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, PROBE_PAYLOAD_CHARS: String(chars), PROBE_FILLER: filler },
  });
  child.stdin.write(PROMPT);
  child.stdin.end();

  const pending = new Set<string>();
  let toolResult: string | undefined;
  let finalText = '';
  let buffer = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.length === 0) continue;
      let event: unknown;
      try { event = JSON.parse(line); } catch { continue; }
      if (verbose) console.error(`  [event] ${line.slice(0, 160)}`);
      const e = event as { type?: string; message?: { content?: unknown } };
      if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
        for (const block of e.message.content as { type?: string; id?: string; name?: string; text?: string }[]) {
          if (block.type === 'tool_use' && typeof block.id === 'string' && block.name?.includes('probe_payload') === true) {
            pending.add(block.id);
          } else if (block.type === 'text' && typeof block.text === 'string') {
            finalText += block.text;
          }
        }
      }
      if (e.type === 'user' && Array.isArray(e.message?.content)) {
        for (const block of e.message.content as { type?: string; tool_use_id?: string; content?: unknown }[]) {
          if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
          if (!pending.has(block.tool_use_id)) continue;
          pending.delete(block.tool_use_id);
          toolResult = stringifyResult(block.content);
        }
      }
    }
  });

  await new Promise<void>((resolve) => {
    let settled = false;
    const settle = (): void => { if (!settled) { settled = true; resolve(); } };
    child.on('exit', settle);
    const timer = setTimeout(() => { forceKillTree(child.pid); setTimeout(settle, 5000); }, 240_000);
    child.on('exit', () => clearTimeout(timer));
  });

  const res = toolResult ?? '';
  const canaryInResult = res.includes(CANARY);
  let verdict: Verdict;
  if (toolResult === undefined) verdict = 'no-call';
  else if (/exceeds maximum allowed tokens/i.test(res)) verdict = 'token-error';
  else if (/<persisted-output>|Output too large/i.test(res)) verdict = 'stub';
  else if (canaryInResult && res.length === chars) verdict = 'delivered';
  else verdict = 'unknown';

  const sizeMatch = /Output too large \(([^)]+)\)/.exec(res);

  const out: ProbeResult = {
    chars,
    filler,
    verdict,
    observed_len: res.length,
    canary_in_result: canaryInResult,
    canary_echoed: finalText.includes(CANARY),
    ...(sizeMatch !== null ? { host_reported_size: sizeMatch[1] } : {}),
    result_head: res.slice(0, 400),
    wall_seconds: (Date.now() - startedAt) / 1000,
    at: new Date().toISOString(),
  };
  appendFileSync(RESULTS, JSON.stringify(out) + '\n', 'utf8');
  return out;
}

function stringifyResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c !== null && typeof c === 'object' && 'text' in c)
      ? String((c as { text: unknown }).text)
      : JSON.stringify(c)).join('\n');
  }
  return content === null || content === undefined ? '' : JSON.stringify(content);
}

function report(r: ProbeResult): void {
  const flag = r.verdict === 'delivered' ? '✓' : '✗';
  console.log(
    `  ${flag} ${String(r.chars).padStart(6)} ${r.filler}  ${r.verdict.padEnd(11)}`
    + `  observed=${String(r.observed_len).padStart(6)}  canary=${r.canary_in_result ? 'yes' : 'NO '}`
    + `  echoed=${r.canary_echoed ? 'yes' : 'NO '}`
    + `${r.host_reported_size !== undefined ? `  host_said=${r.host_reported_size}` : ''}`
    + `  (${r.wall_seconds.toFixed(0)}s)`,
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const verbose = argv.includes('--verbose');
  const fillerArg = argv[argv.indexOf('--filler') + 1];
  const filler: 'lo' | 'hi' = argv.includes('--filler') && fillerArg === 'hi' ? 'hi' : 'lo';

  const atIdx = argv.indexOf('--at');
  const searchIdx = argv.indexOf('--search');

  console.log(`host delivery cliff probe  (filler=${filler}, canary="${CANARY}")\n`);

  if (atIdx >= 0) {
    const targets = (argv[atIdx + 1] ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    for (const n of targets) report(await probe(n, filler, verbose));
    return;
  }

  if (searchIdx >= 0) {
    const [loRaw, hiRaw] = (argv[searchIdx + 1] ?? '').split(':');
    let lo = Number(loRaw); // known delivered
    let hi = Number(hiRaw); // known stubbed
    const tolIdx = argv.indexOf('--tol');
    const tol = tolIdx >= 0 ? Number(argv[tolIdx + 1]) : 1;
    while (hi - lo > tol) {
      const mid = Math.floor((lo + hi) / 2);
      const r = await probe(mid, filler, verbose);
      report(r);
      if (r.verdict === 'delivered') lo = mid;
      else if (r.verdict === 'stub' || r.verdict === 'token-error') hi = mid;
      else { console.log(`  inconclusive at ${mid} (${r.verdict}); stopping.`); break; }
    }
    console.log(`\nbracket: delivered at ${lo}, not delivered at ${hi}`);
    return;
  }

  console.log('usage: --at N[,N...] [--filler lo|hi] | --search LO:HI [--tol T]');
}

if (process.argv.includes('--serve')) {
  await serve();
} else {
  await main();
}
