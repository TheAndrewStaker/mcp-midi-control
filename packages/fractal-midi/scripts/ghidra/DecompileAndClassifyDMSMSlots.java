// DecompileAndClassifyDMSMSlots.java - Ghidra GhidraScript
//
// Hop 2 of the AM4-Edit parser-side decode arc. The prior session
// (preset-binary-format-research.md sec 11) decoded the full
// AM4DeviceManager + FasStateMachine + DeviceMgrStateMachine class
// hierarchy and narrowed the chunk-1 SysEx parser to a handful of
// large-body vtable slots. This script classifies each candidate by
// feature signature so the parser slot can be pinned in one mining
// pass.
//
// Per primitive iii-async-workflow-fn-registry (matched, cross-device
// 2026-05-28) + iii-workflow-state-machine-executor (matched-singleton
// on III), the AM4-Edit parser is reached via a workflow-object vtable
// slot dispatched by workflow state, NOT a fn-byte switch (which
// _negative/iii-fn-byte-switch-as-inbound-dispatcher rules out for
// both III and AM4).
//
// Targets:
//   DeviceMgrStateMachine::vftable @ 0x1412c4138
//     slot 30  FUN_140321000  (660 lines)
//     slot 12  FUN_14031fed0  (544 lines)
//     slot 22  FUN_14031f110  (480 lines)
//     slot 45  FUN_1404fb6b0  (179 lines)
//     slot 14  FUN_1403209f0  (90 lines)
//     slot  1  FUN_14031cf90  (69 lines)
//   AM4DeviceManager::vftable @ 0x1412c2460
//     slot  3  FUN_1402debc0
//     slot  4  FUN_1402ddb80
//     slot  5  FUN_1402da600
//     slot  7  FUN_140023630
//     slot  8  FUN_1402e41a0
//     slot  9  FUN_1402e3da0
//     slot 10  FUN_1402e23b0
//   (slot 6 of AM4DeviceManager is unbound -> skip)
//
// Per slot we emit:
//   - PARSER signals: anchor-offset literal hits, stride-3 references,
//     byte-buffer read pattern hits, state-field switch
//   - NEGATIVE signals: JUCE vtable refs, "__components.xml",
//     "MenuBarSkin", "AM4-Edit", "Channel %", "MRU_", LCG constants
//     (0x5deece66d for Java rand48), settings-load APIs
//   - Verdict: PARSER_CANDIDATE / RULED_OUT_<reason> / UNCLEAR
//   - Decompile body (capped at 220 lines per slot to keep the dump
//     readable)
//
// The 22 anchor offsets are derived from samples/captured/
// am4-warm-pair-diff.json step-5 amp-type-swap exclusive-record list
// (rec_id * 3 byte offset, septet-packed 14-bit per primitive
// septet-14bit).
//
// Output:
//   %PROJECT_ROOT%\samples\captured\decoded\
//     ghidra-am4-edit-classify-dmsm-slots.txt
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

