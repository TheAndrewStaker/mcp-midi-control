<!-- Provenance: NEW for monorepo main; replaces the original `README.md` from branch `hydrasynth-explorer` (commit 3d63075) which described branch-only context. The four reference docs in this folder were harvested from the same branch; this README is a thin index pointing at current paths. -->

# Hydrasynth Explorer — device folder

Working knowledge base for **ASM Hydrasynth Explorer** support. Per-
device, so device-specific notes don't pollute the AM4 / Axe-Fx docs
at the top of `docs/`.

## Index

- **`OVERVIEW.md`** — what the device is, protocol surface, capability
  matrix, and the value-encoding quick reference (`/8` patch-buffer
  scaling, 14-bit auto-scale, enum-table resolution). Read first.
- **`MIDI-MAP.md`** — human-readable companion to the 1175-NRPN code
  catalog. Full CC chart sorted by CC number, NRPN-catalog summary,
  Bank-Select / PC scheme, SysEx envelope status.
- **`HYDRA-FILE-FORMAT.md`** — ASM-Manager `.hydra` / `.patch` file
  format (1762-byte container, partially RE'd, not blocking — go
  around it via the SysEx Request/Save flow).
- **`ICONIC-TONES.md`** — 15 iconic synth tones used as hardware
  tests + demo portfolio (Van Halen "Jump", A-ha "Take On Me",
  Mortal Kombat "Techno Syndrome", etc.).

## Where things live elsewhere

- **Manual (PDF):** `docs/manuals/other-gear/Hydrasynth_Explorer_Owners_Manual_2.2.0.pdf`
- **Manual (text extract):** `docs/manuals/other-gear/Hydrasynth_Explorer_Owners_Manual_2.2.0.txt`
- **Factory patch listing (xlsx):** `docs/manuals/other-gear/Hydrasynth_Single_Factory_Patch_Listing_2.0.xlsx`
- **Code — NRPN catalog (auto-generated):** `packages/hydrasynth/src/nrpn.ts`
- **Code — value resolution + NRPN encoding:** `packages/hydrasynth/src/encoding.ts`
- **Code — enum tables (vendored from edisyn):** `packages/hydrasynth/src/enums.ts`
- **Code — SysEx envelope codec:** `packages/hydrasynth/src/sysexEnvelope.ts`
- **Code — patch byte-map encoder:** `packages/hydrasynth/src/patchEncoder.ts`
- **Code — MCP server (tools `hydra_*`):** `packages/hydrasynth/src/server.ts`
- **References (vendored from eclab/edisyn, Apache-2.0):** `references/` in this folder — `nrpn.csv`, `SysexEncoding.txt`, `SysexPatchFormat.txt`, `ASMHydrasynth.java`. See `references/README.md` for provenance.

## Status legend (used in this folder)

- 🟢 **confirmed** — verified against captured bytes from the device
  and reproducible.
- 🟡 **structural** — derived from the official manual or community RE
  but not yet hardware-verified by us end-to-end.
- 🔴 **unknown / blocked** — needs capture, document, or community
  decode work.
