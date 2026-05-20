// FindAxeEditIIOpcodeHandlers.java — Ghidra GhidraScript
//
// The prior script found 475 4-byte values in memory matching SYSEX_*
// string addresses — but they're SCATTERED across the binary, not in a
// contiguous table. That means each opcode handler has its own direct
// LEA load of the string (for logging / dispatch). Ghidra's auto-
// analyzer didn't tag these as references (32-bit MOV-immediate loads
// from code don't always get connected to data targets).
//
// This script does the lookup manually:
//   1. Build the list of (string_addr, name) pairs for the SYSEX_*
//      pool.
//   2. Walk every initialized memory block — including .text — and
//      find any 4-byte little-endian value equal to a known string
//      address.
//   3. For each match in EXECUTABLE memory, identify the containing
//      function and group hits by function. A function that loads
//      MULTIPLE different SYSEX_* string addresses is a DISPATCHER
//      (logs every opcode it routes). A function that loads ONE string
//      is a HANDLER for that opcode.
//   4. Decompile the dispatcher (the function with the most distinct
//      opcode-name loads) — that's the master jump table for fn 0x18
//      / 0x0E / 0x47 etc.
//
// Output: samples/captured/decoded/ghidra-axeedit2-opcode-handlers.txt
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

import java.io.FileWriter;
import java.io.PrintWriter;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.*;

public class FindAxeEditIIOpcodeHandlers extends GhidraScript {

    private static final String OUTPUT_PATH =
        "C:\\dev\\mcp-midi-tools\\samples\\captured\\decoded\\ghidra-axeedit2-opcode-handlers.txt";

    private static final long POOL_START = 0x00e9e298L;
    private static final long POOL_END   = 0x00ea0000L;

    // Opcode names whose handlers we most want to read for BK-070.
    private static final Set<String> PRIORITY_OPCODES = new HashSet<>(Arrays.asList(
        "SYSEX_QUERY_STATES",      // candidate for fn 0x18 (per-block state poll)
        "SYSEX_GET_ALL_PARAMS",    // bulk per-block param dump
        "SYSEX_GET_GRID",          // grid layout (known to be fn 0x20)
        "SYSEX_PATCH_DUMP",        // preset dump (likely fn 0x77/0x78/0x79 initiator)
        "SYSEX_SET_SCENE",         // scene set (known fn 0x29)
        "SYSEX_RESYNC",            // unknown — likely "resync state to host"
        "SYSEX_PARAM_DUMP",        // single-param dump
        "SYSEX_PARAM_SET",         // single-param set (known fn 0x02)
        "SYSEX_QUERY_VERSION",     // firmware version (known fn 0x08)
        "SYSEX_PATCH_RCV"          // patch receive (preset apply)
    ));

    private final List<String> lines = new ArrayList<>();
    private DecompInterface decomp;
    private FunctionManager funcMgr;
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

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        funcMgr = program.getFunctionManager();
        listing = program.getListing();
        decomp  = new DecompInterface();
        decomp.openProgram(program);
        AddressSpace as = program.getAddressFactory().getDefaultAddressSpace();
        Memory mem = program.getMemory();

        w("================================================================================");
        w("Axe-Edit II RE — FindAxeEditIIOpcodeHandlers.java");
        w("  Find the per-opcode handler functions by manually tracing");
        w("  string-pointer loads in executable memory.");
        w("================================================================================");
        w("");

