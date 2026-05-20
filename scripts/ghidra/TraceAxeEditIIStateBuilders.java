// TraceAxeEditIIStateBuilders.java — Ghidra GhidraScript
//
// Locate the AxeEdit II (32-bit Axe-Edit.exe) functions that build or
// parse the working-buffer state SysEx envelopes:
//
//   fn 0x0E PRESET_BLOCKS_DATA — wiki-documented "5-byte chunks per
//                                block." Bulk per-block state envelope.
//                                Observed in session-58-direct-sync.syx
//                                (1 frame, ~54-byte payload = ~10 chunks
//                                of 5 bytes = 10 blocks placed when the
//                                capture was taken).
//
//   fn 0x18 (undocumented)     — per-block state poll. Observed × 24 in
//                                session-58-direct-sync.syx, one per
//                                block ID AxeEdit polls during the
//                                "Read from Axe-Fx" handshake. Payload
//                                shape is `[blockId_lo, blockId_hi, ...]`
//                                followed by zero padding. Response
//                                envelope is unknown — likely also 0x18
//                                (bidirectional) or 0x0E.
//
//   fn 0x47 (undocumented)     — init / session-start envelope. Single
//                                frame emitted right after the 0x08
//                                handshake. 8-byte payload, content
//                                varies (capture: 0a 02 3d 01 00 08 04 00).
//                                Likely "begin session" or "describe me
//                                your firmware capabilities" beyond what
//                                0x08 returns.
//
// The strategy is the same one TraceAxeEditIIIMessageBuilders.java used
// on the III binary: identify the generic SysEx envelope builder, then
// walk callers and check the fn byte each caller passes. On II the
// builder hasn't been pinned yet (the III work landed at 64-bit pointers
// — different binary), so this script does both halves: find candidate
// builders, then trace callers.
//
// Algorithm:
//
//   1. Find candidate envelope-construction sites: functions whose
//      instruction stream includes BOTH the byte constants 0xF0 (SysEx
//      start) AND 0xF7 (SysEx end) AND one of {0x0E, 0x18, 0x47} AND
//      0x74 (Fractal manufacturer ID byte 3). On a 32-bit binary these
//      land as MOV-immediate operands or as byte writes to a buffer.
//
//   2. For each candidate, count how many of the target fn bytes
//      appear. A builder that hardcodes fn=0x18 will have ONE of
//      {0x0E, 0x18, 0x47} present; a generic builder will likely have
//      NONE (it takes the fn byte as a function argument).
//
//   3. Print candidates ordered by likelihood + decompile the top N
//      so the operator can see the C-equivalent source.
//
//   4. Cross-reference: walk callers of each candidate, decompile each
//      caller body. Look for the fn byte being passed in.
//
// Output: samples/captured/decoded/ghidra-axeedit2-state-builders.txt
//
// Wall time: ~5-10 min after a full Ghidra auto-analyze pass on
// Axe-Edit.exe (see scripts/ghidra/run-axeedit2-full-analyze.cmd).
// Re-running is idempotent.
//
// Usage:
//   1. Open the ghidra-axe-edit project in Ghidra (already exists per
//      run-axeedit2-full-analyze.cmd — at C:\Users\Steph).
//   2. Ensure Axe-Edit.exe has been fully auto-analyzed.
//   3. Run this script from the Script Manager OR via headless analysis:
//        analyzeHeadless C:\Users\Steph ghidra-axe-edit \
//          -process Axe-Edit.exe \
//          -postScript TraceAxeEditIIStateBuilders.java -noanalysis
//   4. Output lands in samples/captured/decoded/. Send the file path
//      to me in chat after the run finishes.
//
// @category AxeFxII

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompiledFunction;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSetView;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.listing.Program;
import ghidra.program.model.scalar.Scalar;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceManager;
import ghidra.program.model.symbol.SymbolTable;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class TraceAxeEditIIStateBuilders extends GhidraScript {

    private static final String OUTPUT_PATH =
        "C:\\dev\\mcp-midi-tools\\samples\\captured\\decoded\\ghidra-axeedit2-state-builders.txt";

    // Fractal envelope marker bytes — every SysEx envelope construction
    // site touches these.
    private static final int BYTE_SYSEX_START = 0xF0;
    private static final int BYTE_SYSEX_END   = 0xF7;
    private static final int BYTE_MFR_2       = 0x74; // 0x00 0x01 0x74

    // Function bytes we care about. ORDER matters — fn 0x18 is the
    // most common (per-block state poll), fn 0x0E is the bulk response,
    // fn 0x47 is the init frame.
    private static final int[] TARGET_FNS = { 0x18, 0x0E, 0x47 };

    // Top-N candidates to decompile (each decompile is ~1s of work).
    private static final int DECOMPILE_TOP_N = 8;

    // Caller decompile cap — keep total wall time bounded.
    private static final int MAX_CALLERS_TO_DECOMPILE = 20;

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

    /**
     * Walk every instruction in `func` and collect any 1-byte scalar
     * operands (or byte-sized writes) that equal one of the bytes we
     * care about. Returns a map from byte value → occurrence count.
     */
    private Map<Integer, Integer> scanByteImmediates(Function func) {
        Map<Integer, Integer> counts = new HashMap<>();
        if (func == null) return counts;
        AddressSetView body = func.getBody();
        InstructionIterator iter = listing.getInstructions(body, true);
        while (iter.hasNext()) {
            if (monitor.isCancelled()) break;
            Instruction insn = iter.next();
            int nOps = insn.getNumOperands();
            for (int op = 0; op < nOps; op++) {
                Object[] objs = insn.getOpObjects(op);
                for (Object o : objs) {
                    if (!(o instanceof Scalar)) continue;
                    Scalar s = (Scalar) o;
                    long v = s.getUnsignedValue();
                    if (v < 0 || v > 0xFF) continue;
                    int b = (int) v;
                    if (b == BYTE_SYSEX_START || b == BYTE_SYSEX_END || b == BYTE_MFR_2
                        || b == 0x0E || b == 0x18 || b == 0x47) {
                        counts.merge(b, 1, Integer::sum);
                    }
                }
            }
        }
        return counts;
    }

    /**
     * Score a function as a SysEx envelope construction candidate.
     * Higher score = more likely. Requires presence of all three
     * envelope markers (F0, F7, 0x74) plus at least one target fn byte.
     */
    private static int scoreCandidate(Map<Integer, Integer> counts) {
        if (counts.getOrDefault(BYTE_SYSEX_START, 0) == 0) return 0;
        if (counts.getOrDefault(BYTE_SYSEX_END, 0) == 0) return 0;
        if (counts.getOrDefault(BYTE_MFR_2, 0) == 0) return 0;
        int targetHits = 0;
        for (int fn : TARGET_FNS) {
            if (counts.getOrDefault(fn, 0) > 0) targetHits++;
        }
        if (targetHits == 0) return 0;
        // Base score: presence of envelope. Bonus per target fn byte.
        int score = 10;
        score += targetHits * 5;
        // Penalty for "too many" — these may be tables / dispatchers,
        // not single-message builders.
        int total = counts.values().stream().mapToInt(Integer::intValue).sum();
        if (total > 200) score -= 5;
        return score;
    }

    /**
     * Which target fn bytes are referenced inside the function?
     */
    private static List<Integer> presentTargets(Map<Integer, Integer> counts) {
        List<Integer> hits = new ArrayList<>();
        for (int fn : TARGET_FNS) {
            if (counts.getOrDefault(fn, 0) > 0) hits.add(fn);
        }
        return hits;
    }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        funcMgr = program.getFunctionManager();
        refMgr  = program.getReferenceManager();
        listing = program.getListing();
        decomp  = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("Axe-Edit II RE — TraceAxeEditIIStateBuilders.java");
        w("  Locate fn 0x0E / 0x18 / 0x47 working-buffer state envelope");
        w("  builders + parsers in Axe-Edit.exe (32-bit AxeEdit II).");
        w("================================================================================");
        w("");

        // ── Phase 1: scan every function for envelope markers ─────────
        List<long[]> scored = new ArrayList<>();
        Map<Long, Map<Integer, Integer>> countsByFunc = new HashMap<>();
        int totalScanned = 0;
        for (Function f : funcMgr.getFunctions(true)) {
            if (monitor.isCancelled()) break;
            totalScanned++;
            Map<Integer, Integer> counts = scanByteImmediates(f);
            int score = scoreCandidate(counts);
            if (score > 0) {
                long addr = f.getEntryPoint().getOffset();
                scored.add(new long[] { addr, score });
                countsByFunc.put(addr, counts);
            }
        }
        scored.sort((a, b) -> Long.compare(b[1], a[1]));

        w("Scanned " + totalScanned + " functions, found " + scored.size() + " envelope-marker candidates.");
        w("");

        // ── Phase 2: print + decompile top candidates ──────────────────
        w("################################################################################");
        w("## TOP " + Math.min(DECOMPILE_TOP_N, scored.size()) + " CANDIDATES (highest score first)");
        w("################################################################################");
        for (int i = 0; i < Math.min(DECOMPILE_TOP_N, scored.size()); i++) {
            long addr = scored.get(i)[0];
            long score = scored.get(i)[1];
            Function f = funcMgr.getFunctionAt(program.getAddressFactory().getDefaultAddressSpace().getAddress(addr));
            if (f == null) continue;
            Map<Integer, Integer> cnt = countsByFunc.get(addr);
            List<Integer> targets = presentTargets(cnt);
            w("");
            w("────────────────────────────────────────────────────────────────────────────────");
            w(String.format("[%d/%d] %s @ 0x%s  score=%d  targets=%s  envelope_markers=F0:%d F7:%d 0x74:%d",
                i + 1, Math.min(DECOMPILE_TOP_N, scored.size()),
                f.getName(),
                Long.toHexString(addr),
                score,
                targetsLabel(targets),
                cnt.getOrDefault(BYTE_SYSEX_START, 0),
                cnt.getOrDefault(BYTE_SYSEX_END, 0),
                cnt.getOrDefault(BYTE_MFR_2, 0)
            ));
            w("────────────────────────────────────────────────────────────────────────────────");
            String src = decompile(f);
            w(src);
        }

        // ── Phase 3: callers of the top candidates ────────────────────
        w("");
        w("################################################################################");
        w("## CALLER TRACE (top candidates)");
        w("##   Walks the call graph 1 hop up and decompiles each caller.");
        w("##   Useful for identifying which UI events trigger each envelope.");
        w("################################################################################");
        int callerCount = 0;
        for (int i = 0; i < Math.min(DECOMPILE_TOP_N, scored.size()) && callerCount < MAX_CALLERS_TO_DECOMPILE; i++) {
            long addr = scored.get(i)[0];
            Address a = program.getAddressFactory().getDefaultAddressSpace().getAddress(addr);
            Function callee = funcMgr.getFunctionAt(a);
            if (callee == null) continue;
            Set<Address> seenCallers = new HashSet<>();
            Iterator<Reference> it = refMgr.getReferencesTo(a).iterator();
            List<Function> callers = new ArrayList<>();
            while (it.hasNext()) {
                Reference r = it.next();
                Address from = r.getFromAddress();
                Function caller = funcMgr.getFunctionContaining(from);
                if (caller == null) continue;
                if (seenCallers.contains(caller.getEntryPoint())) continue;
                seenCallers.add(caller.getEntryPoint());
                callers.add(caller);
            }
            if (callers.isEmpty()) continue;
            w("");
            w(">>> Callers of " + callee.getName() + " @ 0x" + Long.toHexString(addr) + " (" + callers.size() + " unique)");
            for (Function caller : callers) {
                if (callerCount >= MAX_CALLERS_TO_DECOMPILE) break;
                callerCount++;
                w("");
                w("    ----- " + caller.getName() + " @ " + caller.getEntryPoint() + " -----");
                String src = decompile(caller);
                // Trim to first 50 non-blank lines to keep output bounded.
                String[] all = src.split("\\r?\\n");
                int kept = 0;
                for (String line : all) {
                    if (kept >= 50) { w("    // ... (truncated, see Ghidra UI for full body)"); break; }
                    w("    " + line);
                    if (!line.trim().isEmpty()) kept++;
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

    private static String targetsLabel(List<Integer> targets) {
        if (targets.isEmpty()) return "(none — generic builder?)";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < targets.size(); i++) {
            if (i > 0) sb.append(",");
            sb.append(String.format("0x%02X", targets.get(i)));
        }
        return sb.toString();
    }
}
