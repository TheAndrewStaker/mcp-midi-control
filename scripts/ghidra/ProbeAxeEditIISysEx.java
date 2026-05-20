// ProbeAxeEditIISysEx.java — Ghidra GhidraScript
//
// Diagnostic probe for the V1/V2 zero-result mystery. The state-builder
// scans found ZERO candidates, which means our assumptions about how
// AxeEdit constructs SysEx envelopes are wrong. This script collects
// hard evidence about what IS in the binary:
//
//   1. How many SCALAR 0xF7 immediate operands does the binary contain?
//      0xF7 only appears in SysEx-end contexts; if the count is zero,
//      AxeEdit doesn't use byte immediates at all.
//
//   2. How many SCALAR 0x74 (Fractal mfr byte 3)? If non-zero in
//      isolation, the envelope IS built with immediates but they're
//      spread across helpers we're not joining.
//
//   3. ASCII strings containing keywords like "SysEx", "MIDI", "preset",
//      "block", "send", "envelope", "checksum". Strings xref to handler
//      functions, which lead us to the wire code via static call graph
//      analysis Ghidra has already done.
//
//   4. References to known MIDI APIs (midiOutShortMsg, midiOutLongMsg,
//      midiOutMessage, midiOutOpen). The wire-write code is downstream
//      of one of these.
//
// Output: samples/captured/decoded/ghidra-axeedit2-probe.txt
//
// @category AxeFxII

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompiledFunction;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressIterator;
import ghidra.program.model.address.AddressSetView;
import ghidra.program.model.data.StringDataInstance;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.listing.Program;
import ghidra.program.model.scalar.Scalar;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceManager;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolIterator;
import ghidra.program.model.symbol.SymbolTable;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class ProbeAxeEditIISysEx extends GhidraScript {

    private static final String OUTPUT_PATH =
        "C:\\dev\\mcp-midi-tools\\samples\\captured\\decoded\\ghidra-axeedit2-probe.txt";

    private static final String[] KEYWORDS = {
        "SysEx", "sysex", "SYSEX",
        "midiOut", "midiIn",
        "envelope", "Envelope",
        "checksum", "Checksum",
        "preset", "Preset", "PRESET",
        "block", "Block", "BLOCK",
        "scene", "Scene", "SCENE",
        "fn=", "function byte",
        "ReadFrom", "WriteTo",
        "0x74", "F0 00 01 74",
        "BlocksData", "GridLayout",
        "axefx", "AxeFx", "axe-fx",
    };

    private static final String[] MIDI_APIS = {
        "midiOutShortMsg", "midiOutLongMsg", "midiOutMessage",
        "midiOutOpen", "midiInOpen", "midiInStart",
    };

    private final List<String> lines = new ArrayList<>();
    private DecompInterface decomp;
    private FunctionManager funcMgr;
    private ReferenceManager refMgr;
    private Listing listing;

    private void w(String s) {
        lines.add(s);
        println(s);
    }

    private int countScalarOperand(int targetByte) {
        int count = 0;
        InstructionIterator iter = listing.getInstructions(true);
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
                    if (v == targetByte) count++;
                }
            }
        }
        return count;
    }

    /**
     * Find functions whose body contains at least one MOV-immediate (or
     * push-immediate) loading `targetByte`. Returns up to `cap` distinct
     * function entry points.
     */
    private List<long[]> findFunctionsLoadingByte(int targetByte, int cap) {
        List<long[]> hits = new ArrayList<>();
        Set<Long> seen = new HashSet<>();
        for (Function f : funcMgr.getFunctions(true)) {
            if (monitor.isCancelled()) break;
            if (seen.size() >= cap) break;
            AddressSetView body = f.getBody();
            int occurrences = 0;
            InstructionIterator iter = listing.getInstructions(body, true);
            while (iter.hasNext()) {
                Instruction insn = iter.next();
                int nOps = insn.getNumOperands();
                for (int op = 0; op < nOps; op++) {
                    Object[] objs = insn.getOpObjects(op);
                    for (Object o : objs) {
                        if (!(o instanceof Scalar)) continue;
                        if (((Scalar) o).getUnsignedValue() == targetByte) {
                            occurrences++;
                        }
                    }
                }
            }
            if (occurrences > 0) {
                long entry = f.getEntryPoint().getOffset();
                if (seen.add(entry)) {
                    hits.add(new long[] { entry, occurrences });
                }
            }
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
        w("Axe-Edit II RE — ProbeAxeEditIISysEx.java");
        w("  Diagnostic probe: what's actually IN the binary?");
        w("================================================================================");
        w("");

        // ── Section 1: scalar immediate counts ─────────────────────────
        w("################################################################################");
        w("## Section 1: SysEx-byte immediate counts across all instructions");
        w("################################################################################");
        int[] probeBytes = { 0xF0, 0xF7, 0x74, 0x07, 0x0E, 0x18, 0x47, 0x77 };
        for (int b : probeBytes) {
            if (monitor.isCancelled()) break;
            int count = countScalarOperand(b);
            w(String.format("  scalar immediate 0x%02X: %d occurrences", b, count));
        }
        w("");

        // ── Section 2: per-byte function locations ─────────────────────
        w("################################################################################");
        w("## Section 2: functions that load specific bytes (up to 6 per byte)");
        w("################################################################################");
        for (int b : new int[] { 0xF0, 0xF7, 0x77, 0x18, 0x0E, 0x47 }) {
            if (monitor.isCancelled()) break;
            List<long[]> hits = findFunctionsLoadingByte(b, 6);
            w(String.format("  byte 0x%02X — found in %d functions (first 6):", b, hits.size()));
            for (long[] hit : hits) {
                w(String.format("    FUN_%08x  (%d occurrences in body)", hit[0], hit[1]));
            }
            w("");
        }

        // ── Section 3: keyword strings ────────────────────────────────
        w("################################################################################");
        w("## Section 3: defined strings containing SysEx-relevant keywords");
        w("################################################################################");
        DataIterator dataIter = listing.getDefinedData(true);
        Map<String, List<Address>> keywordHits = new TreeMap<>();
        for (String k : KEYWORDS) keywordHits.put(k, new ArrayList<>());
        int scanned = 0;
        while (dataIter.hasNext()) {
            if (monitor.isCancelled()) break;
            Data d = dataIter.next();
            scanned++;
            if (!d.hasStringValue()) continue;
            StringDataInstance s = StringDataInstance.getStringDataInstance(d);
            if (s == null) continue;
            String text = s.getStringValue();
            if (text == null || text.length() < 4) continue;
            for (String k : KEYWORDS) {
                if (text.contains(k)) {
                    keywordHits.get(k).add(d.getAddress());
                }
            }
        }
        w("  scanned " + scanned + " defined-data entries");
        w("");
        for (Map.Entry<String, List<Address>> e : keywordHits.entrySet()) {
            if (e.getValue().isEmpty()) continue;
            w(String.format("  '%s' — %d hits (first 5 addrs):", e.getKey(), e.getValue().size()));
            for (int i = 0; i < Math.min(5, e.getValue().size()); i++) {
                Address a = e.getValue().get(i);
                Data d = listing.getDataAt(a);
                String snippet = "";
                if (d != null && d.hasStringValue()) {
                    snippet = d.getDefaultValueRepresentation();
                    if (snippet.length() > 80) snippet = snippet.substring(0, 80) + "...";
                }
                w("    0x" + a + " : " + snippet);
            }
        }

        // ── Section 4: MIDI API imports / symbols ──────────────────────
        w("");
        w("################################################################################");
        w("## Section 4: MIDI API symbols (imports + xrefs)");
        w("################################################################################");
        SymbolTable symTable = program.getSymbolTable();
        for (String api : MIDI_APIS) {
            if (monitor.isCancelled()) break;
            SymbolIterator si = symTable.getSymbols(api);
            int found = 0;
            while (si.hasNext()) {
                Symbol s = si.next();
                found++;
                Address a = s.getAddress();
                int xrefCount = 0;
                Set<Function> callers = new HashSet<>();
                for (Reference r : refMgr.getReferencesTo(a)) {
                    xrefCount++;
                    Function caller = funcMgr.getFunctionContaining(r.getFromAddress());
                    if (caller != null) callers.add(caller);
                }
                w(String.format("  %s @ 0x%s — %d xrefs across %d unique callers", api, a.toString(), xrefCount, callers.size()));
                if (callers.size() <= 10) {
                    for (Function c : callers) {
                        w("    caller: " + c.getName() + " @ " + c.getEntryPoint());
                    }
                }
            }
            if (found == 0) {
                w(String.format("  %s — symbol not found", api));
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
