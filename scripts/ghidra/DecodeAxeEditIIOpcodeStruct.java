// DecodeAxeEditIIOpcodeStruct.java — Ghidra GhidraScript
//
// The 475 pointers to SYSEX_* strings are scattered across .rdata, not
// in a contiguous flat table. They're inside STRUCT entries — likely a
// `struct OpcodeDescriptor { fn_byte; name_ptr; handler_ptr; ... }[]`
// array. Each entry has a name pointer plus other fields (opcode byte,
// handler function pointer, maybe payload size).
//
// This script:
//   1. Re-enumerates pointers to SYSEX_* strings in .rdata.
//   2. Computes deltas between consecutive pointer addresses to find
//      the struct stride.
//   3. Dumps the bytes BEFORE and AFTER each pointer (struct context)
//      so we can read off the opcode byte + handler pointer.
//   4. If a stride of 8, 12, 16, 20, or 24 emerges consistently,
//      decode each struct: opcode byte, name, handler.
//   5. Decompile each handler function the table points to.
//
// Output: samples/captured/decoded/ghidra-axeedit2-opcode-struct.txt
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

public class DecodeAxeEditIIOpcodeStruct extends GhidraScript {

    private static final String OUTPUT_PATH =
        "C:\\dev\\mcp-midi-tools\\samples\\captured\\decoded\\ghidra-axeedit2-opcode-struct.txt";

    private static final long POOL_START = 0x00e9e298L;
    private static final long POOL_END   = 0x00ea0000L;

    private final List<String> lines = new ArrayList<>();
    private DecompInterface decomp;
    private FunctionManager funcMgr;
    private Listing listing;
    private Memory mem;
    private AddressSpace as;

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

    private String hex(long val) {
        return String.format("0x%08x", val & 0xFFFFFFFFL);
    }

    private byte[] readBytes(long start, int count) {
        byte[] out = new byte[count];
        try {
            mem.getBytes(as.getAddress(start), out);
        } catch (Exception ignored) {
            return new byte[0];
        }
        return out;
    }

