// DecompileAM4InboundDumpHandlers.java - Ghidra GhidraScript
//
// Focused follow-up to FindAM4EditPresetParser.java. The first pass
// confirmed AM4-Edit uses a workflow registry (FUN_1402d83d0, same
// pattern as the III `iii-async-workflow-fn-registry` primitive
// entry), but fn-bytes 0x77/0x78/0x79 are NOT in the workflow
// registration table. They're handled by a parallel low-level
// dispatcher.
//
// Candidates from the parser-finder's ranked output that hit 0x77 /
// 0x78 strongly:
//
//   #33 FUN_140462910  [0x77=7]   - strongest 0x77-only signal
//   #37 FUN_14045fc90  [0x77=5]
//   #39 FUN_1404c4f10  [0x77=3]
//   #21 FUN_1402d47f0  [0x78=10, 0x15=1, 0xb=1]
//   #22 FUN_140049c10  [0x78=14]
//   #24 FUN_14035f240  [0x78=12]
//   #2  FUN_1402cf780  [0x78=45]  - already in top-20 decompile
//   #19 FUN_1402d83d0  [workflow registry - already decompiled]
//
// Also pull FUN_140196500 (the workflow-registration helper that
// FUN_1402d83d0 calls per fn-byte registration) so we understand its
// signature.
//
// Output:
//   %PROJECT_ROOT%\samples\captured\decoded\ghidra-am4-edit-inbound-dump-handlers.txt
//
// @category AM4

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompiledFunction;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Program;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceManager;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class DecompileAM4InboundDumpHandlers extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-am4-edit-inbound-dump-handlers.txt";

    private static final long[] TARGETS = {
        0x140462910L, // [0x77=7] - strongest 0x77-only signal
        0x14045fc90L, // [0x77=5]
        0x1404c4f10L, // [0x77=3]
        0x1402d47f0L, // [0x78=10, 0x15=1, 0xb=1]
        0x140049c10L, // [0x78=14]
        0x14035f240L, // [0x78=12]
        0x140196500L, // workflow-registration helper (called by FUN_1402d83d0)
    };

    private final List<String> lines = new ArrayList<>();

    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        FunctionManager funcMgr = program.getFunctionManager();
        ReferenceManager refMgr = program.getReferenceManager();
        DecompInterface decomp = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("DecompileAM4InboundDumpHandlers.java");
        w("  Program: " + program.getName());
        w("  Output:  " + OUTPUT_PATH);
        w("  Targets: " + TARGETS.length + " functions");
        w("================================================================================");
        w("");

        for (long fa : TARGETS) {
            Address ea = addr(fa);
            Function f = funcMgr.getFunctionAt(ea);
            if (f == null) {
                w("(no function at " + hex(fa) + ")");
                w("");
                continue;
            }

            // Count callers (xref-to entries that are CALL flow type).
            int callerCount = 0;
            List<String> callerSamples = new ArrayList<>();
            for (Reference r : refMgr.getReferencesTo(ea)) {
                if (!r.getReferenceType().isCall()) continue;
                callerCount++;
                if (callerSamples.size() < 8) {
                    Function caller = funcMgr.getFunctionContaining(r.getFromAddress());
                    callerSamples.add(
                        (caller == null ? "(no func)" : caller.getName())
                            + " @ " + r.getFromAddress()
                    );
                }
            }

            w("################################################################################");
            w("## " + f.getName() + " @ " + ea);
            w("##   callers: " + callerCount);
            for (String s : callerSamples) w("##     - " + s);
            if (callerCount > callerSamples.size()) {
                w("##     ... + " + (callerCount - callerSamples.size()) + " more");
            }
            w("################################################################################");
            w("");

            DecompileResults r = decomp.decompileFunction(f, 90, monitor);
            if (!r.decompileCompleted()) {
                w("  // decompile failed: " + r.getErrorMessage());
                w("");
                continue;
            }
            DecompiledFunction dc = r.getDecompiledFunction();
            String body = dc == null ? "// (no body)" : dc.getC();
            for (String l : body.split("\n")) w("  " + l);
            w("");
        }

        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }

    private Address addr(long off) {
        return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(off);
    }

    private String hex(long v) { return "0x" + Long.toHexString(v); }
}
