/**
 * Analyze MCP server logs from Claude Desktop sessions.
 *
 * Claude Desktop writes every MCP message (request + response) to
 * `mcp.log` and per-server logs under
 * `%LOCALAPPDATA%/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/Claude/logs/`.
 * This script parses those logs and surfaces:
 *
 *   - Tool-call frequency (which tools are agents actually using?)
 *   - Error patterns (which tools fail most often, with what errors?)
 *   - Argument shapes (what blocks / params do agents pass?)
 *   - Tool-call sequences (common 2-3-tool flows)
 *   - Server lifecycle (init / shutdown / crash events)
 *   - Time-bucketed activity (when are sessions happening?)
 *
 * Maintenance value: every time we ship a new tool or change a
 * description, the next session's logs reveal whether agents
 * actually pick up the new shape. Lets us catch silent
 * description drift (agent picks the wrong tool) and confirms
 * deprecated tools are no longer in use before we remove them.
 *
 * Run:
 *   npm run analyze-logs                              (default: stats summary)
 *   npm run analyze-logs -- --since=2026-05-20         (only entries after a date)
 *   npm run analyze-logs -- --errors                   (just error patterns)
 *   npm run analyze-logs -- --sequences                (common N-tool flows)
 *
 * Output goes to stdout as Markdown by default. The output is
 * append-friendly to docs/_private/ANALYSIS.md so accumulated
 * runs build a history of agent behavior over time.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// Claude Desktop installs to one of two paths depending on Store vs
// MSI install. Memory entry confirms the Store path on this machine.
const CLAUDE_LOGS_STORE = path.join(
  process.env.LOCALAPPDATA ?? '',
  'Packages',
  'Claude_pzs8sxrjxfjjc',
  'LocalCache',
  'Roaming',
  'Claude',
  'logs',
);
const CLAUDE_LOGS_MSI = path.join(process.env.APPDATA ?? '', 'Claude', 'logs');

function resolveLogsDir(): string {
  if (existsSync(CLAUDE_LOGS_STORE)) return CLAUDE_LOGS_STORE;
  if (existsSync(CLAUDE_LOGS_MSI)) return CLAUDE_LOGS_MSI;
  throw new Error(
    'Claude Desktop logs directory not found. Checked:\n'
    + `  ${CLAUDE_LOGS_STORE}\n`
    + `  ${CLAUDE_LOGS_MSI}\n`
    + 'If Claude Desktop is installed elsewhere, add the path here.',
  );
}

// ── Log entry shape ──────────────────────────────────────────────

/**
 * Each line in mcp.log has the shape:
 *
 *   2026-05-19T14:05:46.820Z [info] [mcp-midi-control] Message from client: {...JSON...}
 *
 * The JSON payload is a JSON-RPC envelope (initialize / tools/call /
 * tool result / notifications). We parse the JSON and classify by
 * method / direction.
 */
interface LogEntry {
  timestamp: string;
  level: string;
  server: string;
  direction: 'client' | 'server' | 'system';
  rawPayload: string;
  parsed?: unknown;
}

interface ToolCall {
  timestamp: string;
  server: string;
  toolName: string;
  args: Record<string, unknown>;
  callId: number | string;
}

interface ToolResult {
  timestamp: string;
  server: string;
  callId: number | string;
  isError: boolean;
  errorSummary?: string;
}

// ── Parser ───────────────────────────────────────────────────────

const LINE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s+\[(\w+)\]\s+(?:\[([^\]]+)\]\s+)?(.+)$/;

function parseLogFile(filePath: string): LogEntry[] {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, 'utf8');
  const out: LogEntry[] = [];
  let current: LogEntry | undefined;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const m = LINE_RE.exec(line);
    if (m) {
      if (current !== undefined) out.push(current);
      const [, ts, level, server, rest] = m;
      let direction: 'client' | 'server' | 'system' = 'system';
      if (rest.startsWith('Message from client:')) direction = 'client';
      else if (rest.startsWith('Message from server:')) direction = 'server';
      // Strip prefix to get the JSON payload (or other text).
      const payload = rest
        .replace(/^Message from client:\s*/, '')
        .replace(/^Message from server:\s*/, '');
      current = {
        timestamp: ts,
        level,
        server: server ?? '',
        direction,
        rawPayload: payload,
      };
    } else if (current !== undefined) {
      // Continuation line (multiline JSON / multiline text).
      current.rawPayload += '\n' + line;
    }
  }
  if (current !== undefined) out.push(current);
  // Attempt to parse JSON payloads.
  for (const e of out) {
    if (e.direction === 'system') continue;
    try {
      e.parsed = JSON.parse(e.rawPayload);
    } catch {
      // Some entries are truncated by Claude Desktop with `[XXXX chars truncated]`.
      // Skip parsing those; the raw payload still has the leading method name.
    }
  }
  return out;
}

