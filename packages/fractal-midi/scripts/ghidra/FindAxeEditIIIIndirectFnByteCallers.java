// FindAxeEditIIIIndirectFnByteCallers.java: Ghidra GhidraScript
//
// BK-054 follow-up. DecodeAxeEditIIINewFnBytes.java (2026-05-22 era) decompiled
// the fn=0x08 / 0x43 / 0xFF emit wrapper functions but reported "no callers"
// for 5 of the 7 (FUN_140150570, FUN_1401c0690, FUN_1401c12f0, FUN_14033b290,
// FUN_14033d040), because it only followed CALL-type references one level up
// (refMgr.getReferencesTo(addr) filtered by isCall()). AM4-Edit's precedent
// (MapAM4EditWorkflowDispatch.java) shows Fractal editors dispatch some
// workflows through a function-pointer TABLE, not a direct CALL instruction;
// a pointer stored in a table shows up as a DATA reference, which the
// isCall() filter silently drops.
//
// This script re-queries the SAME "no callers" functions with the isCall()
// filter REMOVED (every reference type), to test whether they are reached
// via a workflow dispatch table. For every reference found, it dumps the
// containing function/data and a small memory window so an adjacent
// {namePtr, fnPtr} table row (if any) is visible.
//
// It also:
//   - decompiles the two fn=0x00 emit sites that no prior script touched
//     (FUN_1401c15d0, FUN_14033a750; the third fn=0x00 site, FUN_1401f4390,
//     is the shared grid/routing state machine already flagged as an
//     expensive rabbit hole by DecompileAxeEditIIIRoutingComposer.java;
//     deliberately skipped here)
//   - runs the SAME reference-scan technique as a CONTROL against
//     FUN_14014d2a0 (the hardcoded fn=0x77 PRESET_DUMP HEADER builder),
//     whose two real call sites are already known from
//     ghidra-axe-edit-iii-host-emitters-precise.txt (FUN_14014d400 @
//     14014db7d and @ 14014ddf4). If the scan doesn't reproduce exactly
//     those two sites, the technique itself is suspect (stale-pointer
//     control failure).
//
// Output: samples/captured/decoded/ghidra-axe-edit-iii-indirect-fn-callers.txt
//
// @category AxeFxIII

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompiledFunction;
import ghidra.program.model.address.Address;
import ghidra.program.model.data.StringDataInstance;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.listing.Program;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceManager;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class FindAxeEditIIIIndirectFnByteCallers extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axe-edit-iii-indirect-fn-callers.txt";

    // { label, target function addr }: the "no callers" wrappers from
    // ghidra-axe-edit-iii-new-fnbytes-decode.txt.
    private static final String[][] NO_CALLER_TARGETS = {
        { "fn=0x08 site 1", "140150570" },
        { "fn=0x08 site 3", "1401c0690" },
        { "fn=0x08 site 4", "1401c12f0" },
        { "fn=0x08 site 5", "14033b290" },
        { "fn=0x43 site 1", "14033d040" },
    };

    // { label, function addr }: fn=0x00 sites not yet decompiled anywhere.
    // FUN_1401f4390 (the shared routing/grid state machine) intentionally
    // excluded; see header comment.
    private static final String[][] FN00_UNDECOMPILED = {
        { "fn=0x00 site 1", "1401c15d0" },
        { "fn=0x00 site 2", "14033a750" },
    };

    // Control: FUN_14014d2a0, the hardcoded fn=0x77 builder. Known real call
    // sites (from host-emitters-precise.txt): FUN_14014d400 @ 14014db7d and
    // @ 14014ddf4, both direct CALLs, so isCall()-filtered getReferencesTo
    // should ALREADY find them; this is the baseline the broader scan must
    // still reproduce before we trust it on the "no callers" targets above.
    private static final String CONTROL_LABEL = "CONTROL fn=0x77 builder";
    private static final String CONTROL_ADDR = "14014d2a0";
    private static final long[] CONTROL_EXPECTED_CALL_SITES = { 0x14014db7dL, 0x14014ddf4L };

    private final List<String> lines = new ArrayList<>();
    private DecompInterface decomp;
    private FunctionManager funcMgr;
    private Listing listing;
    private ReferenceManager refMgr;
    private Memory mem;

    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        funcMgr = program.getFunctionManager();
        listing = program.getListing();
        refMgr = program.getReferenceManager();
        mem = program.getMemory();
        decomp = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("FindAxeEditIIIIndirectFnByteCallers.java");
        w("  Program:  " + program.getName());
        w("  Output:   " + OUTPUT_PATH);
        w("================================================================================");
        w("");

        // ── Control check first ──────────────────────────────────────────
        w("################################################################################");
        w("## " + CONTROL_LABEL + " (sanity check on the reference-scan technique)");
        w("################################################################################");
        w("");
        w("Expected call sites (from ghidra-axe-edit-iii-host-emitters-precise.txt):");
        for (long e : CONTROL_EXPECTED_CALL_SITES) w("  0x" + Long.toHexString(e));
        w("");
        boolean controlOk = dumpAllReferences(CONTROL_ADDR, CONTROL_EXPECTED_CALL_SITES);
        w("CONTROL VERDICT: " + (controlOk ? "PASS: both expected call sites reproduced, technique trusted"
                                            : "FAIL: expected call sites NOT reproduced, treat results below with suspicion"));
        w("");

        // ── fn=0x00 sites: decompile + reference scan ────────────────────
        w("################################################################################");
        w("## fn=0x00 undecompiled sites (FUN_1401f4390 deliberately skipped)");
        w("################################################################################");
        w("");
        for (String[] site : FN00_UNDECOMPILED) {
            decompileAndDump(site[0], site[1]);
            dumpAllReferences(site[1], null);
            w("");
        }

        // ── "no callers" wrappers: broader reference scan ────────────────
        w("################################################################################");
        w("## Broader (non-isCall-filtered) reference scan on 'no callers' wrappers");
        w("################################################################################");
        w("");
        for (String[] target : NO_CALLER_TARGETS) {
            w("---- " + target[0] + " (FUN_" + target[1] + ") ----");
            dumpAllReferences(target[1], null);
            w("");
        }

        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }

    private void decompileAndDump(String label, String hexAddr) {
        Address addr = addrOf(parseHex(hexAddr));
        Function fn = funcMgr.getFunctionAt(addr);
        w("--- DECOMPILE " + label + ": FUN_" + hexAddr + " ---");
        if (fn == null) {
            w("  (no function at " + addr + ")");
            return;
        }
        w("  signature: " + fn.getSignature());
        String body = decompile(fn);
        for (String l : body.split("\n")) w("  " + l);
        w("");
    }

    /**
     * Dump EVERY reference to the function at hexAddr (no isCall() filter),
     * classified by reference type, with containing function + a small
     * memory window for DATA-type references (to catch adjacent table
     * entries such as a {namePtr, fnPtr} row).
     *
     * Returns true iff expectedCallSites is null, or every address in it
     * appears among the discovered CALL-type reference sources.
     */
    private boolean dumpAllReferences(String hexAddr, long[] expectedCallSites) {
        Address target = addrOf(parseHex(hexAddr));
        Function targetFn = funcMgr.getFunctionAt(target);
        w("  target: FUN_" + hexAddr + " @ " + target
            + (targetFn == null ? "  (no function symbol)" : "  (" + targetFn.getName() + ")"));

        List<Reference> refs = new ArrayList<>();
        for (Reference r : refMgr.getReferencesTo(target)) refs.add(r);

        w("  total references (all types): " + refs.size());
        Set<Long> callSources = new HashSet<>();
        if (refs.isEmpty()) {
            w("  (zero references of ANY type: function may be unreferenced/dead code,");
            w("   or reached only via a computed address this scan can't resolve)");
        }
        for (Reference r : refs) {
            Address from = r.getFromAddress();
            String type = r.getReferenceType().toString();
            boolean isCall = r.getReferenceType().isCall();
            if (isCall) callSources.add(from.getOffset());
            Function containing = funcMgr.getFunctionContaining(from);
            w(String.format("    @ 0x%s  type=%-14s in %s",
                from, type, containing == null ? "(no function / raw data)" : containing.getName() + " @ " + containing.getEntryPoint()));
            if (!isCall) {
                // Likely a data/table reference. Dump a small window and any
                // nearby string, to check for a {namePtr, fnPtr} table row.
                dumpMemoryWindow(from, 24);
                List<String> nearbyStrings = findNearbyStrings(from, 0x40);
                for (String s : nearbyStrings) w("        nearby string: " + s);
            }
        }

        if (expectedCallSites == null) return true;
        boolean ok = true;
        for (long expected : expectedCallSites) {
            if (!callSources.contains(expected)) {
                w("  MISSING expected call site: 0x" + Long.toHexString(expected));
                ok = false;
            }
        }
        return ok;
    }

    private void dumpMemoryWindow(Address center, int radiusBytes) {
        try {
            long start = center.getOffset() - radiusBytes;
            Address startAddr = addrOf(start);
            byte[] buf = new byte[radiusBytes * 2];
            mem.getBytes(startAddr, buf, 0, buf.length);
            StringBuilder sb = new StringBuilder();
            for (byte b : buf) sb.append(String.format("%02x ", b));
            w("        mem[-" + radiusBytes + "..+" + radiusBytes + "]: " + sb.toString().trim());
        } catch (Exception ex) {
            w("        mem window unavailable: " + ex.getMessage());
        }
    }

    private String decompile(Function fn) {
        DecompileResults r = decomp.decompileFunction(fn, 120, monitor);
        if (!r.decompileCompleted()) return "// decompile failed: " + r.getErrorMessage();
        DecompiledFunction dc = r.getDecompiledFunction();
        return dc == null ? "// (no body)" : dc.getC();
    }

    private List<String> findNearbyStrings(Address callAddr, int radius) {
        List<String> hits = new ArrayList<>();
        long callOff = callAddr.getOffset();
        long start = callOff - radius;
        long end = callOff + radius;
        for (long off = start; off <= end; off += 1) {
            Address a = addrOf(off);
            for (Reference r : refMgr.getReferencesFrom(a)) {
                Address to = r.getToAddress();
                Data data = listing.getDataAt(to);
                if (data == null) continue;
                if (!data.hasStringValue()) continue;
                StringDataInstance sdi = StringDataInstance.getStringDataInstance(data);
                if (sdi == null) continue;
                String s = sdi.getStringValue();
                if (s == null || s.length() < 3 || s.length() > 200) continue;
                hits.add(to + ": \"" + s.replace("\n", "\\n") + "\"");
            }
        }
        Set<String> seen = new LinkedHashSet<>(hits);
        return new ArrayList<>(seen);
    }

    private Address addrOf(long off) {
        return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(off);
    }

    private static long parseHex(String s) {
        return Long.parseLong(s, 16);
    }
}
