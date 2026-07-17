// SeekVendorEnvelopeDescriptorsAM4.java -- Ghidra GhidraScript
//
// Seeks vendor-envelope descriptor tables in AM4-Edit.exe (64-bit), the
// AM4 analog of the II tables at 0xe04440 + 0xdff900 and the III tables
// at 0x1407ab440 + 0x1407aba40 documented in
// fractal-midi/docs/research/primitives/vendor-envelope-descriptor-table.md.
//
// The primitive entry currently lists AM4 as a transfer candidate ("AM4
// editor binary descriptor tables not yet surveyed"). This script closes
// that gap by direct-pattern-scan of AM4-Edit.exe's data sections for
// the documented `(tag, mid, byte_count)` 12-byte-stride shape
// terminated by a `(-1, -1, -1)` sentinel.
//
// Approach: structural scan over initialized non-executable memory
// blocks. At each 4-byte-aligned address, try to interpret the next
// bytes as a vendor-envelope descriptor table. Accept only if:
//   1. The first entry's tag is 0 (per the primitive's "tag is the
//      per-record key: 0, 1, 2, ...").
//   2. Subsequent tags are monotonically increasing small ints, with
//      a one-step bound (each tag follows previous tag + 0 or + 1).
//   3. All `mid` values fall in [4, 4096] (plausible envelope-byte
//      offsets after the F0 + manufacturer + model + fn prefix).
//   4. All `byte_count` values are positive and below 65536.
//   5. The sentinel `(tag=-1, mid=-1, byte_count=-1)` is hit within
//      MAX_ENTRIES iterations.
//
// Compared to the II call-trace seeker (DumpAxeEditIIChunkDescriptor
// Tables.java) which walked CALL instructions back to recover
// pointer-immediate args, this structural scan does not require
// knowing the parser-function addresses on AM4-Edit. The two
// approaches are complementary; the structural scan is more robust
// against editor-binary version drift but produces more false-positive
// candidates that the heuristics filter out.
//
// Cross-binary applicability: the script's heuristics are generic
// enough that it should also find the known II + III tables when run
// against those binaries. Cross-binary validation is a good way to
// sanity-check this script before trusting its AM4 output as the
// missing AM4 axis for the primitives corpus's matched primitive.
//
// Output:
//   samples/captured/decoded/ghidra-<program>-envelope-descriptors.txt
//   samples/captured/decoded/ghidra-<program>-envelope-descriptors.json
//
// Once committed, run this script through Ghidra against
// AM4-Edit.exe and the output becomes input to a third
// `scripts/primitives-mine.ts` pass that closes the AM4 transfer
// candidate.
//
// @category Fractal

