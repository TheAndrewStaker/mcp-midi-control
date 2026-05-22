/**
 * Tool inventory generator (T-1).
 *
 * Spawns the built MCP server with MCP_TOOLS_PROFILE=full, asks it
 * for every registered tool via `tools/list`, partitions the result
 * into core / experimental / full profiles using the same set logic
 * the server uses at boot, and writes the inventory to docs/TOOLS.md.
 *
 * Also updates the high-level tool-count summary in README.md inside
 * an HTML-comment-fenced region so preflight can detect drift.
 *
 * Run:
 *   npm run tools:inventory                # write docs/TOOLS.md + README region
 *   npm run tools:inventory -- --check     # exit non-zero on drift
 *
 * Exit codes:
 *   0 — files written (write mode) or no drift detected (check mode)
 *   1 — drift detected in check mode, or generator failed
 *   2 — MCP server failed to start
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  CORE_TOOLS,
  EXPERIMENTAL_EXCLUDED,
} from '../packages/server-all/dist/server/toolProfiles.js';

const REPO_ROOT = process.cwd();
const SERVER_ENTRY = path.resolve(REPO_ROOT, 'packages', 'server-all', 'dist', 'server', 'index.js');
const README_PATH = path.resolve(REPO_ROOT, 'README.md');
const TOOLS_MD_PATH = path.resolve(REPO_ROOT, 'docs', 'TOOLS.md');

const README_REGION_START = '<!-- tool-inventory:generated:start -->';
const README_REGION_END = '<!-- tool-inventory:generated:end -->';

const DESCRIPTION_WARN_CHARS = 600;
const DESCRIPTION_HARD_CAP_CHARS = 1000;

/**
 * T-19 (2026-05-22): per-tool description-budget overrides. Each entry
 * lifts the hard cap for one tool with a documented reason. Adding a
 * tool here requires a matching row in docs/TOOL-ARCHIVE.md's
 * "Documented exceptions to description-budget cap" section so the
 * exception lives outside the source as well.
 *
 * Membership is intentionally tight: every new entry is a flag that
 * the description should be migrated to structured response fields.
 */
const DESCRIPTION_BUDGET_OVERRIDES: ReadonlyMap<string, number> = new Map([
  // hydra_apply_patch: ships the full NRPN patch surface (1175 params,
  // per-module sections, save-auth semantics, scene-leveling
  // discipline). Migration to describe_device.agent_guidance is queued
  // but not on this sprint's path. Honest cap until then.
  ['hydra_apply_patch', 6000],
  // axefx3_set_parameter: BETA prefix + raw-wire-value EXCEPTION-TO-
  // DISPLAY-FIRST callout + GET hypothesis banner inflate the
  // description. Migration to describe_device.agent_guidance lands when
  // III moves out of community beta.
  ['axefx3_set_parameter', 1600],
]);

interface ToolEntry {
  name: string;
  description: string;
  charCount: number;
}

interface ProfileBucket {
  name: 'core' | 'experimental' | 'full';
  description: string;
  tools: ToolEntry[];
}

async function listAllTools(): Promise<ToolEntry[]> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: { ...process.env, MCP_TOOLS_PROFILE: 'full' },
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
    return { name: t.name, description, charCount: description.length };
  });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  await client.close();
  return entries;
}

function bucketByProfile(all: ToolEntry[]): ProfileBucket[] {
  const core = all.filter((t) => CORE_TOOLS.has(t.name));
  const experimental = all.filter((t) => !EXPERIMENTAL_EXCLUDED.has(t.name));
  return [
    {
      name: 'core',
      description:
        'Default-recommended unified surface for conversational tone-building. Smallest agent context. Set `MCP_TOOLS_PROFILE=core` to select.',
      tools: core,
    },
    {
      name: 'experimental',
      description:
        'Core + every device-namespaced tool + raw generic-MIDI primitives + diagnostics. Used during dev when poking hardware-specific capabilities. Set `MCP_TOOLS_PROFILE=experimental` to select.',
      tools: experimental,
    },
    {
      name: 'full',
      description:
        'Everything registered (current default; equivalent to no env var). Preserved as the v0.1 baseline so upgrades do not lose tools.',
      tools: all,
    },
  ];
}

function firstSentence(text: string): string {
  if (text.length === 0) return '';
  const trimmed = text.replace(/\s+/g, ' ').trim();
  const dotIdx = trimmed.indexOf('. ');
  const candidate = dotIdx === -1 ? trimmed : trimmed.slice(0, dotIdx + 1);
  return candidate.length > 160 ? candidate.slice(0, 157) + '...' : candidate;
}

