// extract-axe-fx-ii-catalog.ts
//
// Parse Axe-Edit's embedded XML resource files (extracted from
// Axe-Edit.exe via the JUCE BinaryData ZIP shortcut documented in
// docs/capture-guides/juce-binarydata-extraction.md) and produce the
// Axe-Fx II / Fractal-Edit-family parameter catalog.
//
// Outputs:
//   samples/captured/decoded/labels/axe-edit-catalog.json
//     Full structured dump: every <EditorControl> tuple with full
//     parent-stack context and applicability gate metadata.
//
//   docs/devices/axe-fx-ii/component-catalog.md
//     Human-readable RE artefact (PUBLIC, ships in repo). Block-type
//     inventory, parameter counts per block, type-applicability gate
//     summary, scenes, key facts. Mirrors the role
//     docs/devices/am4/SYSEX-MAP.md plays for AM4 protocol RE.
//
// Source files (extracted by extract-juce-resources-zip.ts from the
// JUCE BinaryData ZIP embedded in Axe-Edit.exe):
//   - samples/captured/decoded/binarydata/axe-edit-extracted/__block_layout.xml
//   - samples/captured/decoded/binarydata/axe-edit-extracted/__components.xml
//
// XML hierarchy mirrors AM4-Edit (same JUCE skin engine v3.0):
//   <EffectLayouts>
//     <EditorControls name="<block>">
//       <EffectVariants>
//         <EffectVariant value="..." name="<variant>">
//           <Page name="<page>" layout="...">
//             <Parameters>
//               <Row>
//                 <EditorControl name="<label>" parameterName="<symbolic-id>" type="<widget>"
//                                controllingParamName="..." controllingParamValue="..."
//                                controllingParamStrValue="..." />
//
// Same parser shape as scripts/parse-am4edit-labels.ts. Keeping a
// separate script for now (rather than parameterizing the AM4 one)
// because (a) the output artefacts differ — AM4 emits a TS labels
// module, this emits a docs catalog, and (b) AM4 has multiple page-
// layer XMLs (basic + expert + components) while Axe-Edit collapses
// everything into one __block_layout.xml.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const SOURCES = [
    {
        path: 'samples/captured/decoded/binarydata/axe-edit-extracted/__block_layout.xml',
    },
] as const;

const OUT_JSON = 'samples/captured/decoded/labels/axe-edit-catalog.json';
const OUT_MD   = 'docs/devices/axe-fx-ii/component-catalog.md';

mkdirSync('samples/captured/decoded/labels', { recursive: true });

// ── Tag-stream walker ─────────────────────────────────────────────

interface TagToken {
    kind: 'open' | 'close' | 'self' | 'comment' | 'pi';
    name: string;
    attrs: Record<string, string>;
    raw: string;
}

