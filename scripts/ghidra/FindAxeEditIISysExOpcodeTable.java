// FindAxeEditIISysExOpcodeTable.java — Ghidra GhidraScript
//
// The probe found a SYSEX_* string pool at 0x00e9e298..0x00e9ea0c
// containing 95 opcode names (SYSEX_WHO_AM_I, SYSEX_PARAM_SET, ...,
// SYSEX_QUERY_STATES, SYSEX_GET_ALL_PARAMS, SYSEX_GET_GRID, ...).
// These names map 1:1 to AxeEdit's internal opcode enum. There MUST be
// a pointer table `const char* opcode_names[N]` somewhere in .rdata
// that references each string by absolute address.
//
// This script finds that table by:
//   1. Building the list of string addresses in the pool.
//   2. Searching memory for 4-byte sequences equal to each string
//      address (32-bit binary, so pointers are 4 bytes).
//   3. Looking for a CONTIGUOUS block of such pointers — that's the
//      opcode_names[] table. The position in the table = the opcode
//      number.
//   4. Once the table is found, walking xrefs to it identifies the
//      dispatch function that uses `opcode_names[opcode]` for
//      logging or routing.
//   5. Also: for each opcode name's string address, find code that
//      loads the address (via PUSH or MOV-immediate) — those load
//      sites are the per-opcode handlers.
//
// This is the standard trick for finding string-indexed dispatch
// tables in 32-bit Windows binaries.
//
// Output: samples/captured/decoded/ghidra-axeedit2-opcode-table.txt
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
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceManager;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.*;

public class FindAxeEditIISysExOpcodeTable extends GhidraScript {

    private static final String OUTPUT_PATH =
        "C:\\dev\\mcp-midi-tools\\samples\\captured\\decoded\\ghidra-axeedit2-opcode-table.txt";

    // String-pool range from the probe.
    private static final long POOL_START = 0x00e9e298L;
    private static final long POOL_END   = 0x00ea0000L;

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

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        funcMgr = program.getFunctionManager();
        refMgr  = program.getReferenceManager();
        listing = program.getListing();
        decomp  = new DecompInterface();
        decomp.openProgram(program);
        AddressSpace as = program.getAddressFactory().getDefaultAddressSpace();
        Memory mem = program.getMemory();

        w("================================================================================");
        w("Axe-Edit II RE — FindAxeEditIISysExOpcodeTable.java");
        w("  Locate the opcode_names[] pointer table referencing the");
        w("  SYSEX_* string pool at 0x" + Long.toHexString(POOL_START) + ".");
        w("================================================================================");
        w("");

        // ── Pass 1: enumerate string addresses in the pool ─────────────
        List<long[]> stringHits = new ArrayList<>(); // [address, length]
        Map<Long, String> stringByAddr = new TreeMap<>();
        DataIterator dataIter = listing.getDefinedData(as.getAddress(POOL_START), true);
        while (dataIter.hasNext()) {
            if (monitor.isCancelled()) break;
            Data d = dataIter.next();
            if (d.getAddress().getOffset() > POOL_END) break;
            if (!d.hasStringValue()) continue;
            StringDataInstance s = StringDataInstance.getStringDataInstance(d);
            if (s == null) continue;
            String text = s.getStringValue();
            if (text == null || !text.startsWith("SYSEX_")) continue;
            long a = d.getAddress().getOffset();
            stringHits.add(new long[] { a, text.length() });
            stringByAddr.put(a, text);
        }
        w("Found " + stringByAddr.size() + " SYSEX_* strings in pool.");
        w("");

        // ── Pass 2: find every 4-byte location whose value equals a
        //   string address. Look for CONTIGUOUS blocks (the table).
        w("################################################################################");
        w("## PASS 2 — searching for the opcode_names[] pointer table");
        w("################################################################################");
        w("");

