# Roadmap

## Where things stand

- Eight devices are hardware-verified on real units. The deepest surfaces are the Fractal AM4, the Fractal Axe-Fx II XL+, and the ASM Hydrasynth Explorer: whole-preset and whole-patch authoring confirmed end to end, with hardware-confirmed stored-library management on the Hydrasynth (stored-patch reads, receipt-true saves, byte-exact restore, series writes).
- Also hardware-verified: the Novation Circuit Tracks (groove and melody sequencing, sample and project upload, sequencing of outboard gear), the Roland SPD-SX (kit and sample authoring over USB mass storage, kit recall and pad triggers over MIDI), the Boss VE-500 (parameter set/read, whole-patch apply, save), the Boss RC-505mk2 (memory recall plus `.RC0` memory reads and authoring), and the Arturia MicroFreak (stored-preset scans, globals read/write, byte-exact preset import).
- The modern Fractal family (Axe-Fx III / FM3 / FM9) is in community beta on one shared gen-3 codec with per-device parameter catalogs. Reads and continuous parameter writes are hardware-confirmed on all three; the remaining gaps vary per device (save, discrete set-by-name, the live grid read) and are tracked in the contributor pages.
- The Fractal VP4 (gen-3 codec, AM4-shaped) ships reads plus community-beta continuous writes, bypass, and save; block placement, scene and preset switching, and enum sets stay gated pending wire decodes.
- The original Axe-Fx Standard/Ultra (gen-1) is in community beta: parameter set + read and a spec-pinned `get_preset` subset, decoded from Fractal's published gen-1 SysEx spec, awaiting hardware confirmation.
- The Fractal AX8 ships as a community-beta config on the hardware-verified Axe-Fx II codec; the Boss RC-600 and Arturia MiniFreak are registered generic-only pending community evidence. The Akai MPC One G2 is registered generic-only (sequence recall and live drum notes over MIDI); its card and project file surface is the next step.
- Generic-MIDI primitives (CC, NRPN, SysEx, program change, notes, clock) reach any USB MIDI device the OS exposes.
- The wire codecs are standalone packages (`fractal-midi` on npm, `roland-midi`); the tool surface is unified and port-dispatched, so adding a device is a descriptor plus a wire adapter, not new tools.
- The authoritative per-device tier table is in [docs/contributing/README.md](docs/contributing/README.md) (checked against each descriptor in preflight) and summarized in the [README](README.md).

## Next

- Modern Fractal family to hardware-verified: on-device confirmation of `save_preset`, an FM3 run on the Windows serial driver, display-range calibration wiring, and the remaining community-beta ops. Probe scripts and capture guides (`packages/fractal-midi/docs/capture-guides/`) target the highest-value gaps; per-device asks are ranked in [docs/contributing/devices/](docs/contributing/devices/).
- Boss RC-600 authoring: waits on one donated memory file with populated ASSIGN slots.
- Arturia MiniFreak SysEx: waits on a one-byte read-only community probe (the Arturia device-code byte).

## Wanted (demand-driven)

- Expansion beyond the current catalog: popular amp modelers that publish their MIDI specifications (Line 6 Helix and similar) and other high-demand gear. A new device is a descriptor plus a wire adapter, not new tools; which comes first is driven by owner demand. Generic-MIDI primitives cover anything with a published CC chart in the meantime.
