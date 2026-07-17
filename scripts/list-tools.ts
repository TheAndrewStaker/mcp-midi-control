/**
 * Tool inventory generator.
 *
 * Spawns the built MCP server, asks it for every registered tool via
 * `tools/list`, and writes the inventory to docs/TOOLS.md.
 *
 * Also updates the high-level tool-count summary in README.md inside
 * an HTML-comment-fenced region so preflight can detect drift.
 *
 * Run:
 *   npm run tools:inventory                # write docs/TOOLS.md + README region
 *   npm run tools:inventory -- --check     # exit non-zero on drift
 *
 * Exit codes:
 *   0 -- files written (write mode) or no drift detected (check mode)
 *   1 -- drift detected in check mode, or generator failed
 *   2 -- MCP server failed to start
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO_ROOT = process.cwd();
const SERVER_ENTRY = path.resolve(REPO_ROOT, 'packages', 'server-all', 'dist', 'server', 'index.js');
const README_PATH = path.resolve(REPO_ROOT, 'README.md');
const TOOLS_MD_PATH = path.resolve(REPO_ROOT, 'docs', 'TOOLS.md');

const README_REGION_START = '<!-- tool-inventory:generated:start -->';
const README_REGION_END = '<!-- tool-inventory:generated:end -->';

const DESCRIPTION_WARN_CHARS = 600;
const DESCRIPTION_HARD_CAP_CHARS = 1000;

/**
 * Per-tool description-budget overrides. Each entry lifts the hard cap
 * for one tool and carries an inline reason right below it, so the
 * justification lives next to the exception it grants.
 *
 * Membership is intentionally tight: every new entry is a flag that
 * the description should be migrated to structured response fields.
 */
const DESCRIPTION_BUDGET_OVERRIDES: ReadonlyMap<string, number> = new Map([
  // apply_patch (voice-class tool, formerly hydra_apply_patch): ships
  // the full NRPN patch surface (1175 params, per-module sections,
  // save-auth semantics, scene-leveling discipline). Migration to
  // describe_device.agent_guidance is queued but not on this sprint's
  // path. Honest cap until then.
  ['apply_patch', 6000],
  // apply_pattern: the sequencer-authoring surface (Circuit Tracks drums +
  // melodic note tracks, SPD-SX). Carries five pattern-source forms (recipe /
  // voices / notation / tab / midi_file), the step-string / mini-notation /
  // Euclidean grammar, note-token pitch syntax, the key/transpose/scale
  // controls, the live_stream / record_capture / ncs_upload mode semantics,
  // the external_targets routing surface that drives a connected SPD-SX off
  // the Circuit's MIDI 1/2 tracks, and (2026-07-01) one-line pointers to the
  // arrangement (whole-song), drum-role fold, and dry_run piece-compression
  // surfaces whose detail lives in the param descriptions. Migration to
  // describe_device.agent_guidance is queued. Honest cap.
  ['apply_pattern', 3300],
  // import_songsterr: gained the whole_song arrangement mode (2026-07-01);
  // the description carries a one-line pointer, detail in whole_song/fuzz
  // param descriptions. Honest cap.
  ['import_songsterr', 1300],
  // author_kit: the sampler-archetype kit-authoring surface (Roland SPD-SX).
  // Carries the pad-order assignment forms (index / name / -1) AND the object
  // per-pad form (note / poly-mono voice / mute group / dynamics) that switches
  // to the device full-kit format, plus the overwrite gate + power-cycle note,
  // AND (new) the set_notes PATCH mode = non-destructive per-pad note edit on an
  // existing kit (preserves levels/FX; refuses minimal kits). Two modes in one
  // verb justify the larger cap. Migration to describe_device.agent_guidance
  // pending. Honest cap.
  ['author_kit', 2200],
  // apply_preset: spec-shape, target_location semantics, verify_chain,
  // and the audition-vs-save discipline all live in the description.
  // Migration to describe_device.agent_guidance pending post-announce.
  ['apply_preset', 1600],
  // describe_device: carries the supports_save/save_note semantics inline
  // (an agent reading `supports_save: false` without that pointer concludes
  // save_preset is unavailable on gen-3 community-beta devices and refuses
  // a working tool: the 0.3.0 underselling class). Migration of the
  // capabilities-semantics prose to a structured field is the trim path.
  ['describe_device', 1300],
  // lookup_lineage: three call shapes (forward / reverse / structured)
  // plus the loudness-data callout. Migration to a per-call-shape
  // structured response is queued post-announce.
  ['lookup_lineage', 1200],
  // get_preset: the active-channel default plus the include_channel_state
  // opt-in (per-device channel shape + latency tradeoff), the active-scene
  // scope caveat, per-device performance notes, the gen-3 live_meters/
  // active_scene discovery hint, and the read-mutate-write discipline all live
  // in the description. Migration to describe_device.agent_guidance is the
  // planned trim path; pending post-announce.
  ['get_preset', 1320],
  // describe_rig: the whole-rig orchestration entry point. Beyond the roster it
  // returns the OpenRig manifest surface (MCP_RIG_MANIFEST): the declared rig
  // (devices + cabling + channels + cross-device bindings) plus THREE verification
  // checks the description names so an agent knows what each answers, validation
  // (graph well-formed), compatibility (MIDI binding agreement + capability
  // legality), audio (does each instrument reach front-of-house), and drift.
  // Each check earns one clause; detail lives in the response (manifest.*) +
  // OPENRIG-SCHEMA.md. Cap raised from 1350 for the added compat + audio clauses.
  ['describe_rig', 1520],
]);

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