public class DecompileAndClassifyDMSMSlots extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-am4-edit-classify-dmsm-slots.txt";

    // Anchor offsets (chunk-1 byte positions) from
    // samples/captured/am4-warm-pair-diff.json step-5 exclusive recs.
    // Computed as rec_id * 3 (septet-packed 14-bit, 3 bytes per record).
    // These are the per-block-descriptor positions touched by a slot-1
    // amp-type swap and untouched by any other warm-pair step.
    private static final long[] ANCHOR_CHUNK1 = {
        0x01b0L, 0x0222L, 0x025eL, 0x027fL, 0x0282L, 0x0294L, 0x0297L,
        0x02a9L, 0x02bbL, 0x02beL, 0x02cdL, 0x02d0L, 0x02e2L, 0x02f4L,
        0x02f7L, 0x0309L, 0x031bL, 0x031eL, 0x0345L, 0x036cL, 0x0393L,
        0x03a5L
    };
    private static final long ANCHOR_CHUNK2_ONLY = 0x0120L;

    // Cluster strides that recur in the anchor gaps:
    //   0x03 = stride between adjacent septet records (3 bytes/rec)
    //   0x12 = 18 bytes = 6-record cluster (likely 6 params per channel)
    //   0x27 = 39 bytes = 13-record cluster (likely cross-channel stride for amp)
    private static final long[] STRIDE_HINTS = { 0x03L, 0x12L, 0x27L };

    // Target functions: (vtable_owner, slot, address)
    private static final Object[][] TARGETS = {
        // DeviceMgrStateMachine::vftable @ 0x1412c4138
        new Object[] { "DMSM",  30, 0x140321000L },
        new Object[] { "DMSM",  12, 0x14031fed0L },
        new Object[] { "DMSM",  22, 0x14031f110L },
        new Object[] { "DMSM",  45, 0x1404fb6b0L },
        new Object[] { "DMSM",  14, 0x1403209f0L },
        new Object[] { "DMSM",   1, 0x14031cf90L },
        // AM4DeviceManager::vftable @ 0x1412c2460
        new Object[] { "AMDM",   3, 0x1402debc0L },
        new Object[] { "AMDM",   4, 0x1402ddb80L },
        new Object[] { "AMDM",   5, 0x1402da600L },
        new Object[] { "AMDM",   7, 0x140023630L },
        new Object[] { "AMDM",   8, 0x1402e41a0L },
        new Object[] { "AMDM",   9, 0x1402e3da0L },
        new Object[] { "AMDM",  10, 0x1402e23b0L },
    };

    // Negative-signal substrings (case-sensitive; decompile fragments).
    private static final String[] NEG_SIGNALS = {
        "__components.xml",
        "MenuBarSkin",
        "AM4-Edit",
        "Another instance",
        "MRU_DIRECTORY",
        "MRU_DIR_IMPORT",
        "MRU_SYSEX_INFO",
        "MAIN_WINDOW_STATE",
        "Channel %",
        "0x5deece66d",          // Java rand48 LCG constant
        "0xb5deece66dL",        // alt rendering
        "tabPreset",
        "labelTabPresets",
        "juce::Component",
        "juce::LookAndFeel",
        "juce::Identifier",
        "juce::JUCEApplication",
        "juce::MemoryInputStream",
        "InitializeCriticalSection",
        "EnterCriticalSection",
        "RTTI_Type_Descriptor",
    };

    // Positive-signal regex-ish substrings (decompile fragments).
    // These are weaker individually but combine into a parser score.
    private static final String[] POS_BUFFER_PATTERNS = {
        "*(byte *)(",           // byte-buffer indexing
        "*(undefined *)(",
        "(byte *)param_",
        "(byte *)(param_",
        "+ 3)",                 // stride-3 advance
        "* 3 +",
        "* 3)",
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
        w("DecompileAndClassifyDMSMSlots.java");
        w("  Program: " + program.getName());
        w("  Output:  " + OUTPUT_PATH);
        w("  Targets: " + TARGETS.length + " functions");
        w("  Anchors: " + ANCHOR_CHUNK1.length + " chunk-1 offsets + 1 chunk-2 offset");
        w("================================================================================");
        w("");

        // ─── Summary table populated as we go ───────────────────────
        List<String> summaryRows = new ArrayList<>();
        summaryRows.add("  owner   slot  function          lines  anchors  stride3  negSig  verdict");
        summaryRows.add("  ------  ----  ----------------  -----  -------  -------  ------  ------------------------");

        for (Object[] t : TARGETS) {
            String owner = (String) t[0];
            int    slot  = (Integer) t[1];
            long   fa    = (Long) t[2];

            Address ea = addr(fa);
            Function f = funcMgr.getFunctionAt(ea);

            w("################################################################################");
            w("## " + owner + " slot " + slot + " : " + (f == null ? "(no func)" : f.getName())
                + " @ 0x" + Long.toHexString(fa));
            w("################################################################################");
            w("");

            if (f == null) {
                w("  (no function defined at this address - SKIP)");
                w("");
                summaryRows.add(String.format(
                    "  %-6s  %3d   (no-func)         %5s  %7s  %7s  %6s  %s",
                    owner, slot, "-", "-", "-", "-", "RULED_OUT_NO_FUNC"));
                continue;
            }

            DecompileResults r = decomp.decompileFunction(f, 120, monitor);
            if (!r.decompileCompleted()) {
                w("  // decompile failed: " + r.getErrorMessage());
                w("");
                summaryRows.add(String.format(
                    "  %-6s  %3d   %-16s  %5s  %7s  %7s  %6s  %s",
                    owner, slot, f.getName(), "?", "?", "?", "?", "DECOMPILE_FAILED"));
                continue;
            }
            DecompiledFunction dc = r.getDecompiledFunction();
            String body = dc == null ? "" : dc.getC();
            int lineCount = body.split("\n").length;

            // ── Score: anchor offsets in decompile text ───────────
            List<String> anchorHits = new ArrayList<>();
            for (long off : ANCHOR_CHUNK1) {
                String needle = "0x" + Long.toHexString(off);
                if (body.contains(needle)) anchorHits.add(needle);
            }
            String c2Needle = "0x" + Long.toHexString(ANCHOR_CHUNK2_ONLY);
            boolean chunk2Hit = body.contains(c2Needle);

            // ── Score: anchor offsets as instruction-level scalars ──
            // (decompiler may fold constants away; raw operands catch them)
            Set<Long> anchorSet = new HashSet<>();
            for (long o : ANCHOR_CHUNK1) anchorSet.add(o);
            anchorSet.add(ANCHOR_CHUNK2_ONLY);
            Set<Long> insnAnchorHits = new TreeSet<>();
            InstructionIterator it = listing.getInstructions(f.getBody(), true);
            while (it.hasNext()) {
                Instruction ins = it.next();
                int nOps = ins.getNumOperands();
                for (int i = 0; i < nOps; i++) {
                    Scalar sc = ins.getScalar(i);
                    if (sc == null) continue;
                    long v = sc.getUnsignedValue();
                    if (anchorSet.contains(v)) insnAnchorHits.add(v);
                }
            }

            // ── Score: stride-3 / cluster stride references ────────
            // Decompile rendering: "+ 3", "* 3", "+ 0x12", "+ 0x27"
            int strideHitCount = 0;
            List<String> strideExamples = new ArrayList<>();
            for (long s : STRIDE_HINTS) {
                String hexNeedle = "0x" + Long.toHexString(s);
                int idx = 0;
                while ((idx = body.indexOf(hexNeedle, idx)) != -1) {
                    strideHitCount++;
                    if (strideExamples.size() < 4) {
                        int snipStart = Math.max(0, idx - 20);
                        int snipEnd = Math.min(body.length(), idx + 30);
                        strideExamples.add(hexNeedle + " in: ..." +
                            body.substring(snipStart, snipEnd).replace("\n", " ") + "...");
                    }
                    idx += hexNeedle.length();
                }
            }
            // The bare " 3)" and " 3 +" patterns are too noisy to count
            // reliably from text; rely on the 0x12 / 0x27 cluster strides
            // as the structural fingerprint.

            // ── Score: buffer-read pattern hits ────────────────────
            int bufPatternHits = 0;
            for (String p : POS_BUFFER_PATTERNS) {
                int idx = 0;
                while ((idx = body.indexOf(p, idx)) != -1) {
                    bufPatternHits++;
                    idx += p.length();
                }
            }

            // ── Score: negative signals ────────────────────────────
            List<String> negHits = new ArrayList<>();
            for (String n : NEG_SIGNALS) {
                if (body.contains(n)) negHits.add(n);
            }

            // ── Caller histogram (helps identify dispatch entry points) ──
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
            if (callerCount > callerSamples.size()) {
                w("    ... + " + (callerCount - callerSamples.size()) + " more");
            }
            w("");
            w("  Anchor-offset hits (decompile text):    " + anchorHits.size() + "/" + ANCHOR_CHUNK1.length
                + (chunk2Hit ? " (+chunk2 0x120)" : ""));
            if (!anchorHits.isEmpty()) {
                w("    hits: " + String.join(" ", anchorHits));
            }
            w("  Anchor-offset hits (instr scalars):      " + insnAnchorHits.size());
            if (!insnAnchorHits.isEmpty()) {
                List<String> hs = new ArrayList<>();
                for (Long v : insnAnchorHits) hs.add("0x" + Long.toHexString(v));
                w("    hits: " + String.join(" ", hs));
            }
            w("  Stride-hint references (0x3/0x12/0x27): " + strideHitCount);
            for (String s : strideExamples) w("    " + s);
            w("  Buffer-pattern hits:                     " + bufPatternHits);
            w("  Negative signals:                        " + negHits.size());
            if (!negHits.isEmpty()) w("    " + String.join(", ", negHits));
            w("");

            // ── Verdict ─────────────────────────────────────────────
            String verdict;
            int parserScore = anchorHits.size() * 4
                + (int) insnAnchorHits.size() * 4
                + (chunk2Hit ? 2 : 0)
                + Math.min(strideHitCount, 12)
                + Math.min(bufPatternHits, 8);
            // Hard rule-outs by negative signal class.
            boolean ruledOutPersistence = body.contains("__components.xml")
                || body.contains("MenuBarSkin")
                || body.contains("MRU_DIRECTORY")
                || body.contains("MRU_DIR_IMPORT");
            boolean ruledOutSingleInstance = body.contains("Another instance")
                || body.contains("AM4-Edit") && body.contains("Only one instance");
            boolean ruledOutRng = body.contains("0x5deece66d");
            boolean ruledOutJuceUi = body.contains("juce::Component")
                || body.contains("juce::LookAndFeel")
                || body.contains("juce::JUCEApplication::RTTI_Type_Descriptor");

            if (ruledOutPersistence)        verdict = "RULED_OUT_PERSISTENCE_LOAD";
            else if (ruledOutSingleInstance) verdict = "RULED_OUT_SINGLE_INSTANCE_DIALOG";
            else if (ruledOutRng)            verdict = "RULED_OUT_RNG";
            else if (ruledOutJuceUi)         verdict = "RULED_OUT_JUCE_UI";
            else if (parserScore >= 10)      verdict = "PARSER_CANDIDATE (score=" + parserScore + ")";
            else if (parserScore > 0)        verdict = "WEAK_PARSER_SIGNAL (score=" + parserScore + ")";
            else                              verdict = "UNCLEAR (no signals matched)";

            w("  >>> VERDICT: " + verdict);
            w("");

            summaryRows.add(String.format(
                "  %-6s  %3d   %-16s  %5d  %4d/%2d  %7d  %6d  %s",
                owner, slot, f.getName(), lineCount,
                (anchorHits.size() + (int) insnAnchorHits.size()), ANCHOR_CHUNK1.length,
                strideHitCount, negHits.size(), verdict));

            // ── Decompile body (capped) ────────────────────────────
            w("  --- decompile (capped at 220 lines) ---");
            int maxLines = 220;
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

        w("================================================================================");
        w("## Summary");
        w("================================================================================");
        for (String row : summaryRows) w(row);
        w("");

        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }

    private Address addr(long off) {
        return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(off);
    }
}