const TAG_RE = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([A-Za-z_][\w-]*)\s*>|<([A-Za-z_][\w-]*)\b([^>]*?)(\/?)>/g;
const ATTR_RE = /([A-Za-z_][\w-]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g;

function decodeEntities(s: string): string {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#10;/g, '\n')
        .replace(/&amp;/g, '&');
}

function parseAttrs(raw: string): Record<string, string> {
    const out: Record<string, string> = {};
    raw.replace(ATTR_RE, (_, k, v) => {
        out[k] = decodeEntities(v);
        return '';
    });
    return out;
}

function* tokenize(xml: string): Generator<TagToken> {
    let m: RegExpExecArray | null;
    while ((m = TAG_RE.exec(xml)) !== null) {
        const raw = m[0];
        if (raw.startsWith('<!--')) {
            yield { kind: 'comment', name: '', attrs: {}, raw };
            continue;
        }
        if (raw.startsWith('<?')) {
            yield { kind: 'pi', name: '', attrs: {}, raw };
            continue;
        }
        if (m[1] !== undefined) {
            yield { kind: 'close', name: m[1], attrs: {}, raw };
            continue;
        }
        const tagName = m[2];
        const attrText = m[3] ?? '';
        const isSelf = m[4] === '/';
        yield {
            kind: isSelf ? 'self' : 'open',
            name: tagName,
            attrs: parseAttrs(attrText),
            raw,
        };
    }
}

// ── Captured shape ────────────────────────────────────────────────

interface EditorControlEntry {
    label: string;
    parameterName: string;
    controlType: string;
    block: string;
    variant: string;
    variantValue: string;
    page: string;
    pageLayout: string;
    /** Type-applicability gate (cf. AM4 docs/_private/STATE.md Session 47): */
    controllingParamName?: string;
    controllingParamValue?: string;
    controllingParamStrValue?: string;
    raw: Record<string, string>;
}

interface DeviceDecl {
    model: string;
    majorVersion: string;
    minorVersion: string;
}

interface StackFrame {
    name: string;
    attrs: Record<string, string>;
}

const all: EditorControlEntry[] = [];
const devices: DeviceDecl[] = [];
let configVersion = '';
let configName = '';

for (const src of SOURCES) {
    const xml = readFileSync(src.path, 'utf8');
    const stack: StackFrame[] = [];

    function findAttrUp(elName: string, attrName: string): string | undefined {
        for (let i = stack.length - 1; i >= 0; i--) {
            if (stack[i].name === elName) return stack[i].attrs[attrName];
        }
        return undefined;
    }

    for (const tok of tokenize(xml)) {
        if (tok.kind === 'open') {
            if (tok.name === 'CONFIG') {
                configName = tok.attrs.name ?? '';
                configVersion = `${tok.attrs.version ?? ''}.${tok.attrs.revision ?? ''}`;
            }
            stack.push({ name: tok.name, attrs: tok.attrs });
        } else if (tok.kind === 'close') {
            for (let i = stack.length - 1; i >= 0; i--) {
                if (stack[i].name === tok.name) {
                    stack.length = i;
                    break;
                }
            }
        } else if (tok.kind === 'self') {
            if (tok.name === 'Device') {
                devices.push({
                    model: tok.attrs.model ?? '',
                    majorVersion: tok.attrs.majorVersion ?? '',
                    minorVersion: tok.attrs.minorVersion ?? '',
                });
            }
            if (tok.name === 'EditorControl') {
                const label = tok.attrs.name ?? '';
                const parameterName = tok.attrs.parameterName ?? '';
                const controlType = tok.attrs.type ?? '';

                const block        = findAttrUp('EditorControls', 'name')   ?? '';
                const variant      = findAttrUp('EffectVariant', 'name')    ?? '';
                const variantValue = findAttrUp('EffectVariant', 'value')   ?? '';
                const page         = findAttrUp('Page', 'name')             ?? '';
                const pageLayout   = findAttrUp('Page', 'layout')           ?? '';

                if (parameterName.length > 0) {
                    const entry: EditorControlEntry = {
                        label,
                        parameterName,
                        controlType,
                        block,
                        variant,
                        variantValue,
                        page,
                        pageLayout,
                        raw: tok.attrs,
                    };
                    if (tok.attrs.controllingParamName !== undefined) {
                        entry.controllingParamName = tok.attrs.controllingParamName;
                    }
                    if (tok.attrs.controllingParamValue !== undefined) {
                        entry.controllingParamValue = tok.attrs.controllingParamValue;
                    }
                    if (tok.attrs.controllingParamStrValue !== undefined) {
                        entry.controllingParamStrValue = tok.attrs.controllingParamStrValue;
                    }
                    all.push(entry);
                }
            }
        }
    }
}

console.log(`Parsed ${all.length} <EditorControl/> entries with parameterName`);
console.log(`CONFIG: name="${configName}" version=${configVersion}`);
console.log(`Devices declared: ${devices.map(d => `model=${d.model} fw=${d.majorVersion}.${d.minorVersion}`).join(', ')}`);

// ── Stats ─────────────────────────────────────────────────────────

const byBlock: Record<string, number> = {};
const byBlockUniqueParams: Record<string, Set<string>> = {};
const byBlockVariants: Record<string, Set<string>> = {};
const byBlockGatedRows: Record<string, number> = {};
const byControlType: Record<string, number> = {};

for (const e of all) {
    byBlock[e.block] = (byBlock[e.block] ?? 0) + 1;
    if (!byBlockUniqueParams[e.block]) byBlockUniqueParams[e.block] = new Set();
    byBlockUniqueParams[e.block].add(e.parameterName);
    if (!byBlockVariants[e.block]) byBlockVariants[e.block] = new Set();
    if (e.variant) byBlockVariants[e.block].add(e.variant);
    if (e.controllingParamName) {
        byBlockGatedRows[e.block] = (byBlockGatedRows[e.block] ?? 0) + 1;
    }
    byControlType[e.controlType] = (byControlType[e.controlType] ?? 0) + 1;
}

const totalUniqueParams = new Set(all.map(e => e.parameterName)).size;
const totalGatedRows = all.filter(e => e.controllingParamName).length;

console.log('\nby block (top 20):');
for (const [b, n] of Object.entries(byBlock).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    const u = byBlockUniqueParams[b]?.size ?? 0;
    const v = byBlockVariants[b]?.size ?? 0;
    console.log(`  ${(b || '<no-block>').padEnd(20)} rows=${String(n).padStart(4)}  uniqueParams=${String(u).padStart(4)}  variants=${v}`);
}

console.log('\nby controlType (top 12):');
for (const [t, n] of Object.entries(byControlType).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${(t || '<none>').padEnd(20)} ${n}`);
}

console.log(`\nTotal unique parameterNames: ${totalUniqueParams}`);
console.log(`Total entries with applicability gate: ${totalGatedRows} / ${all.length} (${(100 * totalGatedRows / all.length).toFixed(1)}%)`);

// ── Write the full JSON dump ──────────────────────────────────────

writeFileSync(OUT_JSON, JSON.stringify({
    firmwareSource: 'Axe-Edit.exe (legacy 4.x — Axe-Fx II family editor)',
    config: { name: configName, version: configVersion },
    devices,
    extractedAt: new Date().toISOString(),
    sourceFiles: SOURCES.map(s => s.path),
    totalEntries: all.length,
    totalUniqueParams,
    totalGatedRows,
    entries: all,
}, null, 2));
console.log(`\nWrote ${OUT_JSON}`);

// ── Generate the markdown catalog ─────────────────────────────────

const blockOrder = Object.entries(byBlock)
    .sort((a, b) => b[1] - a[1])
    .map(([b]) => b);

function blockSection(blockName: string): string {
    const entries = all.filter(e => e.block === blockName);
    const uniqueParams = byBlockUniqueParams[blockName] ?? new Set();
    const variants = Array.from(byBlockVariants[blockName] ?? []).sort();
    const variantValues = new Map<string, string>();
    for (const e of entries) {
        if (e.variant && e.variantValue) variantValues.set(e.variant, e.variantValue);
    }
    const gates = new Set(
        entries
            .map(e => e.controllingParamName)
            .filter((g): g is string => g !== undefined && g.length > 0),
    );
    const pages = new Set(entries.map(e => e.page).filter(p => p.length > 0));

    const lines: string[] = [];
    lines.push(`### ${blockName}`);
    lines.push('');
    lines.push(`- Editor rows: **${entries.length}**`);
    lines.push(`- Unique parameter names: **${uniqueParams.size}**`);
    lines.push(`- Variants: ${variants.length === 0 ? '_(none — single-variant block)_' : variants.length}`);
    if (variants.length > 0) {
        const variantList = variants
            .slice(0, 12)
            .map(v => `\`${v}\`${variantValues.has(v) ? ` (=${variantValues.get(v)})` : ''}`)
            .join(', ');
        const more = variants.length > 12 ? ` _(+${variants.length - 12} more)_` : '';
        lines.push(`  - ${variantList}${more}`);
    }
    lines.push(`- Pages observed: ${Array.from(pages).slice(0, 10).map(p => `\`${p}\``).join(', ') || '_(none)_'}`);
    if (gates.size > 0) {
        const gateList = Array.from(gates).slice(0, 8).map(g => `\`${g}\``).join(', ');
        const more = gates.size > 8 ? ` _(+${gates.size - 8} more)_` : '';
        lines.push(`- Applicability gates: ${gateList}${more}`);
    } else {
        lines.push(`- Applicability gates: _(none — every row applies on every variant)_`);
    }
    lines.push('');
    return lines.join('\n');
}