import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSpace;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryBlock;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class SeekVendorEnvelopeDescriptorsAM4 extends GhidraScript {

    private static final String OUT_DIR =
        "samples\\captured\\decoded\\";

    // 12-byte stride: int32 tag + int32 mid + int32 byte_count.
    private static final int STRIDE = 12;

    // Sentinel scan bound. Real tables top out at ~10 entries on II/III;
    // 64 is a comfortable cap that still avoids runaway false-positives.
    private static final int MAX_ENTRIES = 64;

    // Minimum entries to consider a hit a real table. 2 is the floor:
    // a single-entry "table" is statistically too easy to forge from
    // random data.
    private static final int MIN_TABLE_ENTRIES = 2;

    // Plausible envelope-byte offsets. F0 + 3-byte manufacturer + 1-byte
    // model + 1-byte fn = 6 bytes before the first descriptor-named
    // field; cap at 4096 to allow chunked envelopes without admitting
    // garbage pointer-sized values.
    private static final int MIN_MID = 4;
    private static final int MAX_MID = 4096;

    // Plausible byte_count: must be positive; the III preset-body
    // descriptor's byte_count is 3072 (1024 ushorts x 3), so 65536 is
    // a generous upper bound.
    private static final int MIN_BYTE_COUNT = 1;
    private static final int MAX_BYTE_COUNT = 65536;

    // Sanity bound on individual `tag` field. Real tag values are
    // 0..16-ish; 64 admits any plausible enumeration.
    private static final int MAX_TAG = 64;

    private final List<String> txtLines = new ArrayList<>();
    private final List<String> jsonChunks = new ArrayList<>();

    private Memory mem;
    private AddressSpace as;

    private void w(String s) {
        txtLines.add(s);
        println(s);
    }

    private int readIntLE(Address addr) throws Exception {
        byte[] buf = new byte[4];
        mem.getBytes(addr, buf);
        return (buf[0] & 0xff)
            | ((buf[1] & 0xff) << 8)
            | ((buf[2] & 0xff) << 16)
            | ((buf[3] & 0xff) << 24);
    }

    private static class TableHit {
        long startAddr;
        List<int[]> entries = new ArrayList<>();   // each row: [tag, mid, byte_count]
    }

    /**
     * Try to extend a candidate table starting at `seed`. Returns null
     * if the heuristics reject the candidate; otherwise returns the
     * accepted TableHit (sentinel row excluded from the entries list).
     */
    private TableHit extendTable(Address seed) throws Exception {
        TableHit t = new TableHit();
        t.startAddr = seed.getOffset();
        int prevTag = -2;  // -2 sentinel for "no previous tag yet"
        for (int i = 0; i < MAX_ENTRIES; i++) {
            Address entryAddr;
            try {
                entryAddr = seed.add((long) i * STRIDE);
            } catch (Exception e) {
                return null;
            }
            int tag, mid, byteCount;
            try {
                tag = readIntLE(entryAddr);
                mid = readIntLE(entryAddr.add(4));
                byteCount = readIntLE(entryAddr.add(8));
            } catch (Exception e) {
                return null;
            }
            // Sentinel: (-1, -1, -1) terminates the table. Per primitive
            // entry: "terminated by a sentinel record (-1, -1, -1)."
            if (tag == -1 && mid == -1 && byteCount == -1) {
                return t.entries.size() >= MIN_TABLE_ENTRIES ? t : null;
            }
            // First-entry rule: tag must be 0 per the primitive ordering.
            if (i == 0 && tag != 0) return null;
            // Tag plausibility.
            if (tag < 0 || tag > MAX_TAG) return null;
            // Tags must monotonically increase from previous by 0 or 1
            // (some tables repeat a tag for variant-shape rows; allow
            // step of 0 or 1; reject larger jumps that look like noise).
            if (prevTag >= 0 && !(tag == prevTag || tag == prevTag + 1)) {
                return null;
            }
            // Mid plausibility.
            if (mid < MIN_MID || mid > MAX_MID) return null;
            // Byte_count plausibility.
            if (byteCount < MIN_BYTE_COUNT || byteCount > MAX_BYTE_COUNT) return null;
            t.entries.add(new int[]{ tag, mid, byteCount });
            prevTag = tag;
        }
        // Ran out of MAX_ENTRIES without seeing a sentinel; this is
        // almost certainly NOT a real descriptor table. Reject.
        return null;
    }

    @Override
    public void run() throws Exception {
        mem = currentProgram.getMemory();
        as = currentProgram.getAddressFactory().getDefaultAddressSpace();

        // Output file slug derived from program name (mirrors
        // SeekParamTables64.java's convention).
        String progName = currentProgram.getName().toLowerCase();
        String slug = progName
            .replaceAll("\\.exe$", "")
            .replaceAll("[^a-z0-9]+", "");
        String outTxt = OUT_DIR + "ghidra-" + slug + "-envelope-descriptors.txt";
        String outJson = OUT_DIR + "ghidra-" + slug + "-envelope-descriptors.json";

        w("================================================================================");
        w("SeekVendorEnvelopeDescriptorsAM4.java");
        w("  program:    " + currentProgram.getName() + " (out slug: " + slug + ")");
        w("  image base: " + currentProgram.getImageBase());
        w("  stride:     " + STRIDE + " bytes (int32 tag + int32 mid + int32 byte_count)");
        w("  sentinel:   (-1, -1, -1)");
        w("  heuristics: first tag==0, tag step 0..1, mid in [" + MIN_MID + ", " + MAX_MID
            + "], byte_count in [" + MIN_BYTE_COUNT + ", " + MAX_BYTE_COUNT + "]");
        w("================================================================================");

        Map<Long, TableHit> bestByAddr = new LinkedHashMap<>();
        long scanned = 0;
        for (MemoryBlock block : mem.getBlocks()) {
            if (!block.isInitialized()) continue;
            if (block.isExecute()) continue;
            Address start = block.getStart();
            Address end = block.getEnd();
            w("");
            w("## Scanning block " + block.getName() + " [" + start + " - " + end + "]");
            long n = block.getSize();
            for (long off = 0; off <= n - STRIDE; off += 4) {
                if (monitor.isCancelled()) break;
                Address a;
                try {
                    a = start.add(off);
                } catch (Exception e) {
                    continue;
                }
                // Quick prune: read first int; only proceed if it's 0
                // (per first-entry-tag rule). Cuts the inner scan by
                // > 99% on a typical binary.
                int firstTag;
                try {
                    firstTag = readIntLE(a);
                } catch (Exception e) {
                    continue;
                }
                if (firstTag != 0) continue;
                TableHit t = extendTable(a);
                if (t == null) continue;
                TableHit prev = bestByAddr.get(t.startAddr);
                if (prev == null || t.entries.size() > prev.entries.size()) {
                    bestByAddr.put(t.startAddr, t);
                }
                scanned++;
                if (scanned % 100 == 0) {
                    monitor.setMessage("scanned " + scanned + " candidates, "
                        + bestByAddr.size() + " tables found");
                }
            }
        }
        w("");
        w("## Phase 2 -- drop nested subtables");
        List<TableHit> tables = new ArrayList<>(bestByAddr.values());
        tables.sort((a, b) -> Long.compare(a.startAddr, b.startAddr));
        List<TableHit> keep = new ArrayList<>();
        for (TableHit t : tables) {
            boolean nested = false;
            for (TableHit other : keep) {
                long otherEnd = other.startAddr + (long) (other.entries.size() + 1) * STRIDE;
                if (t.startAddr > other.startAddr && t.startAddr < otherEnd) {
                    nested = true;
                    break;
                }
            }
            if (!nested) keep.add(t);
        }
        w("  " + keep.size() + " top-level tables after nesting filter");

        w("");
        w("## Phase 3 -- discovered vendor-envelope descriptor tables");
        keep.sort((a, b) -> Integer.compare(b.entries.size(), a.entries.size()));

        jsonChunks.add("{");
        jsonChunks.add("  \"_source\": \"SeekVendorEnvelopeDescriptorsAM4 direct-scan over " + currentProgram.getName() + "\",");
        jsonChunks.add("  \"_stride\": " + STRIDE + ",");
        jsonChunks.add("  \"_min_table_entries\": " + MIN_TABLE_ENTRIES + ",");
        jsonChunks.add("  \"tables\": [");

        boolean firstTable = true;
        for (TableHit t : keep) {
            w("");
            w("### Table @ 0x" + Long.toHexString(t.startAddr)
                + "  (entries=" + t.entries.size() + ")");
            w("  idx | tag | mid (envelope offset) | byte_count (or units x bytes-per-unit)");
            w("  ----+-----+-----------------------+----------------------------------------");
            for (int i = 0; i < t.entries.size(); i++) {
                int[] e = t.entries.get(i);
                w(String.format("   %2d | %3d | %-21d | %d", i, e[0], e[1], e[2]));
            }
            w(String.format("   -- | -1  | %-21d | %d   <-- SENTINEL", -1, -1));

            if (!firstTable) jsonChunks.add(",");
            firstTable = false;
            jsonChunks.add("    {");
            jsonChunks.add("      \"address\": \"0x" + Long.toHexString(t.startAddr) + "\",");
            jsonChunks.add("      \"entryCount\": " + t.entries.size() + ",");
            StringBuilder entries = new StringBuilder("      \"entries\": [");
            for (int i = 0; i < t.entries.size(); i++) {
                if (i > 0) entries.append(", ");
                int[] e = t.entries.get(i);
                entries.append("{\"tag\":").append(e[0])
                    .append(", \"mid\":").append(e[1])
                    .append(", \"byte_count\":").append(e[2])
                    .append("}");
            }
            entries.append("]");
            jsonChunks.add(entries.toString());
            jsonChunks.add("    }");
        }
        jsonChunks.add("  ],");
        jsonChunks.add("  \"summary\": {");
        jsonChunks.add("    \"tables\": " + keep.size() + ",");
        jsonChunks.add("    \"candidateHits\": " + scanned);
        jsonChunks.add("  }");
        jsonChunks.add("}");

        w("");
        w("## Summary");
        w("  candidate hits:                 " + scanned);
        w("  distinct tables (post-dedupe):  " + bestByAddr.size());
        w("  top-level tables (post-nested): " + keep.size());

        if (keep.isEmpty()) {
            w("");
            w("## Empty-result diagnostic");
            w("No vendor-envelope descriptor tables found. Possible causes:");
            w("  1. AM4-Edit does not ship descriptor tables in this shape");
            w("     (a real possibility -- AM4's editor is simpler than II/III");
            w("     and may inline the envelope spec into the parser code).");
            w("  2. Heuristic thresholds need loosening. Re-run with MAX_TAG,");
            w("     MAX_MID, or MAX_BYTE_COUNT bumped.");
            w("  3. The sentinel shape differs (e.g. 0xFFFFFFFF as unsigned");
            w("     vs. -1 as signed). Currently the script treats both as");
            w("     0xFFFFFFFF in int32 read, so this is unlikely.");
            w("");
            w("If empty after re-tuning, that IS the AM4 finding: register a");
            w("_negative/am4-vendor-envelope-descriptor-table.md primitive entry");
            w("documenting that AM4-Edit doesn't follow the II/III pattern.");
        }

        try (PrintWriter pw = new PrintWriter(new FileWriter(outTxt))) {
            for (String s : txtLines) pw.println(s);
        }
        try (PrintWriter pw = new PrintWriter(new FileWriter(outJson))) {
            for (String s : jsonChunks) pw.println(s);
        }
        println("\nWrote " + txtLines.size() + " lines to " + outTxt);
        println("Wrote JSON to " + outJson);
    }
}