interface ToolEntry {
  name: string;
  description: string;
  charCount: number;
  annotations?: ToolAnnotations;
  /** Agent-visible inputSchema param `.describe()` strings (also linted for em-dashes). */
  paramDescriptions: string[];
}

/**
 * Read/write classification, derived from the same ToolAnnotations the
 * MCP host (Claude Desktop's Manage Connectors page) uses to split tools
 * into read vs write groups. Mirrors the buckets asserted by
 * `scripts/mcp-test-tool-annotations.ts`:
 *   - 'read'        readOnlyHint: true
 *   - 'destructive' not read-only AND destructiveHint: true (persists,
 *                   overwrites, or sends raw bytes)
 *   - 'write'       everything else (reversible working-buffer edits)
 */
type ToolCategory = 'read' | 'write' | 'destructive';

function classify(entry: ToolEntry): ToolCategory {
  const a = entry.annotations;
  if (a?.readOnlyHint === true) return 'read';
  if (a?.destructiveHint === true) return 'destructive';
  return 'write';
}

const CATEGORY_SECTIONS: readonly { category: ToolCategory; heading: string; blurb: string }[] = [
  {
    category: 'read',
    heading: '### Read (read-only)',
    blurb: 'No device state changes. `readOnlyHint: true`. Hosts group these as read tools.',
  },
  {
    category: 'write',
    heading: '### Write (reversible)',
    blurb: 'Working-buffer edits and navigation, reversible by switching presets. Not destructive.',
  },
  {
    category: 'destructive',
    heading: '### Write (destructive)',
    blurb: 'Persists, overwrites a stored location, or sends raw bytes. `destructiveHint: true`.',
  },
];

async function listAllTools(): Promise<ToolEntry[]> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: process.env as Record<string, string>,
    stderr: 'pipe',
  });
  // Silence the server's startup banner; we don't need it cluttering our output.
  if (transport.stderr) transport.stderr.on('data', () => {});
  const client = new Client({ name: 'tool-inventory', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
  } catch (err) {
    console.error(`Failed to connect to MCP server at ${SERVER_ENTRY}:`, err);
    console.error('Did you run `npm run build`?');
    process.exit(2);
  }
  const listed = await client.listTools();
  const entries: ToolEntry[] = (listed.tools ?? []).map((t) => {
    const description = typeof t.description === 'string' ? t.description : '';
    const annotations = (t.annotations ?? undefined) as ToolAnnotations | undefined;
    const props = (t.inputSchema?.properties ?? {}) as Record<string, { description?: unknown }>;
    const paramDescriptions = Object.values(props)
      .map((p) => (typeof p.description === 'string' ? p.description : ''))
      .filter((s) => s.length > 0);
    return { name: t.name, description, charCount: description.length, annotations, paramDescriptions };
  });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  await client.close();
  return entries;
}