const md = `# Axe-Fx II family component catalog

> **Source.** Extracted from \`Axe-Edit.exe\` (legacy 4.x build) via the
> JUCE BinaryData ZIP shortcut documented in
> \`docs/capture-guides/juce-binarydata-extraction.md\`. The same XML
> file powers Axe-Edit's UI for the entire Axe-Fx II product line —
> three model variants declared in its \`<CONFIG>\` header (per the
> Fractal MIDI SysEx wiki, the wire model bytes are \`0x03\` for
> Axe-Fx II Mark I/II, \`0x06\` for Axe-Fx II XL, and \`0x07\` for
> Axe-Fx II XL+). The catalog below is the union across all three.
> See \`docs/devices/axe-fx-ii/SYSEX-MAP.md\` for the canonical model-
> byte table and the function-ID space.
>
> Generated by \`scripts/extract-axe-fx-ii-catalog.ts\`. Do not edit
> by hand — re-run the script to regenerate after Axe-Edit updates.
>
> Last regenerated: ${new Date().toISOString().slice(0, 10)}.

## Summary

- **CONFIG version:** ${configVersion} (\`${configName}\`)
- **Devices declared in this XML:**
${devices.map(d => `  - model \`${d.model}\` (firmware ${d.majorVersion}.${d.minorVersion})`).join('\n')}
- **Block types:** ${blockOrder.length}
- **Editor rows total:** ${all.length}
- **Unique parameter names:** ${totalUniqueParams}
- **Rows with applicability gates:** ${totalGatedRows} of ${all.length} (${(100 * totalGatedRows / all.length).toFixed(1)}%)