function isJsonRpcCall(parsed: unknown): parsed is { method: string; params?: { name?: string; arguments?: Record<string, unknown> }; id?: number | string } {
  if (parsed === null || typeof parsed !== 'object') return false;
  return 'method' in parsed;
}

function isJsonRpcResult(parsed: unknown): parsed is { id?: number | string; result?: { isError?: boolean; content?: unknown[] } } {
  if (parsed === null || typeof parsed !== 'object') return false;
  return 'result' in parsed && !('method' in parsed);
}

function extractToolCalls(entries: LogEntry[]): ToolCall[] {
  const out: ToolCall[] = [];
  for (const e of entries) {
    if (e.direction !== 'client' || e.parsed === undefined) continue;
    const p = e.parsed as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> }; id?: number | string };
    if (!isJsonRpcCall(p)) continue;
    if (p.method !== 'tools/call') continue;
    const name = p.params?.name;
    if (typeof name !== 'string') continue;
    out.push({
      timestamp: e.timestamp,
      server: e.server,
      toolName: name,
      args: (p.params?.arguments ?? {}) as Record<string, unknown>,
      callId: p.id ?? -1,
    });
  }
  return out;
}

function extractToolResults(entries: LogEntry[]): ToolResult[] {
  const out: ToolResult[] = [];
  for (const e of entries) {
    if (e.direction !== 'server' || e.parsed === undefined) continue;
    if (!isJsonRpcResult(e.parsed)) continue;
    const p = e.parsed;
    const result = p.result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
    if (result === undefined) continue;
    let errorSummary: string | undefined;
    if (result.isError === true) {
      const firstText = result.content?.[0]?.text;
      errorSummary = typeof firstText === 'string'
        ? firstText.slice(0, 240).replace(/\s+/g, ' ')
        : '<no error text>';
    }
    out.push({
      timestamp: e.timestamp,
      server: e.server,
      callId: p.id ?? -1,
      isError: result.isError === true,
      errorSummary,
    });
  }
  return out;
}

// ── Aggregations ─────────────────────────────────────────────────

function countByTool(calls: readonly ToolCall[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of calls) out.set(c.toolName, (out.get(c.toolName) ?? 0) + 1);
  return out;
}

function joinCallsAndResults(
  calls: readonly ToolCall[],
  results: readonly ToolResult[],
): Array<ToolCall & { result?: ToolResult }> {
  // Sessions can repeat call IDs across reconnects. Match by (server, callId)
  // within a session window: pair each call with the FIRST result that has
  // the same id and timestamp >= call.
  const callsByKey = new Map<string, ToolCall[]>();
  for (const c of calls) {
    const k = `${c.server}/${c.callId}`;
    if (!callsByKey.has(k)) callsByKey.set(k, []);
    callsByKey.get(k)!.push(c);
  }
  const resultsByKey = new Map<string, ToolResult[]>();
  for (const r of results) {
    const k = `${r.server}/${r.callId}`;
    if (!resultsByKey.has(k)) resultsByKey.set(k, []);
    resultsByKey.get(k)!.push(r);
  }
  const joined: Array<ToolCall & { result?: ToolResult }> = [];
  for (const c of calls) {
    const k = `${c.server}/${c.callId}`;
    const candidates = resultsByKey.get(k) ?? [];
    const match = candidates.find((r) => r.timestamp >= c.timestamp);
    joined.push({ ...c, result: match });
  }
  return joined;
}

function errorsByTool(joined: readonly (ToolCall & { result?: ToolResult })[]): Map<string, { total: number; errors: number; samples: string[] }> {
  const out = new Map<string, { total: number; errors: number; samples: string[] }>();
  for (const c of joined) {
    if (!out.has(c.toolName)) out.set(c.toolName, { total: 0, errors: 0, samples: [] });
    const e = out.get(c.toolName)!;
    e.total += 1;
    if (c.result?.isError === true) {
      e.errors += 1;
      if (e.samples.length < 3 && c.result.errorSummary !== undefined) {
        e.samples.push(c.result.errorSummary);
      }
    }
  }
  return out;
}