function firstSentence(text: string): string {
  if (text.length === 0) return '';
  const trimmed = text.replace(/\s+/g, ' ').trim();
  const dotIdx = trimmed.indexOf('. ');
  const candidate = dotIdx === -1 ? trimmed : trimmed.slice(0, dotIdx + 1);
  return candidate.length > 160 ? candidate.slice(0, 157) + '...' : candidate;
}

function renderToolsMd(all: ToolEntry[]): string {
  const lines: string[] = [];
  lines.push('# MCP Tool Inventory');
  lines.push('');
  lines.push('<!-- generated by scripts/list-tools.ts; do not edit by hand -->');
  lines.push('<!-- regenerate with `npm run tools:inventory`; preflight enforces sync via tools:inventory-check -->');
  lines.push('');
  lines.push(`**Total registered tools:** ${all.length}.`);
  lines.push('');
  const avg = all.length === 0 ? 0 : Math.round(all.reduce((s, t) => s + t.charCount, 0) / all.length);
  const over600 = all.filter((t) => t.charCount > DESCRIPTION_WARN_CHARS).length;
  const over1000 = all.filter((t) => t.charCount > DESCRIPTION_HARD_CAP_CHARS).length;
  const readCount = all.filter((t) => classify(t) === 'read').length;
  const writeCount = all.filter((t) => classify(t) === 'write').length;
  const destructiveCount = all.filter((t) => classify(t) === 'destructive').length;
  lines.push('## Summary');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push('|---|---|');
  lines.push(`| Total tools | ${all.length} |`);
  lines.push(`| Read (read-only) | ${readCount} |`);
  lines.push(`| Write (reversible) | ${writeCount} |`);
  lines.push(`| Write (destructive) | ${destructiveCount} |`);
  lines.push(`| Average description length | ${avg} chars |`);
  lines.push(`| Tools over 600 chars | ${over600} |`);
  lines.push(`| Tools over 1000 chars | ${over1000} |`);
  lines.push('');
  lines.push('## All tools');
  lines.push('');
  lines.push('Grouped by read/write classification, the same `readOnlyHint` / `destructiveHint` annotations a host (e.g. Claude Desktop\'s Manage Connectors page) uses to split read tools from write tools.');
  lines.push('');
  for (const section of CATEGORY_SECTIONS) {
    const inSection = all.filter((t) => classify(t) === section.category);
    lines.push(section.heading);
    lines.push('');
    lines.push(section.blurb);
    lines.push('');
    if (inSection.length === 0) {
      lines.push('_None._');
      lines.push('');
      continue;
    }
    lines.push('| Tool | Description length | First sentence |');
    lines.push('|---|---|---|');
    for (const t of inSection) {
      const flag = t.charCount > DESCRIPTION_HARD_CAP_CHARS
        ? ` ⚠️ over ${DESCRIPTION_HARD_CAP_CHARS}`
        : t.charCount > DESCRIPTION_WARN_CHARS
          ? ` ⚠`
          : '';
      const sentence = firstSentence(t.description).replace(/\|/g, '\\|');
      lines.push(`| \`${t.name}\` | ${t.charCount}${flag} | ${sentence} |`);
    }
    lines.push('');
  }
  lines.push('## Description budget outliers');
  lines.push('');
  lines.push(`Tools with descriptions over ${DESCRIPTION_HARD_CAP_CHARS} chars. Migration to structured response fields (via \`describe_device.agent_guidance\`) is the planned trim path; each override carries an inline reason in \`scripts/list-tools.ts\`.`);
  lines.push('');
  const outliers = all
    .filter((t) => t.charCount > DESCRIPTION_HARD_CAP_CHARS)
    .sort((a, b) => b.charCount - a.charCount);
  if (outliers.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('| Tool | Description length |');
    lines.push('|---|---|');
    for (const t of outliers) {
      lines.push(`| \`${t.name}\` | ${t.charCount} chars |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function renderReadmeRegion(all: ToolEntry[]): string {
  const lines: string[] = [];
  lines.push(README_REGION_START);
  lines.push('');
  lines.push(`**${all.length} MCP tools registered.** Unified surface for tone-building across all supported devices, plus generic-MIDI primitives and device-specific extensions.`);
  lines.push('');
  lines.push('Full tool list with description-length stats: [`docs/TOOLS.md`](docs/TOOLS.md). Generated by `npm run tools:inventory`; preflight checks for drift.');
  lines.push('');
  lines.push(README_REGION_END);
  return lines.join('\n');
}

function spliceReadmeRegion(readme: string, region: string): { updated: string; existed: boolean } {
  const startIdx = readme.indexOf(README_REGION_START);
  const endIdx = readme.indexOf(README_REGION_END);
  if (startIdx === -1 || endIdx === -1) {
    return { updated: readme, existed: false };
  }
  const before = readme.slice(0, startIdx);
  const after = readme.slice(endIdx + README_REGION_END.length);
  return { updated: before + region + after, existed: true };
}

const TOOL_SURFACE_HEADING = '## The tool surface';

/**
 * Extract the set of tool names documented in README's "## The tool
 * surface" section tables. Each tool occupies the first column of a
 * markdown table row as a backtick-quoted name, optionally with a
 * parameter signature that is stripped (`apply_preset(port, spec)` ->
 * apply_preset). Used by the drift check to assert the documented set
 * matches the live registered set, so a new tool cannot ship
 * undocumented and a removed tool cannot linger in the table. We assert
 * the SET, not the prose, so the curated "what it does" column stays
 * hand-written.
 */
function readmeDocumentedTools(readme: string): Set<string> {
  const lines = readme.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => l.trim() === TOOL_SURFACE_HEADING);
  const names = new Set<string>();
  if (startIdx === -1) return names;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    // Stop at the next top-level section.
    if (line.startsWith('## ')) break;
    // Table rows start with a pipe; the first cell holds the tool name
    // in backticks.
    const m = /^\|\s*`([^`]+)`/.exec(line);
    if (!m) continue;
    // Strip a parameter signature: keep the identifier before '('.
    const name = m[1]!.trim().split('(')[0]!.trim();
    // Only accept plausible tool identifiers (snake_case).
    if (/^[a-z][a-z0-9_]*$/.test(name)) names.add(name);
  }
  return names;
}

async function main(): Promise<void> {
  const checkMode = process.argv.includes('--check');
  const all = await listAllTools();
  const toolsMd = renderToolsMd(all);
  const readmeRegion = renderReadmeRegion(all);
  const readme = readFileSync(README_PATH, 'utf8');
  const { updated: newReadme, existed } = spliceReadmeRegion(readme, readmeRegion);

  if (checkMode) {
    let failed = false;
    // Normalize CRLF → LF before comparison so git's core.autocrlf
    // checkout conversion (CRLF on Windows CI) doesn't false-trigger
    // drift against Node's LF-default writeFileSync output.
    const normEol = (s: string) => s.replace(/\r\n/g, '\n');
    const currentTools = (() => {
      try { return readFileSync(TOOLS_MD_PATH, 'utf8'); } catch { return ''; }
    })();
    if (normEol(currentTools) !== normEol(toolsMd)) {
      console.error(`Drift: docs/TOOLS.md is out of sync. Run npm run tools:inventory.`);
      failed = true;
    }
    if (!existed) {
      console.error(`Drift: README.md is missing the generated region markers. Run npm run tools:inventory.`);
      failed = true;
    } else if (normEol(newReadme) !== normEol(readme)) {
      console.error(`Drift: README.md's tool-inventory region is out of sync. Run npm run tools:inventory.`);
      failed = true;
    }
    // Tool-set completeness: the README "## The tool surface" tables must
    // name exactly the registered tools. Catches a new tool shipping
    // undocumented (the failure that motivated this check: set_macro_route
    // and set_mod_route were absent from the tables) and a removed tool
    // lingering in the README. Asserts the name SET only; the prose is
    // hand-curated.
    const documented = readmeDocumentedTools(readme);
    const registered = new Set(all.map((t) => t.name));
    const missingFromReadme = [...registered].filter((n) => !documented.has(n)).sort();
    const phantomInReadme = [...documented].filter((n) => !registered.has(n)).sort();
    if (missingFromReadme.length > 0) {
      console.error(
        `README tool-surface drift: ${missingFromReadme.length} registered ` +
          `tool(s) missing from the "## The tool surface" tables: ` +
          `${missingFromReadme.join(', ')}. Add a row (with a hand-written ` +
          `description) under the right family.`,
      );
      failed = true;
    }
    if (phantomInReadme.length > 0) {
      console.error(
        `README tool-surface drift: ${phantomInReadme.length} tool(s) in the ` +
          `README tables are not registered: ${phantomInReadme.join(', ')}. ` +
          `Remove the stale row or fix the name.`,
      );
      failed = true;
    }
    // Description budget lint. Fails on any tool over
    // the 1000-char hard cap (unless explicitly overridden in
    // DESCRIPTION_BUDGET_OVERRIDES). Warns over 600. Catches the
    // failure mode the original reviewer named: prose creeping back
    // into tool descriptions across sessions with no automated guard.
    const offenders: { name: string; chars: number; cap: number }[] = [];
    const warnings: { name: string; chars: number }[] = [];
    for (const tool of all) {
      const cap = DESCRIPTION_BUDGET_OVERRIDES.get(tool.name) ?? DESCRIPTION_HARD_CAP_CHARS;
      if (tool.charCount > cap) {
        offenders.push({ name: tool.name, chars: tool.charCount, cap });
      } else if (tool.charCount > DESCRIPTION_WARN_CHARS) {
        warnings.push({ name: tool.name, chars: tool.charCount });
      }
    }
    // Em-dash lint on agent-visible text. Em-dashes
    // are an AI tell per the global no-em-dash rule (substitute commas,
    // periods, colons, or parens). Scans actual tool descriptions as
    // returned by tools/list, not source files, so it catches what the
    // agent sees regardless of how the description was authored.
    // Scans BOTH the top-level description AND every inputSchema param
    // description (both are agent-visible). Param descriptions were a blind spot
    // that let em-dashes ship past a green check (tool-surface review 2026-06-23).
    const emDashOffenders: { name: string; count: number; where: string }[] = [];
    for (const tool of all) {
      const descCount = (tool.description.match(/—/g) || []).length;
      const paramCount = tool.paramDescriptions.reduce((n, p) => n + (p.match(/—/g) || []).length, 0);
      if (descCount + paramCount > 0) {
        const where = [descCount > 0 ? 'description' : '', paramCount > 0 ? 'param(s)' : ''].filter(Boolean).join(' + ');
        emDashOffenders.push({ name: tool.name, count: descCount + paramCount, where });
      }
    }
    if (emDashOffenders.length > 0) {
      console.error(
        `Em-dash lint: ${emDashOffenders.length} tool(s) have em-dashes in agent-visible text (description and/or param descriptions). ` +
        `Substitute commas, periods, colons, or parens per the global no-em-dash rule.`,
      );
      for (const o of emDashOffenders) {
        console.error(`  - ${o.name}: ${o.count} em-dash(es) in ${o.where}`);
      }
      failed = true;
    }
    if (offenders.length > 0) {
      console.error(
        `Description budget: ${offenders.length} tool(s) exceed their cap. ` +
        `Trim the description or add an override in scripts/list-tools.ts ` +
        `DESCRIPTION_BUDGET_OVERRIDES (with an inline reason).`,
      );
      for (const o of offenders) {
        const overrideNote = DESCRIPTION_BUDGET_OVERRIDES.has(o.name)
          ? ` (override cap ${o.cap})`
          : '';
        console.error(`  - ${o.name}: ${o.chars} chars${overrideNote}`);
      }
      failed = true;
    }
    if (warnings.length > 0) {
      console.error(
        `Description budget warning: ${warnings.length} tool(s) over ${DESCRIPTION_WARN_CHARS} chars (under 1000 hard cap; not blocking).`,
      );
      for (const w of warnings) {
        console.error(`  - ${w.name}: ${w.chars} chars`);
      }
    }
    if (failed) process.exit(1);
    console.log(`No drift, ${offenders.length} budget violations, ${warnings.length} warnings (${all.length} tools).`);
    return;
  }

  writeFileSync(TOOLS_MD_PATH, toolsMd, 'utf8');
  console.log(`Wrote docs/TOOLS.md (${all.length} tools).`);
  if (existed) {
    if (newReadme !== readme) {
      writeFileSync(README_PATH, newReadme, 'utf8');
      console.log(`Updated README.md tool-inventory region.`);
    } else {
      console.log(`README.md tool-inventory region is already up to date.`);
    }
  } else {
    console.error(`README.md is missing the region markers; add this block where you want the auto-generated summary:\n${readmeRegion}\n`);
  }
}

main().catch((err) => {
  console.error('tool-inventory generator failed:', err);
  process.exit(1);
});
