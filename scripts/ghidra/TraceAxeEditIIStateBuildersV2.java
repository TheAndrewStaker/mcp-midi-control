// TraceAxeEditIIStateBuildersV2.java — Ghidra GhidraScript
//
// V1 byte-immediate scan found zero candidates across 20,621 functions.
// AxeEdit II likely builds SysEx envelopes from byte templates in .rdata
// (memcpy'd at runtime) rather than via inline byte writes — so the
// envelope bytes (0xF0, 0xF7, 0x74) never appear as scalar operands in
// instruction streams.
//
// V2 strategy: search the binary's memory directly for byte sequences,
// then walk xrefs to find the code that touches each template.
//
// Two passes:
//
//   PASS A: literal envelope prefix `F0 00 01 74 07` as data. Each match
//           is either a complete envelope template or just the prefix
//           portion of one. For each match, print xrefs (code locations
//           that load the data address) and decompile each xref's
//           containing function.
//
//   PASS B: byte sequences keyed by target fn bytes:
//             F0 00 01 74 07 0E  — preset-blocks-data
//             F0 00 01 74 07 18  — per-block state poll
//             F0 00 01 74 07 47  — init / undocumented
//           Each match is a function-specific template. xrefs land us
//           directly on the per-fn handler.
//
// Output: samples/captured/decoded/ghidra-axeedit2-state-builders-v2.txt
//
// @category AxeFxII

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompiledFunction;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSet;
import ghidra.program.model.address.AddressSetView;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Program;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceManager;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class TraceAxeEditIIStateBuildersV2 extends GhidraScript {

    private static final String OUTPUT_PATH =
        "C:\\dev\\mcp-midi-tools\\samples\\captured\\decoded\\ghidra-axeedit2-state-builders-v2.txt";

    // The Axe-Fx II SysEx envelope prefix. Five bytes is enough to be
    // distinctive (no other Fractal model uses 0x07).
    private static final byte[] ENVELOPE_PREFIX = {
        (byte) 0xF0, 0x00, 0x01, 0x74, 0x07,
    };

    // Per-fn templates — prefix + function byte.
    private static final byte[][] FN_TEMPLATES = {
        // preset-blocks-data
        { (byte) 0xF0, 0x00, 0x01, 0x74, 0x07, 0x0E },
        // per-block state poll
        { (byte) 0xF0, 0x00, 0x01, 0x74, 0x07, 0x18 },
        // init
        { (byte) 0xF0, 0x00, 0x01, 0x74, 0x07, 0x47 },
        // bonus reference points already pinned
        { (byte) 0xF0, 0x00, 0x01, 0x74, 0x07, 0x02 }, // SET_BLOCK_PARAMETER_VALUE
        { (byte) 0xF0, 0x00, 0x01, 0x74, 0x07, 0x20 }, // GET_GRID_LAYOUT
        { (byte) 0xF0, 0x00, 0x01, 0x74, 0x07, 0x77 }, // preset-dump header
    };

    // How many decompiled functions to emit per match group. Higher =
    // more output, longer wall time.
    private static final int DECOMPILE_PER_TEMPLATE = 4;

    private final List<String> lines = new ArrayList<>();
    private DecompInterface decomp;
    private FunctionManager funcMgr;
    private ReferenceManager refMgr;

    private void w(String s) {
        lines.add(s);
        println(s);
    }

    private String decompile(Function f) {
        if (f == null) return "// (no function)";
        DecompileResults r = decomp.decompileFunction(f, 90, monitor);
        if (!r.decompileCompleted()) return "// decompile failed: " + r.getErrorMessage();
        DecompiledFunction dc = r.getDecompiledFunction();
        return dc != null ? dc.getC() : "// (no decompiled function)";
    }

    /**
     * Search every initialized memory block for `needle`. Returns the
     * list of match addresses.
     */
    private List<Address> findBytes(byte[] needle) {
        List<Address> hits = new ArrayList<>();
        Memory mem = currentProgram.getMemory();
        for (MemoryBlock block : mem.getBlocks()) {
            if (!block.isInitialized()) continue;
            Address start = block.getStart();
            Address end = block.getEnd();
            Address scan = start;
            while (scan != null && scan.compareTo(end) <= 0) {
                if (monitor.isCancelled()) return hits;
                Address found = mem.findBytes(scan, end, needle, null, true, monitor);
                if (found == null) break;
                hits.add(found);
                try {
                    scan = found.addNoWrap(1);
                } catch (Exception e) {
                    break;
                }
            }
        }
        return hits;
    }

    /**
     * Get unique containing functions for each xref source pointing at
     * `target`.
     */
    private List<Function> xrefFunctions(Address target) {
        Set<Address> seen = new HashSet<>();
        List<Function> out = new ArrayList<>();
        for (Reference r : refMgr.getReferencesTo(target)) {
            Address from = r.getFromAddress();
            Function f = funcMgr.getFunctionContaining(from);
            if (f == null) continue;
            if (seen.contains(f.getEntryPoint())) continue;
            seen.add(f.getEntryPoint());
            out.add(f);
        }
        return out;
    }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        funcMgr = program.getFunctionManager();
        refMgr  = program.getReferenceManager();
        decomp  = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("Axe-Edit II RE — TraceAxeEditIIStateBuildersV2.java");
        w("  Memory-search for SysEx envelope byte templates in .rdata,");
        w("  follow xrefs to find the code that touches each template.");
        w("================================================================================");
        w("");

        // ── Pass A: envelope prefix `F0 00 01 74 07` ───────────────────
        w("################################################################################");
        w("## PASS A: envelope prefix F0 00 01 74 07 (5 bytes)");
        w("################################################################################");
        w("");
        List<Address> prefixHits = findBytes(ENVELOPE_PREFIX);
        w("Found " + prefixHits.size() + " matches for the 5-byte envelope prefix.");
        w("");

        int prefixDecompiled = 0;
        for (int i = 0; i < prefixHits.size(); i++) {
            if (monitor.isCancelled()) break;
            Address hit = prefixHits.get(i);
            List<Function> callers = xrefFunctions(hit);
            // Read the next byte (likely the function byte) for context.
            int fnByte = -1;
            try {
                fnByte = currentProgram.getMemory().getByte(hit.add(5)) & 0xFF;
            } catch (Exception ignored) {}
            String fnLabel = fnByte >= 0 ? String.format("fn=0x%02X", fnByte) : "fn=?";
            w(String.format("  [%d] 0x%s  %s  xrefs=%d",
                i + 1, hit.toString(), fnLabel, callers.size()));
            // Decompile up to N per-prefix match, but only when there's
            // exactly one or two callers (high-signal cases).
            if (callers.size() > 0 && callers.size() <= 3 && prefixDecompiled < 8) {
                for (Function caller : callers) {
                    if (prefixDecompiled >= 8) break;
                    w("");
                    w("      ----- " + caller.getName() + " @ " + caller.getEntryPoint() + " -----");
                    String src = decompile(caller);
                    String[] all = src.split("\\r?\\n");
                    int kept = 0;
                    for (String line : all) {
                        if (kept >= 60) { w("      // ... (truncated)"); break; }
                        w("      " + line);
                        if (!line.trim().isEmpty()) kept++;
                    }
                    prefixDecompiled++;
                }
            }
        }

        // ── Pass B: per-fn templates ───────────────────────────────────
        w("");
        w("################################################################################");
        w("## PASS B: per-function-byte templates");
        w("################################################################################");
        w("");

        for (byte[] template : FN_TEMPLATES) {
            if (monitor.isCancelled()) break;
            int fn = template[5] & 0xFF;
            w("");
            w("────────────────────────────────────────────────────────────────────────────────");
            w(String.format("Template fn=0x%02X (F0 00 01 74 07 %02X)", fn, fn));
            w("────────────────────────────────────────────────────────────────────────────────");
            List<Address> hits = findBytes(template);
            w("  matches in memory: " + hits.size());
            int decompCount = 0;
            for (Address hit : hits) {
                if (monitor.isCancelled()) break;
                List<Function> callers = xrefFunctions(hit);
                w(String.format("  [match] 0x%s  xrefs=%d", hit.toString(), callers.size()));
                if (decompCount >= DECOMPILE_PER_TEMPLATE) continue;
                for (Function caller : callers) {
                    if (decompCount >= DECOMPILE_PER_TEMPLATE) break;
                    decompCount++;
                    w("");
                    w("    ----- " + caller.getName() + " @ " + caller.getEntryPoint() + " (xref to template) -----");
                    String src = decompile(caller);
                    String[] all = src.split("\\r?\\n");
                    int kept = 0;
                    for (String line : all) {
                        if (kept >= 80) { w("    // ... (truncated)"); break; }
                        w("    " + line);
                        if (!line.trim().isEmpty()) kept++;
                    }
                }
            }
        }

        // ── Write output ──────────────────────────────────────────────
        try (PrintWriter out = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) out.println(l);
        }
        w("");
        w("================================================================================");
        w("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
        w("================================================================================");
    }
}