function renderToolsMd(buckets: ProfileBucket[], all: ToolEntry[]): string {
  const lines: string[] = [];
  lines.push('# MCP Tool Inventory');
  lines.push('');
  lines.push('<!-- generated by scripts/list-tools.ts; do not edit by hand -->');
  lines.push('<!-- regenerate with `npm run tools:inventory`; preflight enforces sync via tools:inventory-check -->');
  lines.push('');
  lines.push(`**Total registered tools:** ${all.length}.`);
  lines.push('');
  lines.push('The server exposes three tool profiles selected at boot via the `MCP_TOOLS_PROFILE` env var (set in your `claude_desktop_config.json`). Tools listed under a profile appear in `tools/list` when that profile is active; tools excluded from a profile are not registered at all (no token cost in the agent context).');
  lines.push('');
  lines.push('See [README.md § Configuring tool profiles](../README.md#configuring-tool-profiles) for setup. To resurrect a tool that has been permanently removed (rather than profile-hidden), see [TOOL-ARCHIVE.md](TOOL-ARCHIVE.md).');
  lines.push('');
  lines.push('## Profile counts');
  lines.push('');
  lines.push('| Profile | Tool count | Average description length | Tools over 600 chars | Tools over 1000 chars |');
  lines.push('|---|---|---|---|---|');
  for (const b of buckets) {
    const total = b.tools.length;
    const avg = total === 0 ? 0 : Math.round(b.tools.reduce((s, t) => s + t.charCount, 0) / total);
    const over600 = b.tools.filter((t) => t.charCount > DESCRIPTION_WARN_CHARS).length;
    const over1000 = b.tools.filter((t) => t.charCount > DESCRIPTION_HARD_CAP_CHARS).length;
    lines.push(`| \`${b.name}\` | ${total} | ${avg} chars | ${over600} | ${over1000} |`);
  }
  lines.push('');
  for (const b of buckets) {
    lines.push(`## ${b.name} profile (${b.tools.length} tools)`);
    lines.push('');
    lines.push(b.description);
    lines.push('');
    lines.push('| Tool | Description length | First sentence |');
    lines.push('|---|---|---|');
    for (const t of b.tools) {
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
  lines.push(`Tools with descriptions over ${DESCRIPTION_HARD_CAP_CHARS} chars. T-4 / T-13 target these for migration into structured response fields.`);
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

function renderReadmeRegion(buckets: ProfileBucket[], all: ToolEntry[]): string {
  const lines: string[] = [];
  lines.push(README_REGION_START);
  lines.push('');
  const core = buckets.find((b) => b.name === 'core');
  const coreCount = core ? core.tools.length : 0;
  lines.push(`**${all.length} MCP tools registered. The default \`core\` profile exposes ${coreCount} of them** (unified surface essentials + conversational generic-MIDI). Set \`MCP_TOOLS_PROFILE=experimental\` or \`=full\` in \`claude_desktop_config.json\` env to expose the larger surfaces (device-namespaced tools, raw MIDI primitives, diagnostics).`);
  lines.push('');
  lines.push('| Profile | Tool count | When to use |');
  lines.push('|---|---|---|');
  for (const b of buckets) {
    const when = b.name === 'core'
      ? 'Default. Smallest agent context; daily driver for tone-building and preset work.'
      : b.name === 'experimental'
        ? 'Hardware-specific control + diagnostic probes; raw MIDI send_* primitives.'
        : 'Compatibility baseline matching the v0.1 surface.';
    lines.push(`| \`${b.name}\` | ${b.tools.length} | ${when} |`);
  }
  lines.push('');
  lines.push('Full per-profile tool list with description-length stats: [`docs/TOOLS.md`](docs/TOOLS.md). Generated by `npm run tools:inventory`; preflight checks for drift.');
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

async function main(): Promise<void> {
  const checkMode = process.argv.includes('--check');
  const all = await listAllTools();
  const buckets = bucketByProfile(all);
  const toolsMd = renderToolsMd(buckets, all);
  const readmeRegion = renderReadmeRegion(buckets, all);
  const readme = readFileSync(README_PATH, 'utf8');
  const { updated: newReadme, existed } = spliceReadmeRegion(readme, readmeRegion);

  if (checkMode) {
    let failed = false;
    const currentTools = (() => {
      try { return readFileSync(TOOLS_MD_PATH, 'utf8'); } catch { return ''; }
    })();
    if (currentTools !== toolsMd) {
      console.error(`Drift: docs/TOOLS.md is out of sync. Run npm run tools:inventory.`);
      failed = true;
    }
    if (!existed) {
      console.error(`Drift: README.md is missing the generated region markers. Run npm run tools:inventory.`);
      failed = true;
    } else if (newReadme !== readme) {
      console.error(`Drift: README.md's tool-inventory region is out of sync. Run npm run tools:inventory.`);
      failed = true;
    }
    // T-19 (2026-05-22): description budget lint. Fails on any tool over
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
    // T-9 (2026-05-22): em-dash lint on agent-visible text. Em-dashes
    // are an AI tell per the global no-em-dash rule (substitute commas,
    // periods, colons, or parens). Scans actual tool descriptions as
    // returned by tools/list, not source files, so it catches what the
    // agent sees regardless of how the description was authored.
    const emDashOffenders: { name: string; count: number }[] = [];
    for (const tool of all) {
      const count = (tool.description.match(/—/g) || []).length;
      if (count > 0) emDashOffenders.push({ name: tool.name, count });
    }
    if (emDashOffenders.length > 0) {
      console.error(
        `Em-dash lint: ${emDashOffenders.length} tool description(s) contain em-dashes. ` +
        `Substitute commas, periods, colons, or parens per the global no-em-dash rule.`,
      );
      for (const o of emDashOffenders) {
        console.error(`  - ${o.name}: ${o.count} em-dash(es)`);
      }
      failed = true;
    }
    if (offenders.length > 0) {
      console.error(
        `Description budget: ${offenders.length} tool(s) exceed their cap. ` +
        `Trim the description or add an override in scripts/list-tools.ts ` +
        `DESCRIPTION_BUDGET_OVERRIDES (with a matching row in ` +
        `docs/TOOL-ARCHIVE.md "Documented exceptions").`,
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
  console.log(`Wrote docs/TOOLS.md (${all.length} tools across ${buckets.length} profiles).`);
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
