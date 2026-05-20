// DumpAxeEditIIOpcodeTable.java — Ghidra GhidraScript
//
// We discovered the OpcodeDescriptor struct shape: 8 bytes,
// `{ const char* name; uint32_t opcode; }`, where the opcode field
// IS THE WIRE FUNCTION BYTE (confirmed: SYSEX_PATCH_START=0x77 matches
// our SYSEX-MAP's PRESET_DUMP_HEADER=0x77). The prior script found one
// 49-entry run starting at 0x00f012c4 (opcodes 0x31-0x63). But there
// are 95 SYSEX_* strings, so the remaining ~46 entries are elsewhere
// — most likely a SECOND table for lower opcodes (0x00-0x2F).
//
// This script dumps ALL runs of stride-8 pointer sequences with
// `{name; opcode}` shape, sorted by location. For each run, it prints
// the (wire byte → opcode name) mapping in a single contiguous table.
//
// Output: samples/captured/decoded/ghidra-axeedit2-opcode-map.txt
//
// @category AxeFxII

import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSpace;
import ghidra.program.model.data.StringDataInstance;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.listing.Program;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryBlock;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.*;

public class DumpAxeEditIIOpcodeTable extends GhidraScript {

    private static final String OUTPUT_PATH =
        "C:\\dev\\mcp-midi-tools\\samples\\captured\\decoded\\ghidra-axeedit2-opcode-map.txt";

    private static final long POOL_START = 0x00e9e298L;
    private static final long POOL_END   = 0x00ea0000L;

    private final List<String> lines = new ArrayList<>();
    private Listing listing;
    private Memory mem;
    private AddressSpace as;

    private void w(String s) {
        lines.add(s);
        println(s);
    }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        listing = program.getListing();
        as = program.getAddressFactory().getDefaultAddressSpace();
        mem = program.getMemory();

        w("================================================================================");
        w("Axe-Edit II RE — DumpAxeEditIIOpcodeTable.java");
        w("  Walk the OpcodeDescriptor struct array(s) and dump every");
        w("  (wire-byte, opcode-name) pair as a single contiguous map.");
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
        w("Pool: " + stringByAddr.size() + " SYSEX_* names.");
        w("");

        // ── Find all .rdata locations that satisfy:
        //   - u32 at loc      = address in stringByAddr (name ptr)
        //   - u32 at loc + 4  = small integer 0..0xFF (wire opcode byte)
        //   - location is 4-byte aligned
        // ─────────────────────────────────────────────────────────────
        Set<Long> stringSet = stringByAddr.keySet();
        // Map<location, [namePtr, opcode]>
        Map<Long, long[]> entries = new TreeMap<>();
        for (MemoryBlock block : mem.getBlocks()) {
            if (!block.isInitialized()) continue;
            if (block.isExecute()) continue;
            long blockStart = block.getStart().getOffset();
            long blockEnd   = block.getEnd().getOffset();
            byte[] buf;
            try {
                buf = new byte[(int) Math.min(blockEnd - blockStart + 1, 0x40000000)];
                mem.getBytes(block.getStart(), buf, 0, buf.length);
            } catch (Exception ignored) {
                continue;
            }
            ByteBuffer bb = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN);
            for (int i = 0; i + 8 <= buf.length; i += 4) {
                if (monitor.isCancelled()) break;
                long namePtr = bb.getInt(i) & 0xFFFFFFFFL;
                long opcode  = bb.getInt(i + 4) & 0xFFFFFFFFL;
                if (!stringSet.contains(namePtr)) continue;
                // Opcode must be 0..0xFF — and high 3 bytes zero.
                if (opcode > 0xFF) continue;
                entries.put(blockStart + i, new long[] { namePtr, opcode });
            }
        }
        w("Total candidate {name, opcode} entries: " + entries.size());
        w("");

        // ── Group into contiguous stride-8 runs ───────────────────────
        List<List<long[]>> runs = new ArrayList<>(); // each run: [loc, namePtr, opcode]
        List<long[]> cur = null;
        Long prev = null;
        for (Map.Entry<Long, long[]> e : entries.entrySet()) {
            long loc = e.getKey();
            long[] vals = e.getValue();
            if (prev == null || loc != prev + 8) {
                if (cur != null && cur.size() >= 3) runs.add(cur);
                cur = new ArrayList<>();
            }
            cur.add(new long[] { loc, vals[0], vals[1] });
            prev = loc;
        }
        if (cur != null && cur.size() >= 3) runs.add(cur);
        runs.sort((a, b) -> b.size() - a.size());

        w("Runs (>= 3 entries, stride 8), sorted by size:");
        for (int i = 0; i < runs.size(); i++) {
            List<long[]> run = runs.get(i);
            String firstName = stringByAddr.get(run.get(0)[1]);
            String lastName  = stringByAddr.get(run.get(run.size() - 1)[1]);
            w(String.format("  [%2d] @ 0x%08x  %d entries  first=%s..last=%s",
                i, run.get(0)[0], run.size(), firstName, lastName));
        }
        w("");

        // ── Print the FULL opcode → name table (sorted by wire byte) ─
        w("################################################################################");
        w("## OPCODE → NAME MAP (sorted by wire function byte)");
        w("################################################################################");
        w("");
        TreeMap<Long, String> opcodeToName = new TreeMap<>();
        for (List<long[]> run : runs) {
            for (long[] entry : run) {
                long opcode = entry[2];
                String name = stringByAddr.get(entry[1]);
                if (opcodeToName.containsKey(opcode) && !opcodeToName.get(opcode).equals(name)) {
                    w(String.format("  WARN: opcode 0x%02X has duplicate names: %s / %s",
                        opcode, opcodeToName.get(opcode), name));
                }
                opcodeToName.put(opcode, name);
            }
        }
        for (Map.Entry<Long, String> e : opcodeToName.entrySet()) {
            w(String.format("  0x%02X  %s", e.getKey(), e.getValue()));
        }
        w("");
        w("Total distinct wire opcodes in map: " + opcodeToName.size());

        // ── Identify opcodes NOT in the table (gaps in 0x00..0x7F) ───
        w("");
        w("################################################################################");
        w("## GAPS (wire bytes 0x00..0x7F with NO opcode descriptor)");
        w("################################################################################");
        w("");
        StringBuilder gaps = new StringBuilder();
        int gapCount = 0;
        for (int b = 0; b <= 0x7F; b++) {
            if (!opcodeToName.containsKey((long) b)) {
                if (gapCount > 0) gaps.append(", ");
                gaps.append(String.format("0x%02X", b));
                gapCount++;
            }
        }
        w("  " + gapCount + " unmapped: " + gaps);

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