## How to read this catalog

For each block type, the catalog reports:

- **Editor rows** — total \`<EditorControl/>\` entries in Axe-Edit's
  layout XML. A single parameter can produce multiple rows when it's
  shown on more than one variant or page.
- **Unique parameter names** — distinct \`parameterName\` symbols. This
  is the per-block parameter surface Claude will be able to reach.
- **Variants** — Axe-Edit's per-block \`<EffectVariant>\` set. Variants
  are typically the device's per-block "type" enum (e.g. amp model,
  delay algorithm). The \`(=N)\` suffix is the variant's integer enum
  value, used by the type-selector parameter.
- **Pages** — UI tabs Axe-Edit uses for the block. Useful for
  spotting Expert / Mix / Audio / etc. surfaces.
- **Applicability gates** — \`controllingParamName\` set per AM4
  applicability conventions (cf. \`docs/_private/STATE.md\` Session 47
  + \`src/fractal/am4/typeApplicability.ts\`). When non-empty, parts
  of the block's surface only apply when the gate parameter has
  certain values.

## Block-type inventory

${blockOrder.map(blockSection).join('\n')}

## Next-step inputs for protocol implementation

This catalog is the discovery artefact, not the wire-protocol map.
To stand up Axe-Fx II as a verified MCP device per the v0.1.0 scope,
the next inputs are:

1. **Wire-format confirmation.** Axe-Fx II is expected to share the
   Fractal SysEx envelope (\`F0 00 01 74 <model> ...\`) and XOR
   checksum used by AM4. Capture an Axe-Edit ↔ device session via
   USBPcap and confirm. Reference: \`docs/devices/am4/SYSEX-MAP.md\` (AM4)
   and \`docs/capture-guides/\`.
2. **Parameter-ID mapping.** \`parameterName\` symbols above are
   Axe-Edit-internal IDs (e.g. \`DISTORT_DRIVE\`, \`DELAY_TIME\`).
   The wire protocol addresses each by a numeric \`(pidLow, pidHigh)\`
   pair. AM4 derived these from a JUCE-internal cache resolver
   (\`src/fractal/am4/variantResolverTables.ts\`). Likely reusable
   once the equivalent Axe-Edit cache is located.
3. **Block-type enum.** Each \`<EffectVariant value="N">\` integer is
   the device's per-block type enum value (e.g. amp model number).
   These map directly to \`block_type\` enum members in the MCP
   tool surface.
4. **Scenes confirmed = 8.** \`<Page>\`s for scene state are not in
   this XML (scene management is in \`__components.xml\` /
   \`MainPage\`). Confirmed in the device.ts stub from the
   Axe-Fx-II-Scenes-Mini-Manual.

See \`docs/MULTI-DEVICE-ROADMAP.md\` for the v0.1.0 scope plan and
\`src/fractal/axe-fx-ii/device.ts\` for the current stub.
`;

writeFileSync(OUT_MD, md);
console.log(`Wrote ${OUT_MD}`);
