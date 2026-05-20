// DumpAxeEditIISysExCore.java — Ghidra GhidraScript
//
// The diagnostic probe (ProbeAxeEditIISysEx.java) located the SysEx
// core inside Axe-Edit.exe. This script decompiles the targeted
// functions + walks their callers so we can read the C-equivalent of
// each working-buffer wire path:
//
//   1. FUN_00421cd0 + FUN_00422580 — functions that contain BOTH 0xF0
//      and 0xF7 as scalar immediates. Envelope start/end assemblers.
//
//   2. FUN_0041e940 — the midi-write wrapper. Calls midiOutShortMsg AND
//      midiOutLongMsg. Every SysEx sender is upstream.
//
//   3. SYSEX_* opcode-name strings under 0x00e9e000-0x00ea0000. The
//      probe found 96 hits. These are AxeEdit's protocol opcode labels
//      (SYSEX_PARAM_SET, SYSEX_PATCH_DUMP, SYSEX_SET_SCENE, etc.). For
//      each string, follow xrefs to find the dispatch table or
//      builder that uses it.
//
//   4. scene_get_parameters / scene_set_parameters / scene_set_xy
//      symbols at 0x00716c80+. These look like debug-name strings; if
//      they sit in a function-name table or get logged on entry, the
//      xref leads us to the function body.
//
// Output: samples/captured/decoded/ghidra-axeedit2-sysex-core.txt
//
// @category AxeFxII

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompiledFunction;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSpace;
import ghidra.program.model.data.StringDataInstance;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.listing.Program;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceManager;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class DumpAxeEditIISysExCore extends GhidraScript {

    private static final String OUTPUT_PATH =
        "C:\\dev\\mcp-midi-tools\\samples\\captured\\decoded\\ghidra-axeedit2-sysex-core.txt";

    private static final long[] TARGET_FUNCS = {
        0x00421cd0L, // both 0xF0 and 0xF7 — envelope assembler candidate
        0x00422580L, // both 0xF0 and 0xF7 — envelope assembler candidate
        0x0041e940L, // midi-write wrapper (calls midiOutShortMsg + midiOutLongMsg)
        0x00420da0L, // midi-write wrapper (calls midiOutMessage)
    };

    // Strings whose xrefs lead to the SysEx senders / scene helpers.
    private static final String[] STRING_NEEDLES = {
        "scene_get_parameters",
        "scene_set_parameters",
        "scene_set_xy",
        "scene_change",
        "get_current_scene_num",
        "SYSEX_PARAM_SET",
        "SYSEX_PARAM_DUMP",
        "SYSEX_PATCH_RCV",
        "SYSEX_PATCH_DUMP",
        "SYSEX_SET_SCENE",
        "SYSEX_WHO_AM_I",
    };

    // Whole address range where SYSEX_* opcode-name strings live (per
    // the probe). Walking this range and dumping each string + xref
    // gives us the protocol opcode table.
    private static final long SYSEX_STRING_RANGE_START = 0x00e9e000L;
    private static final long SYSEX_STRING_RANGE_END   = 0x00ea0000L;

    private final List<String> lines = new ArrayList<>();
    private DecompInterface decomp;
    private FunctionManager funcMgr;
    private ReferenceManager refMgr;
    private Listing listing;

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

    private void dumpFunc(String label, Function f) {
        w("");
        w("################################################################################");
        w("# " + label);
        if (f != null) {
            w("# " + f.getName() + " @ " + f.getEntryPoint() + "  sig: " + f.getSignature());
        }
        w("################################################################################");
        if (f == null) {
            w("// FUNCTION NOT FOUND");
            return;
        }
        w(decompile(f));
    }

    private void dumpFuncTrimmed(String label, Function f, int maxLines) {
        w("");
        w("    ----- " + label + " — " + f.getName() + " @ " + f.getEntryPoint() + " -----");
        String src = decompile(f);
        String[] all = src.split("\\r?\\n");
        int kept = 0;
        for (String line : all) {
            if (kept >= maxLines) { w("    // ... (truncated)"); break; }
            w("    " + line);
            if (!line.trim().isEmpty()) kept++;
        }
    }

    private List<Function> uniqueCallersOf(Address a) {
        Set<Address> seen = new HashSet<>();
        List<Function> out = new ArrayList<>();
        for (Reference r : refMgr.getReferencesTo(a)) {
            Address from = r.getFromAddress();
            Function caller = funcMgr.getFunctionContaining(from);
            if (caller == null) continue;
            if (seen.contains(caller.getEntryPoint())) continue;
            seen.add(caller.getEntryPoint());
            out.add(caller);
        }
        return out;
    }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        funcMgr = program.getFunctionManager();
        refMgr  = program.getReferenceManager();
        listing = program.getListing();
        decomp  = new DecompInterface();
        decomp.openProgram(program);
        AddressSpace as = program.getAddressFactory().getDefaultAddressSpace();

        w("================================================================================");
        w("Axe-Edit II RE — DumpAxeEditIISysExCore.java");
        w("  Decompile the SysEx core located by the diagnostic probe.");
        w("================================================================================");

        // ── Section 1: targeted function decompiles ────────────────────
        w("");
        w("################################################################################");
        w("## SECTION 1 — TARGETED FUNCTION DECOMPILES");
        w("################################################################################");
        for (long addr : TARGET_FUNCS) {
            if (monitor.isCancelled()) break;
            Function f = funcMgr.getFunctionAt(as.getAddress(addr));
            dumpFunc("Target FUN_" + String.format("%08x", addr), f);
        }

        // ── Section 2: callers of the midi-write wrappers ──────────────
        w("");
        w("################################################################################");
        w("## SECTION 2 — CALLERS OF MIDI-WRITE WRAPPERS");
        w("##   FUN_0041e940 (midiOutShortMsg + midiOutLongMsg)");
        w("##   FUN_00420da0 (midiOutMessage)");
        w("##");
        w("##   Every SysEx-sending code path lives upstream of one of these.");
        w("################################################################################");
        for (long addr : new long[] { 0x0041e940L, 0x00420da0L }) {
            Function wrapper = funcMgr.getFunctionAt(as.getAddress(addr));
            if (wrapper == null) continue;
            w("");
            w(">>> Callers of FUN_" + String.format("%08x", addr) + " (" + wrapper.getName() + ")");
            List<Function> callers = uniqueCallersOf(wrapper.getEntryPoint());
            w("    " + callers.size() + " unique callers");
            int max = Math.min(callers.size(), 12);
            for (int i = 0; i < max; i++) {
                if (monitor.isCancelled()) break;
                dumpFuncTrimmed("caller " + (i + 1) + "/" + max, callers.get(i), 60);
            }
        }

        // ── Section 3: SYSEX_* string xrefs ────────────────────────────
        w("");
        w("################################################################################");
        w("## SECTION 3 — SYSEX_* OPCODE STRING TABLE (range " +
            String.format("0x%08x..0x%08x", SYSEX_STRING_RANGE_START, SYSEX_STRING_RANGE_END) + ")");
        w("################################################################################");
        DataIterator dataIter = listing.getDefinedData(as.getAddress(SYSEX_STRING_RANGE_START), true);
        int count = 0;
        while (dataIter.hasNext()) {
            if (monitor.isCancelled()) break;
            Data d = dataIter.next();
            if (d.getAddress().getOffset() > SYSEX_STRING_RANGE_END) break;
            if (!d.hasStringValue()) continue;
            StringDataInstance s = StringDataInstance.getStringDataInstance(d);
            if (s == null) continue;
            String text = s.getStringValue();
            if (text == null || !text.startsWith("SYSEX_")) continue;
            count++;
            // List xrefs (where in the code this string is referenced).
            int xrefs = 0;
            List<Address> xrefSites = new ArrayList<>();
            for (Reference r : refMgr.getReferencesTo(d.getAddress())) {
                xrefs++;
                xrefSites.add(r.getFromAddress());
            }
            w(String.format("  [%d] 0x%s  '%s'  xrefs=%d  (first 3: %s)",
                count, d.getAddress().toString(), text, xrefs,
                xrefSites.subList(0, Math.min(3, xrefSites.size())).toString()));
        }
        w("");
        w("  Total SYSEX_* opcode strings: " + count);

        // ── Section 4: specific-name string xrefs ──────────────────────
        w("");
        w("################################################################################");
        w("## SECTION 4 — SPECIFIC STRING XREFS");
        w("##   For each needle, find the string in .rdata and decompile the");
        w("##   first 2 functions that reference it.");
        w("################################################################################");
        for (String needle : STRING_NEEDLES) {
            if (monitor.isCancelled()) break;
            // Walk defined strings to find this exact text.
            DataIterator iter = listing.getDefinedData(true);
            Address strAddr = null;
            int looked = 0;
            while (iter.hasNext()) {
                if (looked > 200000) break;
                looked++;
                Data d = iter.next();
                if (!d.hasStringValue()) continue;
                StringDataInstance s = StringDataInstance.getStringDataInstance(d);
                if (s == null) continue;
                String text = s.getStringValue();
                if (text != null && text.equals(needle)) {
                    strAddr = d.getAddress();
                    break;
                }
            }
            w("");
            w("──────────────────────────────────────────────────────────────────────────────");
            w("Needle: '" + needle + "'");
            w("──────────────────────────────────────────────────────────────────────────────");
            if (strAddr == null) {
                w("  string not found");
                continue;
            }
            w("  string at 0x" + strAddr);
            List<Function> callers = uniqueCallersOf(strAddr);
            w("  " + callers.size() + " referencing functions");
            int max = Math.min(callers.size(), 2);
            for (int i = 0; i < max; i++) {
                dumpFuncTrimmed("xref " + (i + 1) + "/" + max, callers.get(i), 80);
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