        // ── Build string-address → name map ─────────────────────────────
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
            stringByAddr.put(d.getAddress().getOffset(), text);
        }
        w("String pool: " + stringByAddr.size() + " SYSEX_* names.");
        w("");

        // ── Scan executable memory for 4-byte values matching ────────
        // a string address. Record (code_addr, target_string_addr).
        List<long[]> codeLoads = new ArrayList<>();
        for (MemoryBlock block : mem.getBlocks()) {
            if (!block.isInitialized()) continue;
            if (!block.isExecute()) continue; // .text only
            long blockStart = block.getStart().getOffset();
            long blockEnd   = block.getEnd().getOffset();
            long span = blockEnd - blockStart + 1;
            byte[] buf;
            try {
                buf = new byte[(int) Math.min(span, 0x40000000)];
                mem.getBytes(block.getStart(), buf, 0, buf.length);
            } catch (Exception ignored) {
                continue;
            }
            ByteBuffer bb = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN);
            // Byte-aligned scan (instructions can put immediate operands
            // on any byte boundary).
            for (int i = 0; i + 4 <= buf.length; i++) {
                if (monitor.isCancelled()) break;
                long val = bb.getInt(i) & 0xFFFFFFFFL;
                if (stringByAddr.containsKey(val)) {
                    codeLoads.add(new long[] { blockStart + i, val });
                }
            }
        }
        w("Code-memory loads of SYSEX_* string addresses: " + codeLoads.size());
        w("");

        // ── Group by containing function ─────────────────────────────
        // For each load site, find the containing function. Build:
        //   funcAddr → Set<targetStringName>
        Map<Long, Set<String>> funcOpcodes = new HashMap<>();
        Map<Long, Function> funcByAddr = new HashMap<>();
        Map<Long, Long> funcLoadCount = new HashMap<>();
        for (long[] hit : codeLoads) {
            if (monitor.isCancelled()) break;
            long codeAddr = hit[0];
            long targetAddr = hit[1];
            Function f = funcMgr.getFunctionContaining(as.getAddress(codeAddr));
            if (f == null) continue;
            long fEntry = f.getEntryPoint().getOffset();
            funcByAddr.put(fEntry, f);
            funcOpcodes.computeIfAbsent(fEntry, k -> new TreeSet<>())
                       .add(stringByAddr.get(targetAddr));
            funcLoadCount.merge(fEntry, 1L, Long::sum);
        }
        w("Functions touching at least one SYSEX_* string: " + funcOpcodes.size());
        w("");

        // ── Rank by # of distinct opcodes ─────────────────────────────
        List<Map.Entry<Long, Set<String>>> ranked = new ArrayList<>(funcOpcodes.entrySet());
        ranked.sort((a, b) -> b.getValue().size() - a.getValue().size());

        w("################################################################################");
        w("## TOP DISPATCHERS — functions loading the most distinct SYSEX_* opcode names");
        w("################################################################################");
        w("");
        int top = Math.min(15, ranked.size());
        for (int i = 0; i < top; i++) {
            Map.Entry<Long, Set<String>> e = ranked.get(i);
            long addr = e.getKey();
            Set<String> ops = e.getValue();
            Function f = funcByAddr.get(addr);
            w(String.format("  [%2d] FUN_%08x  %d opcodes  %d total loads  name=%s",
                i + 1, addr, ops.size(), funcLoadCount.get(addr), f != null ? f.getName() : "?"));
            // Print up to 12 opcode names for context.
            StringBuilder sb = new StringBuilder("        opcodes: ");
            int n = 0;
            for (String op : ops) {
                if (n > 0) sb.append(", ");
                sb.append(op);
                n++;
                if (n >= 12) { sb.append(", ..."); break; }
            }
            w(sb.toString());
        }
        w("");

        // ── Decompile the top dispatcher (likely the master switch) ──
        if (!ranked.isEmpty()) {
            Map.Entry<Long, Set<String>> top1 = ranked.get(0);
            Function f1 = funcByAddr.get(top1.getKey());
            if (f1 != null) {
                w("################################################################################");
                w("## TOP DISPATCHER #1 (full decompile)");
                w("##   " + f1.getName() + " @ " + f1.getEntryPoint());
                w("##   loads " + top1.getValue().size() + " distinct SYSEX_* opcode names");
                w("################################################################################");
                w("");
                w(decompile(f1));
                w("");
            }
        }
        // Second-ranked too (might be a sibling dispatcher: tx-side vs rx-side)
        if (ranked.size() > 1) {
            Map.Entry<Long, Set<String>> top2 = ranked.get(1);
            Function f2 = funcByAddr.get(top2.getKey());
            if (f2 != null && top2.getValue().size() >= 3) {
                w("################################################################################");
                w("## TOP DISPATCHER #2 (full decompile)");
                w("##   " + f2.getName() + " @ " + f2.getEntryPoint());
                w("##   loads " + top2.getValue().size() + " distinct SYSEX_* opcode names");
                w("################################################################################");
                w("");
                w(decompile(f2));
                w("");
            }
        }

        // ── Priority opcode → handler list ────────────────────────────
        w("################################################################################");
        w("## PRIORITY OPCODES → unique handler functions");
        w("##   For each priority opcode, list every function that loads its");
        w("##   string. These are the candidate handlers for the BK-070 wire");
        w("##   path. Decompile the first handler per opcode (when the function");
        w("##   is small enough — < 30 distinct opcodes — so we're not just");
        w("##   re-dumping the dispatcher).");
        w("################################################################################");
        w("");
        for (String opcode : PRIORITY_OPCODES) {
            if (monitor.isCancelled()) break;
            w("──────────────────────────────────────────────────────────────────────────────");
            w("Opcode: " + opcode);
            w("──────────────────────────────────────────────────────────────────────────────");
            // Find string address.
            long stringAddr = -1;
            for (Map.Entry<Long, String> e : stringByAddr.entrySet()) {
                if (e.getValue().equals(opcode)) { stringAddr = e.getKey(); break; }
            }
            if (stringAddr < 0) { w("  string not found"); continue; }
            // Find all functions that load this address.
            List<Function> handlers = new ArrayList<>();
            for (long[] hit : codeLoads) {
                if (hit[1] != stringAddr) continue;
                Function f = funcMgr.getFunctionContaining(as.getAddress(hit[0]));
                if (f == null) continue;
                if (!handlers.contains(f)) handlers.add(f);
            }
            w("  " + handlers.size() + " unique handler functions");
            for (Function h : handlers) {
                int opsInH = funcOpcodes.get(h.getEntryPoint()).size();
                w(String.format("    %s @ %s  (loads %d distinct SYSEX_* names total)",
                    h.getName(), h.getEntryPoint(), opsInH));
            }
            // Decompile the smallest one (probably the actual handler,
            // not the dispatcher).
            handlers.sort((a, b) -> {
                int sa = funcOpcodes.get(a.getEntryPoint()).size();
                int sb = funcOpcodes.get(b.getEntryPoint()).size();
                return sa - sb;
            });
            if (!handlers.isEmpty()) {
                Function smallest = handlers.get(0);
                int opsInSmallest = funcOpcodes.get(smallest.getEntryPoint()).size();
                if (opsInSmallest <= 30) {
                    w("");
                    w("  -- decompile of smallest handler --");
                    String src = decompile(smallest);
                    String[] all = src.split("\\r?\\n");
                    int kept = 0;
                    for (String line : all) {
                        if (kept >= 100) { w("  // ... (truncated)"); break; }
                        w("  " + line);
                        if (!line.trim().isEmpty()) kept++;
                    }
                } else {
                    w("  (skipped decompile — smallest handler has " + opsInSmallest +
                        " distinct opcodes, likely the dispatcher itself)");
                }
            }
            w("");
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
