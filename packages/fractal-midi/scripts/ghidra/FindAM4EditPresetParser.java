// FindAM4EditPresetParser.java - Ghidra GhidraScript
//
// AM4-Edit (64-bit) consumes inbound 0x77/0x78/0x79 preset-dump SysEx
// from the device. The parser that reads the 12,352-byte stream into
// AM4-Edit's preset model is byte-positional: it must know the offset
// of every per-channel param, scene assignment, block-type byte, etc.
// Locating that function unlocks the AM4 preset-binary decode (parser
// side - the encoder side is exhausted; only the header re-stamper
// FUN_1402298f0 exists in AM4-Edit).
//
// Methodological model: this is the AM4 analog of
// FindAxeEditIIPresetParser.java (which used magic-immediate scoring
// to surface the II parser at FUN_0054d0c0 etc.). Same technique,
// AM4-specific constants. See primitive entry
// `_negative/byte-literal-envelope-ghidra-search.md` for why we do NOT
// search the full 5-byte envelope (the model byte 0x15 is loaded at
// runtime from a device-handle struct, not embedded in the emitter).
//
// Two scoring sources:
//   1. AM4 preset-binary magic immediates (fn-bytes, total length,
//      chunk envelope/payload sizes, message sizes).
//   2. Step-5 ground-truth anchor offsets - 22 byte positions in
//      chunk 1 (0x01b0..0x03a5) that moved on an amp-type swap in the
//      2026-05-28 warm-pair-capture probe (see
//      docs/devices/am4/preset-binary-format-research.md §10.10).
//      These will only be hard-coded literals if the parser
//      switch/table-dispatches on them; most likely the parser
//      computes them via (base + record_index * stride) and the search
//      surfaces nothing. But cheap to try.
//
// Output:
//   %PROJECT_ROOT%\samples\captured\decoded\ghidra-am4-edit-preset-parser.txt
//
// @category AM4

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompiledFunction;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.listing.Program;
import ghidra.program.model.scalar.Scalar;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class FindAM4EditPresetParser extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-am4-edit-preset-parser.txt";

    // ── AM4 preset-binary magic immediates ──────────────────────────
    //
    // Total preset on the wire = 12,352 bytes = 0x3040.
    // Per packages/am4/src/presetDump.ts:
    //   header msg = 13 bytes (payload 5)
    //   chunk msg  = 3082 bytes (payload 3074)  4 chunks
    //   footer msg = 11 bytes (payload 3)
    //   PRESET_DUMP_LEN = 13 + 3082*4 + 11 = 12,352
    //
    // 0xC02 (3074, chunk payload) is the rarest of the set - any
    // function touching it almost certainly handles preset-binary
    // chunks.
    //
    // 0x15 (AM4 model byte) is a context-confirmer; the model byte is
    // loaded at runtime from device handle, but emitter sites
    // sometimes carry a literal equality check.
    private static final long[] MAGIC_IMMS = {
        0x77,    // PRESET_DUMP_HEADER fn byte
        0x78,    // PRESET_DUMP_CHUNK fn byte
        0x79,    // PRESET_DUMP_FOOTER fn byte
        12352,   // PRESET_DUMP_LEN
        0x3040,  // PRESET_DUMP_LEN in hex
        3082,    // CHUNK_LEN (envelope-wrapped)
        0xC0A,   // CHUNK_LEN in hex
        3074,    // CHUNK_PAYLOAD_LEN  RAREST
        0xC02,   // CHUNK_PAYLOAD_LEN in hex
        13,      // HEADER_LEN
        0xD,     // HEADER_LEN in hex (also very common, low weight)
        11,      // FOOTER_LEN
        0xB,     // FOOTER_LEN in hex (also very common, low weight)
        4,       // CHUNKS_PER_PRESET (very common, low weight)
        5,       // HEADER_PAYLOAD_LEN (very common, low weight)
        3,       // FOOTER_PAYLOAD_LEN (very common, low weight)
        0x15,    // AM4 model byte
    };

    // ── Step-5 ground-truth anchor offsets (chunk-1 byte positions) ──
    //
    // Per docs/devices/am4/preset-binary-format-research.md §10.10
    // (warm-pair-capture probe 2026-05-28). Step 5 (slot-1 amp-type
    // swap) is the ONE step that produced positions exclusive to that
    // mutation (no other step and no baseline drift touched them).
    // These are the truest signal we have for "the parser writes
    // block-1 descriptor bytes here." Re-derived from
    // samples/captured/am4-warm-pair-diff.json this session.
    //
    // If the parser hard-codes any of these as immediate offsets (e.g.
    // *(buf + 0x01b0)), they will show up here. More likely they are
    // computed (base + i * stride) - in that case this list scores
    // zero, which is itself informative.
    private static final long[] ANCHOR_OFFSETS = {
        0x01b0, 0x0222, 0x025e, 0x027f, 0x0282, 0x0294, 0x0297, 0x02a9,
        0x02bb, 0x02be, 0x02cd, 0x02d0, 0x02e2, 0x02f4, 0x02f7, 0x0309,
        0x031b, 0x031e, 0x0345, 0x036c, 0x0393, 0x03a5,
        0x0120, // chunk-2 anchor (rec[96] in step 5)
    };

    // ── Weights (rare immediates carry the signal) ───────────────────
    private static final Map<Long, Integer> WEIGHTS = new HashMap<>();
    static {
        WEIGHTS.put(0x77L, 1);
        WEIGHTS.put(0x78L, 1);
        WEIGHTS.put(0x79L, 1);
        WEIGHTS.put(12352L, 100);
        WEIGHTS.put(0x3040L, 100);
        WEIGHTS.put(3082L, 50);
        WEIGHTS.put(0xC0AL, 50);
        WEIGHTS.put(3074L, 100);   // RAREST - strongest single signal
        WEIGHTS.put(0xC02L, 100);
        WEIGHTS.put(13L, 0);       // too common to score
        WEIGHTS.put(0xDL, 0);
        WEIGHTS.put(11L, 0);
        WEIGHTS.put(0xBL, 0);
        WEIGHTS.put(4L, 0);
        WEIGHTS.put(5L, 0);
        WEIGHTS.put(3L, 0);
        WEIGHTS.put(0x15L, 5);     // model byte - useful but appears widely
    }

    private static final int MAX_DECOMPILE = 20;

    private final List<String> lines = new ArrayList<>();

    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        Listing listing = program.getListing();
        FunctionManager funcMgr = program.getFunctionManager();
        DecompInterface decomp = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("FindAM4EditPresetParser.java");
        w("  Program:        " + program.getName());
        w("  Output:         " + OUTPUT_PATH);
        w("  Magic imms:     " + Arrays.toString(MAGIC_IMMS));
        w("  Anchor offsets: " + ANCHOR_OFFSETS.length + " positions from step-5 swap diff");
        w("================================================================================");
        w("");

        // ── Walk every instruction, tally immediate hits per function ──
        Map<Address, Map<Long, Integer>> funcToImms = new HashMap<>();
        Map<Address, Set<Long>> funcToAnchors = new HashMap<>();

        Set<Long> immSet = new HashSet<>();
        for (long v : MAGIC_IMMS) immSet.add(v);
        Set<Long> anchorSet = new HashSet<>();
        for (long v : ANCHOR_OFFSETS) anchorSet.add(v);

        InstructionIterator it = listing.getInstructions(true);
        int scanned = 0;
        while (it.hasNext()) {
            Instruction ins = it.next();
            scanned++;
            for (int op = 0; op < ins.getNumOperands(); op++) {
                for (Object o : ins.getOpObjects(op)) {
                    if (!(o instanceof Scalar)) continue;
                    long v = ((Scalar) o).getUnsignedValue();
                    Function f = funcMgr.getFunctionContaining(ins.getAddress());
                    if (f == null) continue;
                    if (immSet.contains(v)) {
                        funcToImms
                            .computeIfAbsent(f.getEntryPoint(), k -> new HashMap<>())
                            .merge(v, 1, Integer::sum);
                    }
                    if (anchorSet.contains(v)) {
                        funcToAnchors
                            .computeIfAbsent(f.getEntryPoint(), k -> new HashSet<>())
                            .add(v);
                    }
                }
            }
        }
        w("Instructions scanned: " + scanned);
        w("Functions touching magic immediates: " + funcToImms.size());
        w("Functions touching anchor offsets:   " + funcToAnchors.size());
        w("");

        // ── Score each function ──────────────────────────────────────
        // base: weighted magic-imm count (rare values dominate)
        // +5 per distinct magic-imm (bonus for breadth)
        // +50 per anchor-offset hit (real ground-truth offsets)
        Map<Address, Integer> funcScores = new HashMap<>();
        Set<Address> allFuncs = new HashSet<>();
        allFuncs.addAll(funcToImms.keySet());
        allFuncs.addAll(funcToAnchors.keySet());
        for (Address fa : allFuncs) {
            int score = 0;
            Map<Long, Integer> imms = funcToImms.getOrDefault(fa, Collections.emptyMap());
            for (var ie : imms.entrySet()) {
                score += WEIGHTS.getOrDefault(ie.getKey(), 0) * ie.getValue();
            }
            score += imms.size() * 5;
            Set<Long> anchors = funcToAnchors.getOrDefault(fa, Collections.emptySet());
            score += anchors.size() * 50;
            funcScores.put(fa, score);
        }

        List<Map.Entry<Address, Integer>> ranked = new ArrayList<>(funcScores.entrySet());
        ranked.sort((a, b) -> Integer.compare(b.getValue(), a.getValue()));

        w("################################################################################");
        w("## TOP 50 - functions ranked by magic-immediate + anchor score");
        w("################################################################################");
        w("");
        for (int i = 0; i < Math.min(50, ranked.size()); i++) {
            var e = ranked.get(i);
            Function f = funcMgr.getFunctionAt(e.getKey());
            String fname = f == null ? "(no func)" : f.getName();
            Map<Long, Integer> imms = funcToImms.getOrDefault(e.getKey(), Collections.emptyMap());
            String immDesc = imms.entrySet().stream()
                .map(x -> String.format("%s=%d", hexImm(x.getKey()), x.getValue()))
                .reduce((a, b) -> a + ", " + b).orElse("(none)");
            Set<Long> anchors = funcToAnchors.getOrDefault(e.getKey(), Collections.emptySet());
            String anchorDesc = anchors.isEmpty()
                ? ""
                : "  anchors=" + anchors.stream()
                    .map(this::hexImm)
                    .sorted()
                    .reduce((a, b) -> a + "," + b).orElse("");
            w(String.format("  %3d. score=%-6d  %s @ %s  [%s]%s",
                i + 1, e.getValue(), fname, e.getKey(), immDesc, anchorDesc));
        }
        w("");

        // ── Decompile top N ──────────────────────────────────────────
        w("################################################################################");
        w("## DECOMPILED TOP " + MAX_DECOMPILE);
        w("################################################################################");
        w("");
        for (int i = 0; i < Math.min(MAX_DECOMPILE, ranked.size()); i++) {
            var e = ranked.get(i);
            Function f = funcMgr.getFunctionAt(e.getKey());
            if (f == null) continue;
            Map<Long, Integer> imms = funcToImms.getOrDefault(e.getKey(), Collections.emptyMap());
            String immDesc = imms.entrySet().stream()
                .map(x -> String.format("%s=%d", hexImm(x.getKey()), x.getValue()))
                .reduce((a, b) -> a + ", " + b).orElse("(none)");
            Set<Long> anchors = funcToAnchors.getOrDefault(e.getKey(), Collections.emptySet());
            String anchorDesc = anchors.isEmpty() ? "" : "  anchors=" + anchors;
            w("--- #" + (i + 1) + ": " + f.getName() + " @ " + e.getKey()
                + "  score=" + e.getValue() + "  imms=[" + immDesc + "]" + anchorDesc + " ---");
            DecompileResults r = decomp.decompileFunction(f, 90, monitor);
            if (!r.decompileCompleted()) {
                w("  // decompile failed: " + r.getErrorMessage());
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

    private String hexImm(long v) { return "0x" + Long.toHexString(v); }
}