    private String formatBytes(byte[] bytes, int per) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < bytes.length; i++) {
            if (i > 0 && i % per == 0) sb.append(" ");
            sb.append(String.format("%02x", bytes[i] & 0xFF));
        }
        return sb.toString();
    }

    private long readU32LE(long addr) {
        byte[] b = readBytes(addr, 4);
        if (b.length < 4) return -1;
        return ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN).getInt() & 0xFFFFFFFFL;
    }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        funcMgr = program.getFunctionManager();
        listing = program.getListing();
        decomp  = new DecompInterface();
        decomp.openProgram(program);
        as = program.getAddressFactory().getDefaultAddressSpace();
        mem = program.getMemory();

        w("================================================================================");
        w("Axe-Edit II RE — DecodeAxeEditIIOpcodeStruct.java");
        w("  Decode the OpcodeDescriptor struct shape from the 475");
        w("  SYSEX_* string pointers scattered in .rdata.");
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
        w("Pool size: " + stringByAddr.size() + " strings.");
        w("");

        // ── Find pointer locations in initialized non-execute memory ──
        Set<Long> stringSet = stringByAddr.keySet();
        List<long[]> pointerLocs = new ArrayList<>(); // [location, target]
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
            for (int i = 0; i + 4 <= buf.length; i += 4) {
                if (monitor.isCancelled()) break;
                long val = bb.getInt(i) & 0xFFFFFFFFL;
                if (stringSet.contains(val)) {
                    pointerLocs.add(new long[] { blockStart + i, val });
                }
            }
        }
        w(".rdata pointers to SYSEX_* strings: " + pointerLocs.size());
        w("");

        // Sort by location.
        pointerLocs.sort((a, b) -> Long.compare(a[0], b[0]));

        // ── Compute deltas between consecutive pointers ───────────────
        w("################################################################################");
        w("## Pointer-location delta histogram");
        w("################################################################################");
        w("");
        Map<Long, Integer> deltaCounts = new TreeMap<>();
        for (int i = 1; i < pointerLocs.size(); i++) {
            long delta = pointerLocs.get(i)[0] - pointerLocs.get(i - 1)[0];
            deltaCounts.merge(delta, 1, Integer::sum);
        }
        // Show top 10 deltas by count.
        List<Map.Entry<Long, Integer>> deltaRank = new ArrayList<>(deltaCounts.entrySet());
        deltaRank.sort((a, b) -> b.getValue() - a.getValue());
        for (int i = 0; i < Math.min(15, deltaRank.size()); i++) {
            Map.Entry<Long, Integer> e = deltaRank.get(i);
            w(String.format("  delta=%-10d  count=%d", e.getKey(), e.getValue()));
        }
        w("");
        long dominantStride = deltaRank.get(0).getKey();
        w("Dominant stride: " + dominantStride + " bytes");
        w("");

        // ── Find the longest run with the dominant stride ──────────────
        w("################################################################################");
        w("## Largest run with dominant stride " + dominantStride);
        w("################################################################################");
        w("");
        int bestStart = -1, bestLen = 0;
        int curStart = 0, curLen = 1;
        for (int i = 1; i < pointerLocs.size(); i++) {
            long delta = pointerLocs.get(i)[0] - pointerLocs.get(i - 1)[0];
            if (delta == dominantStride) {
                curLen++;
            } else {
                if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
                curStart = i;
                curLen = 1;
            }
        }
        if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }

        if (bestStart < 0 || bestLen < 5) {
            w("No usable run found.");
        } else {
            long firstLoc = pointerLocs.get(bestStart)[0];
            w("Run starts at " + hex(firstLoc) + ", " + bestLen + " entries, stride " + dominantStride);
            // Detect the offset of the name pointer within the struct
            // by reading the bytes BEFORE the first pointer location.
            // Walk back up to `dominantStride` bytes to find the struct
            // header.
            long structStart = firstLoc;
            // Try aligning to the previous stride-multiple boundary.
            // For each candidate alignment in [0..stride-4], check if
            // the run still makes sense.
            w("");
            w("################################################################################");
            w("## Decoded OpcodeDescriptor entries");
            w("################################################################################");
            w("");
            for (int i = 0; i < bestLen; i++) {
                long pLoc = pointerLocs.get(bestStart + i)[0];
                long pTgt = pointerLocs.get(bestStart + i)[1];
                String name = stringByAddr.get(pTgt);
                long entryStart = pLoc - 4; // try -4 to capture preceding opcode byte
                // Try -8 too (opcode + padding before the name pointer).
                // Pick the alignment that gives 0x00 in the high 3 bytes
                // of the first u32 (a 1-byte opcode + 3 pad zeros).
                long u32At_minus4 = readU32LE(pLoc - 4);
                long u32At_minus8 = readU32LE(pLoc - 8);
                String opcodeGuess = "?";
                long opcodeByte = -1;
                if ((u32At_minus4 >> 8) == 0) {
                    opcodeByte = u32At_minus4 & 0xFF;
                    opcodeGuess = String.format("0x%02X (from struct[-4])", opcodeByte);
                } else if ((u32At_minus8 >> 8) == 0) {
                    opcodeByte = u32At_minus8 & 0xFF;
                    opcodeGuess = String.format("0x%02X (from struct[-8])", opcodeByte);
                } else {
                    opcodeGuess = String.format("? (u32[-4]=%s u32[-8]=%s)",
                        hex(u32At_minus4), hex(u32At_minus8));
                }
                // Also read the next field after the name pointer (likely handler ptr).
                long fieldAfter = readU32LE(pLoc + 4);
                // Read full struct (24 bytes back, 24 bytes forward) for inspection.
                byte[] bytes = readBytes(pLoc - 16, 32);
                w(String.format("  [%2d] @ %s  name=%s  opcode=%s  next=%s",
                    i, hex(pLoc), name, opcodeGuess, hex(fieldAfter)));
                w("        struct bytes (pLoc-16..pLoc+16): " + formatBytes(bytes, 4));
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