        // Search every initialized memory block. For each 4-byte
        // alignment, check if it's a pointer to a string in the pool.
        Map<Long, Long> ptrLocToTargetAddr = new TreeMap<>();
        for (MemoryBlock block : mem.getBlocks()) {
            if (!block.isInitialized()) continue;
            if (block.isExecute()) continue; // we want .rdata, not .text
            long blockStart = block.getStart().getOffset();
            long blockEnd   = block.getEnd().getOffset();
            byte[] buf = new byte[(int) Math.min(blockEnd - blockStart + 1, 0x40000000)];
            try {
                mem.getBytes(block.getStart(), buf, 0, buf.length);
            } catch (Exception ignored) {
                continue;
            }
            ByteBuffer bb = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN);
            for (int i = 0; i + 4 <= buf.length; i += 4) {
                if (monitor.isCancelled()) break;
                long val = bb.getInt(i) & 0xFFFFFFFFL;
                if (stringByAddr.containsKey(val)) {
                    ptrLocToTargetAddr.put(blockStart + i, val);
                }
            }
        }
        w("Found " + ptrLocToTargetAddr.size() + " 4-byte pointers to SYSEX_* strings.");
        w("");

        // Find contiguous runs of pointers (the opcode table).
        Long lastAddr = null;
        List<List<long[]>> runs = new ArrayList<>();
        List<long[]> cur = null;
        for (Map.Entry<Long, Long> e : ptrLocToTargetAddr.entrySet()) {
            long loc = e.getKey();
            long tgt = e.getValue();
            if (lastAddr == null || loc != lastAddr + 4) {
                if (cur != null && cur.size() >= 5) runs.add(cur);
                cur = new ArrayList<>();
            }
            cur.add(new long[] { loc, tgt });
            lastAddr = loc;
        }
        if (cur != null && cur.size() >= 5) runs.add(cur);

        w("Contiguous runs (>= 5 pointers) — these are the candidate tables:");
        for (int ri = 0; ri < runs.size(); ri++) {
            List<long[]> run = runs.get(ri);
            long startAddr = run.get(0)[0];
            long endAddr   = run.get(run.size() - 1)[0] + 4;
            w(String.format("  [%d] 0x%08x..0x%08x  %d entries", ri, startAddr, endAddr, run.size()));
        }
        w("");

        // ── Pass 3: dump the largest run as the opcode → name table ────
        runs.sort((a, b) -> b.size() - a.size());
        if (!runs.isEmpty()) {
            List<long[]> best = runs.get(0);
            w("################################################################################");
            w("## PASS 3 — opcode_names[] table (largest contiguous run, "
                + best.size() + " entries @ 0x" + Long.toHexString(best.get(0)[0]) + ")");
            w("################################################################################");
            w("");
            for (int i = 0; i < best.size(); i++) {
                long loc = best.get(i)[0];
                long tgt = best.get(i)[1];
                String name = stringByAddr.get(tgt);
                w(String.format("  opcode %3d  table[0x%08x] -> 0x%08x  %s", i, loc, tgt, name));
            }
            w("");

            // ── Pass 4: xrefs to the table base ─────────────────────────
            long tableBase = best.get(0)[0];
            w("################################################################################");
            w("## PASS 4 — xrefs to opcode_names[] base (0x"
                + Long.toHexString(tableBase) + ")");
            w("################################################################################");
            w("");
            Set<Address> seenFuncs = new HashSet<>();
            int callerCount = 0;
            for (Reference r : refMgr.getReferencesTo(as.getAddress(tableBase))) {
                Function caller = funcMgr.getFunctionContaining(r.getFromAddress());
                if (caller == null) continue;
                if (seenFuncs.contains(caller.getEntryPoint())) continue;
                seenFuncs.add(caller.getEntryPoint());
                if (callerCount >= 4) {
                    w("  (more callers truncated)");
                    break;
                }
                callerCount++;
                dumpFuncTrimmed("caller " + callerCount, caller, 80);
            }
            if (callerCount == 0) {
                w("  No direct xrefs to the table base. Search for offsets within the table:");
                // Search for xrefs to each table entry's location.
                int found = 0;
                for (int i = 0; i < Math.min(10, best.size()); i++) {
                    long loc = best.get(i)[0];
                    String name = stringByAddr.get(best.get(i)[1]);
                    int xrefs = 0;
                    Function lastCaller = null;
                    for (Reference r : refMgr.getReferencesTo(as.getAddress(loc))) {
                        xrefs++;
                        Function caller = funcMgr.getFunctionContaining(r.getFromAddress());
                        if (caller != null) lastCaller = caller;
                    }
                    if (xrefs > 0) {
                        w(String.format("  opcode %d (%s): %d xrefs, e.g. in %s",
                            i, name, xrefs,
                            lastCaller != null ? lastCaller.getName() + " @ " + lastCaller.getEntryPoint() : "(no fn)"));
                        if (lastCaller != null && found < 2) {
                            dumpFuncTrimmed("opcode-" + i + " caller", lastCaller, 60);
                            found++;
                        }
                    }
                }
            }
        } else {
            w("No contiguous pointer run found — table layout may be different.");
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
