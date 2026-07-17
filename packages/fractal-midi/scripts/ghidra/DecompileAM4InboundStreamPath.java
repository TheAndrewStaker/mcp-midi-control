// DecompileAM4InboundStreamPath.java - Ghidra GhidraScript
//
// HOP 3 of the AM4-Edit parser-side decode arc. HOP 2 ruled out all
// 13 candidate vtable slots as the chunk-1 SysEx-binary parser and
// pinned the inbound message dispatcher at `FUN_1402ddb80`
// (AM4DeviceManager::vftable slot 4). HOP 3 walks downstream from
// that dispatcher to find the actual chunk-1 parser.
//
// Cross-device note: Axe-Fx III's own preset-binary inner per-param
// layout is ALSO unsolved (see packages/fractal-gen3/src/presetDump.ts
// L47 — "treats chunk payloads as opaque blobs"). The outer envelope
// descriptor tables ARE shared cross-device (AM4 0x1405dcf40 vs III
// 0x1407ab940, both byte-identical 3072-byte payload shape per
// primitive [[vendor-envelope-descriptor-table]]) but the INNER
// per-param byte positions are novel work for both devices. So no
// direct lift from III is available; this HOP must derive the layout
// from AM4-Edit's parser code.
//
// Hypothesis A: FUN_1402da830 is the AM4 analog of III's
//   FUN_1401f4390 workflow state-machine executor (primitive
//   [[iii-workflow-state-machine-executor]] matched-singleton, AM4
//   axis pending). It's reached from FUN_1402ddb80's `cVar5 == 0x01`
//   branch (the stream-end / fn=0x01 ack handler). If it switches on
//   workflow state with a case that consumes the accumulated
//   0x77/0x78/0x79 buffer and writes to AM4-Edit's preset model
//   struct at the 22 anchor byte offsets, that's the parser.
//
// Hypothesis B: FUN_1401ce9b0 returns status code 3 ("other") for
//   intermediate stream frames; the actual chunk accumulation happens
//   in the receive callback that fills the message queue at
//   `param_1 + 0x148`. The parser would be downstream of that
//   accumulator, not in the dispatcher's per-message switch.
//
// Targets:
//   Tier 1 (direct dispatcher first-level callees from
//     FUN_1402ddb80's switch + status check):
//     FUN_1401ce9b0  - status classifier (Hypothesis B anchor)
//     FUN_1402da830  - cVar5==0x01 stream-end handler (Hypothesis A anchor)
//     FUN_1402dd9e0  - cVar5==0x00 stream-start handler
//     FUN_1401d59f0  - cVar5==0x03 version-reply handler
//     FUN_1401d4c70  - cVar5==0x19 cabinet-names handler
//     FUN_1401d2a20  - cVar5==0x47 unknown handler
//     FUN_1401da990  - cVar5==0x08 library-load handler
//     FUN_14033a1e0  - called pre-handler in cVar5==0x08 path
//
//   Tier 2 (size readers / allocators referenced by Tier 1):
//     FUN_140114974  - allocator (size-arg-based)
//     FUN_1401ce900  - returns longlong from message object
//     FUN_140157c90  - called from AMDM vtable slot 8 + DMSM
//
// For each: decompile + score against the 22 chunk-1 anchor byte
// offsets (decompile-text + instruction-scalar), stride hints
// (0x3/0x12/0x27), buffer-read patterns, and negative signals (JUCE
// UI / persistence / RNG / settings). Verdict per function. Modeled
// on the HOP 2 script DecompileAndClassifyDMSMSlots.java.
//
// Output:
//   %PROJECT_ROOT%\samples\captured\decoded\
//     ghidra-am4-edit-inbound-stream-path.txt
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
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceManager;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class DecompileAM4InboundStreamPath extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-am4-edit-inbound-stream-path.txt";

    // Same anchor set as HOP 2 — the 22 chunk-1 byte positions from
    // step-5 amp-type-swap exclusive recs (rec_id * 3, septet-packed
    // 14-bit per primitive septet-14bit) + 1 chunk-2-exclusive position.
    private static final long[] ANCHOR_CHUNK1 = {
        0x01b0L, 0x0222L, 0x025eL, 0x027fL, 0x0282L, 0x0294L, 0x0297L,
        0x02a9L, 0x02bbL, 0x02beL, 0x02cdL, 0x02d0L, 0x02e2L, 0x02f4L,
        0x02f7L, 0x0309L, 0x031bL, 0x031eL, 0x0345L, 0x036cL, 0x0393L,
        0x03a5L
    };
    private static final long ANCHOR_CHUNK2_ONLY = 0x0120L;

    private static final long[] STRIDE_HINTS = { 0x03L, 0x12L, 0x27L };

    // Targets: (tier, role, address). Tier 1 = direct dispatcher
    // callees. Tier 2 = supporting size-readers / allocators.
    private static final Object[][] TARGETS = {
        // ── Tier 1 ──────────────────────────────────────────────
        new Object[] { 1, "status_classifier (Hyp B anchor)",        0x1401ce9b0L },
        new Object[] { 1, "cVar5==0x01 stream-end (Hyp A anchor)",   0x1402da830L },
        new Object[] { 1, "cVar5==0x00 stream-start",                0x1402dd9e0L },
        new Object[] { 1, "cVar5==0x03 version-reply",               0x1401d59f0L },
        new Object[] { 1, "cVar5==0x19 cabinet-names",               0x1401d4c70L },
        new Object[] { 1, "cVar5==0x47 unknown",                     0x1401d2a20L },
        new Object[] { 1, "cVar5==0x08 library-load",                0x1401da990L },
        new Object[] { 1, "pre-handler (cVar5==0x08 path)",          0x14033a1e0L },
        // ── Tier 2 ──────────────────────────────────────────────
        new Object[] { 2, "allocator (size-based)",                  0x140114974L },
        new Object[] { 2, "msg-object longlong reader",              0x1401ce900L },
        new Object[] { 2, "shared utility (DMSM + AMDM)",            0x140157c90L },
    };

    // Negative-signal substrings — same set as HOP 2.
    private static final String[] NEG_SIGNALS = {
        "__components.xml", "MenuBarSkin", "AM4-Edit", "Another instance",
        "MRU_DIRECTORY", "MRU_DIR_IMPORT", "MRU_SYSEX_INFO",
        "MAIN_WINDOW_STATE", "Channel %", "0x5deece66d", "tabPreset",
        "labelTabPresets", "juce::Component", "juce::LookAndFeel",
        "juce::Identifier", "juce::JUCEApplication",
        "juce::MemoryInputStream", "InitializeCriticalSection",
        "EnterCriticalSection", "RTTI_Type_Descriptor",
    };

    private static final String[] POS_BUFFER_PATTERNS = {
        "*(byte *)(", "*(undefined *)(", "(byte *)param_",
        "(byte *)(param_", "+ 3)", "* 3 +", "* 3)",
    };

    private final List<String> lines = new ArrayList<>();
    private Program program;
    private FunctionManager funcMgr;
    private Listing listing;
    private DecompInterface decomp;

    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        program = currentProgram;
        funcMgr = program.getFunctionManager();
        listing = program.getListing();
        decomp = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("DecompileAM4InboundStreamPath.java  (HOP 3 — chunk-1 parser hunt)");
        w("  Program: " + program.getName());
        w("  Output:  " + OUTPUT_PATH);
        w("  Targets: " + TARGETS.length + " functions across 2 tiers");
        w("  Anchors: " + ANCHOR_CHUNK1.length + " chunk-1 byte offsets + 1 chunk-2 offset");
        w("================================================================================");
        w("");
        w("Cross-device note: III's own per-param chunk-1 layout is ALSO unsolved");
        w("(packages/fractal-gen3/src/presetDump.ts L47 — 'treats chunk payloads as");
        w("opaque blobs'). Outer envelope is shared (primitive vendor-envelope-");
        w("descriptor-table — AM4 0x1405dcf40 ≡ III 0x1407ab940 = 3072 bytes), but");
        w("inner per-param layout is novel work for both devices. HOP 3 must derive");
        w("the AM4 layout from parser code; no cross-device shortcut available.");
        w("");

        List<String> summaryRows = new ArrayList<>();
        summaryRows.add("  tier  role                                addr            lines  anchors  stride  buf  neg  verdict");
        summaryRows.add("  ----  ----------------------------------  --------------  -----  -------  ------  ---  ---  ------------------------");

        // First-level callee map (built during pass 1, decompiled in pass 2).
        Map<Long, Set<Long>> tier1Callees = new LinkedHashMap<>();

        // ── Pass 1: decompile + score each target ────────────────
        for (Object[] t : TARGETS) {
            int tier = (Integer) t[0];
            String role = (String) t[1];
            long fa = (Long) t[2];

            Address ea = addr(fa);
            Function f = funcMgr.getFunctionAt(ea);

            w("################################################################################");
            w("## TIER " + tier + " : " + role);
            w("## " + (f == null ? "(no func)" : f.getName()) + " @ 0x" + Long.toHexString(fa));
            w("################################################################################");
            w("");

            if (f == null) {
                w("  (no function defined - SKIP)");
                w("");
                summaryRows.add(String.format(
                    "  %4d  %-34s  %-14s  %5s  %7s  %6s  %3s  %3s  %s",
                    tier, role, "(no func)", "-", "-", "-", "-", "-", "NO_FUNC"));
                continue;
            }

            DecompileResults r = decomp.decompileFunction(f, 120, monitor);
            if (!r.decompileCompleted()) {
                w("  // decompile failed: " + r.getErrorMessage());
                w("");
                continue;
            }
            DecompiledFunction dc = r.getDecompiledFunction();
            String body = dc == null ? "" : dc.getC();
            int lineCount = body.split("\n").length;

            // ── Anchor offsets (text + instr scalars) ───────────
            List<String> anchorHits = new ArrayList<>();
            for (long off : ANCHOR_CHUNK1) {
                String needle = "0x" + Long.toHexString(off);
                if (body.contains(needle)) anchorHits.add(needle);
            }
            boolean chunk2Hit = body.contains("0x" + Long.toHexString(ANCHOR_CHUNK2_ONLY));

            Set<Long> anchorSet = new HashSet<>();
            for (long o : ANCHOR_CHUNK1) anchorSet.add(o);
            anchorSet.add(ANCHOR_CHUNK2_ONLY);
            Set<Long> insnAnchorHits = new TreeSet<>();
            InstructionIterator it = listing.getInstructions(f.getBody(), true);
            // Also collect first-level callees here for tier-1 functions
            Set<Long> calleeAddrs = new LinkedHashSet<>();
            while (it.hasNext()) {
                Instruction ins = it.next();
                int nOps = ins.getNumOperands();
                for (int i = 0; i < nOps; i++) {
                    Scalar sc = ins.getScalar(i);
                    if (sc == null) continue;
                    long v = sc.getUnsignedValue();
                    if (anchorSet.contains(v)) insnAnchorHits.add(v);
                }
                if (tier == 1) {
                    for (Reference ref : ins.getReferencesFrom()) {
                        if (!ref.getReferenceType().isCall()) continue;
                        long ta = ref.getToAddress().getOffset();
                        // Stay inside the binary's text range
                        if (ta >= 0x140000000L && ta < 0x141000000L) calleeAddrs.add(ta);
                    }
                }
            }
            if (tier == 1) tier1Callees.put(fa, calleeAddrs);

            // ── Stride-hint hits ────────────────────────────────
            int strideHitCount = 0;
            List<String> strideExamples = new ArrayList<>();
            for (long s : STRIDE_HINTS) {
                String hexNeedle = "0x" + Long.toHexString(s);
                int idx = 0;
                while ((idx = body.indexOf(hexNeedle, idx)) != -1) {
                    strideHitCount++;
                    if (strideExamples.size() < 3) {
                        int snipStart = Math.max(0, idx - 20);
                        int snipEnd = Math.min(body.length(), idx + 30);
                        strideExamples.add(hexNeedle + " in: ..."
                            + body.substring(snipStart, snipEnd).replace("\n", " ") + "...");
                    }
                    idx += hexNeedle.length();
                }
            }

            // ── Buffer-pattern hits ─────────────────────────────
            int bufPatternHits = 0;
            for (String p : POS_BUFFER_PATTERNS) {
                int idx = 0;
                while ((idx = body.indexOf(p, idx)) != -1) {
                    bufPatternHits++;
                    idx += p.length();
                }
            }

            // ── Negative signals ────────────────────────────────
            List<String> negHits = new ArrayList<>();
            for (String n : NEG_SIGNALS) if (body.contains(n)) negHits.add(n);

            // ── Switch-on-state detection ───────────────────────
            // Workflow state-machine executors have a top-level
            // `switch(*(int *)(this + N))` or `switch(*(int *)(param_1 + N))`.
            // Count `switch` statements in the body as a heuristic.
            int switchCount = countOccurrences(body, "switch (");
            int caseCount = countOccurrences(body, "  case ") + countOccurrences(body, "\n  case ");

            // ── Caller histogram ────────────────────────────────
            int callerCount = 0;
            List<String> callerSamples = new ArrayList<>();
            ReferenceManager refMgr = program.getReferenceManager();
            for (Reference ref : refMgr.getReferencesTo(ea)) {
                if (!ref.getReferenceType().isCall()) continue;
                callerCount++;
                if (callerSamples.size() < 6) {
                    Function caller = funcMgr.getFunctionContaining(ref.getFromAddress());
                    callerSamples.add(
                        (caller == null ? "(no func)" : caller.getName())
                            + " @ " + ref.getFromAddress());
                }
            }

            w("  Decompile lines: " + lineCount);
            w("  Caller count:    " + callerCount);
            for (String c : callerSamples) w("    - " + c);
            if (callerCount > callerSamples.size())
                w("    ... + " + (callerCount - callerSamples.size()) + " more");
            w("");
            w("  Anchor hits (text):           " + anchorHits.size() + "/" + ANCHOR_CHUNK1.length
                + (chunk2Hit ? " (+chunk2 0x120)" : ""));
            if (!anchorHits.isEmpty()) w("    " + String.join(" ", anchorHits));
            w("  Anchor hits (instr scalars):  " + insnAnchorHits.size());
            if (!insnAnchorHits.isEmpty()) {
                List<String> hs = new ArrayList<>();
                for (Long v : insnAnchorHits) hs.add("0x" + Long.toHexString(v));
                w("    " + String.join(" ", hs));
            }
            w("  Stride hits (0x3/0x12/0x27):  " + strideHitCount);
            for (String s : strideExamples) w("    " + s);
            w("  Buffer-pattern hits:          " + bufPatternHits);
            w("  switch statements:            " + switchCount);
            w("  case labels:                  " + caseCount);
            w("  Negative signals:             " + negHits.size());
            if (!negHits.isEmpty()) w("    " + String.join(", ", negHits));
            w("");

            // ── Verdict ─────────────────────────────────────────
            int parserScore = anchorHits.size() * 4
                + (int) insnAnchorHits.size() * 4
                + (chunk2Hit ? 2 : 0)
                + Math.min(strideHitCount, 10)
                + Math.min(bufPatternHits, 8)
                + Math.min(switchCount * 2, 6)
                + Math.min(caseCount / 4, 6);

            boolean ruledOutPersistence = body.contains("__components.xml")
                || body.contains("MenuBarSkin")
                || body.contains("MRU_DIRECTORY");
            boolean ruledOutSingleInstance = body.contains("Another instance")
                || (body.contains("AM4-Edit") && body.contains("Only one instance"));
            boolean ruledOutRng = body.contains("0x5deece66d");
            boolean ruledOutJuceUi = body.contains("juce::JUCEApplication::RTTI_Type_Descriptor");

            String verdict;
            if (ruledOutPersistence)         verdict = "RULED_OUT_PERSISTENCE_LOAD";
            else if (ruledOutSingleInstance) verdict = "RULED_OUT_SINGLE_INSTANCE_DIALOG";
            else if (ruledOutRng)            verdict = "RULED_OUT_RNG";
            else if (ruledOutJuceUi)         verdict = "RULED_OUT_JUCE_UI";
            else if (parserScore >= 14)      verdict = "STRONG_PARSER_CANDIDATE (score=" + parserScore + ")";
            else if (parserScore >= 8)       verdict = "PARSER_CANDIDATE (score=" + parserScore + ")";
            else if (parserScore > 0)        verdict = "WEAK_PARSER_SIGNAL (score=" + parserScore + ")";
            else                              verdict = "UNCLEAR (no signals matched)";

            w("  >>> VERDICT: " + verdict);
            w("");

            summaryRows.add(String.format(
                "  %4d  %-34s  0x%-12x  %5d  %4d/%2d  %6d  %3d  %3d  %s",
                tier, truncate(role, 34), fa, lineCount,
                anchorHits.size() + (int) insnAnchorHits.size(),
                ANCHOR_CHUNK1.length,
                strideHitCount, bufPatternHits, negHits.size(), verdict));

            // Decompile body (capped at 260 lines per slot)
            w("  --- decompile (capped at 260 lines) ---");
            int maxLines = 260;
            int idx = 0;
            for (String l : body.split("\n")) {
                if (idx++ >= maxLines) {
                    w("  ... (truncated at " + maxLines + " lines; total " + lineCount + ")");
                    break;
                }
                w("  " + l);
            }
            w("");
        }

        // ── Pass 2: enumerate first-level callees from tier-1 ────
        w("################################################################################");
        w("## Tier 1 first-level callees (function size + name only — read manually)");
        w("################################################################################");
        w("");
        Set<Long> alreadyDecompiled = new HashSet<>();
        for (Object[] t : TARGETS) alreadyDecompiled.add((Long) t[2]);

        for (Map.Entry<Long, Set<Long>> e : tier1Callees.entrySet()) {
            Function parent = funcMgr.getFunctionAt(addr(e.getKey()));
            w("--- callees of "
                + (parent == null ? "0x" + Long.toHexString(e.getKey()) : parent.getName())
                + " ---");
            int seen = 0;
            for (Long ca : e.getValue()) {
                if (alreadyDecompiled.contains(ca)) continue;
                Function callee = funcMgr.getFunctionAt(addr(ca));
                String name = callee == null ? "(no func)" : callee.getName();
                long bodySize = callee == null ? 0 : callee.getBody().getNumAddresses();
                w(String.format("    0x%x  %-20s  bytes=%d", ca, name, bodySize));
                if (++seen >= 16) {
                    w("    ... + " + (e.getValue().size() - seen - alreadyDecompiledIntersection(e.getValue(), alreadyDecompiled)) + " more (cap)");
                    break;
                }
            }
            w("");
        }

        w("################################################################################");
        w("## Summary");
        w("################################################################################");
        for (String row : summaryRows) w(row);
        w("");

        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }

    private int countOccurrences(String hay, String needle) {
        int count = 0, idx = 0;
        while ((idx = hay.indexOf(needle, idx)) != -1) {
            count++;
            idx += needle.length();
        }
        return count;
    }

    private int alreadyDecompiledIntersection(Set<Long> set, Set<Long> targets) {
        int c = 0;
        for (Long v : set) if (targets.contains(v)) c++;
        return c;
    }

    private String truncate(String s, int n) {
        return s.length() <= n ? s : s.substring(0, n - 1) + ".";
    }

    private Address addr(long off) {
        return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(off);
    }
}