function commonSequences(calls: readonly ToolCall[], n: number): Map<string, number> {
  // Group calls into sessions by 5-minute gaps; emit overlapping n-tuples
  // of tool names. Useful for "discovery flow" or "tone-build flow"
  // detection.
  const GAP_MS = 5 * 60 * 1000;
  const sessions: ToolCall[][] = [];
  let cur: ToolCall[] = [];
  let prevTs = 0;
  for (const c of calls) {
    const ts = new Date(c.timestamp).getTime();
    if (cur.length > 0 && ts - prevTs > GAP_MS) {
      sessions.push(cur);
      cur = [];
    }
    cur.push(c);
    prevTs = ts;
  }
  if (cur.length > 0) sessions.push(cur);
  const counts = new Map<string, number>();
  for (const s of sessions) {
    for (let i = 0; i + n <= s.length; i++) {
      const seq = s.slice(i, i + n).map((c) => c.toolName).join(' -> ');
      counts.set(seq, (counts.get(seq) ?? 0) + 1);
    }
  }
  return counts;
}

// ── Output ───────────────────────────────────────────────────────

function formatTable(rows: Array<[string, string | number]>, headers: [string, string]): string {
  const w0 = Math.max(headers[0].length, ...rows.map((r) => r[0].length));
  const w1 = Math.max(headers[1].length, ...rows.map((r) => String(r[1]).length));
  const fmt = (a: string, b: string | number): string =>
    `| ${a.padEnd(w0)} | ${String(b).padStart(w1)} |`;
  return [
    fmt(headers[0], headers[1]),
    `|${'-'.repeat(w0 + 2)}|${'-'.repeat(w1 + 2)}|`,
    ...rows.map((r) => fmt(r[0], r[1])),
  ].join('\n');
}

function main(): void {
  const args = process.argv.slice(2);
  const sinceArg = args.find((a) => a.startsWith('--since='))?.split('=')[1];
  const errorsOnly = args.includes('--errors');
  const sequencesOnly = args.includes('--sequences');

  const logsDir = resolveLogsDir();
  const mcpLog = path.join(logsDir, 'mcp.log');
  console.log(`# MCP Log Analysis`);
  console.log(``);
  console.log(`Source: \`${mcpLog}\``);
  console.log(`Generated: ${new Date().toISOString()}`);
  if (sinceArg !== undefined) console.log(`Filter: entries since ${sinceArg}`);
  console.log(``);

  const entries = parseLogFile(mcpLog);
  const filtered = sinceArg === undefined
    ? entries
    : entries.filter((e) => e.timestamp >= sinceArg);
  console.log(`Parsed ${entries.length} log entries (${filtered.length} after filter).`);
  console.log(``);

  const calls = extractToolCalls(filtered);
  const results = extractToolResults(filtered);
  const joined = joinCallsAndResults(calls, results);
  console.log(`Tool calls: ${calls.length}.  Results matched: ${joined.filter((c) => c.result !== undefined).length}.`);
  console.log(``);

  if (sequencesOnly) {
    console.log(`## Common 3-tool sequences (across sessions)`);
    console.log(``);
    const sequences = commonSequences(calls, 3);
    const top = [...sequences.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    console.log(formatTable(top.map(([s, n]) => [s, n]), ['Sequence', 'Count']));
    return;
  }

  if (!errorsOnly) {
    console.log(`## Tool-call frequency`);
    console.log(``);
    const counts = countByTool(calls);
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    console.log(formatTable(sorted.slice(0, 30).map(([t, n]) => [t, n]), ['Tool', 'Calls']));
    console.log(``);
    if (sorted.length > 30) console.log(`(${sorted.length - 30} more tools with fewer calls.)`);
    console.log(``);
  }

  console.log(`## Error rate per tool`);
  console.log(``);
  const errs = errorsByTool(joined);
  const errRows: Array<[string, string]> = [];
  for (const [tool, stats] of [...errs.entries()].sort((a, b) => b[1].errors - a[1].errors)) {
    if (stats.errors === 0) continue;
    const rate = ((stats.errors / stats.total) * 100).toFixed(1) + '%';
    errRows.push([tool, `${stats.errors}/${stats.total}  (${rate})`]);
  }
  if (errRows.length === 0) {
    console.log(`No errored tool calls in this window.`);
  } else {
    console.log(formatTable(errRows.slice(0, 30), ['Tool', 'Errors / Total']));
    console.log(``);
    console.log(`### Sample error texts`);
    console.log(``);
    for (const [tool, stats] of errs.entries()) {
      if (stats.samples.length === 0) continue;
      console.log(`- **${tool}**`);
      for (const s of stats.samples) console.log(`  - ${s.slice(0, 200)}`);
    }
  }

  if (!errorsOnly) {
    console.log(``);
    console.log(`## Common 2-tool sequences (top 15)`);
    console.log(``);
    const seqs = commonSequences(calls, 2);
    const topSeqs = [...seqs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    console.log(formatTable(topSeqs.map(([s, n]) => [s, n]), ['Sequence', 'Count']));
  }
}

main();
