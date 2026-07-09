# Circuit Tracks: pack & project backup (design)

**Status:** Tier 1 SHIPPED (project export + backup-before-overwrite); Tiers 2–3
still design. Goal: make destructive Circuit Tracks changes safe by giving users a
Fractal-style backup/restore, so they're comfortable overwriting slots, because
anything overwritten can be restored from a file on disk.

**What shipped (Tier 1):**
- **`export_preset(port:"circuit", location:<slot 0..63>)`** → reads that project
  slot byte-exact (`downloadProject`) and writes a `.ncs` backup to
  `~/mcp-midi-backups` (override with `directory`). An empty slot reports
  `empty:true` and writes no file. Backed by a new `reader.dumpStoredPresetBinary`
  (CRC-clean or it throws, never a corrupt backup).
- **Backup-before-overwrite**: `backup_first` (default **true**) on
  `upload_project` and `apply_pattern mode:ncs_upload`. When `confirm_overwrite`
  authorizes clobbering an occupied slot, the slot's current project is saved to a
  `.ncs` first; a read/CRC failure throws and ABORTS the overwrite (never destroy a
  slot we couldn't back up). Lives in `dispatcher/backup.ts` (`backupProjectSlot`),
  so the filesystem write stays in the host layer.

**Restore is `upload_project`, NOT `import_preset`** (deviation from this doc's
original API sketch, forced by code): `import_preset`→`executeRestorePreset` gates
on `capabilities.supports_save` (Circuit = `false`) and assumes a working-buffer
push Circuit doesn't have (every project IS a flash slot). So `import_preset` stays
Fractal-only; the already-shipped slot-addressed `upload_project` is the restore
path, and it carries its own overwrite gate. `export_preset(location)` is the
universal "dump a stored slot to a backup file" read; the device-specific write
tool restores.

This mirrors the AM4 / Axe-Fx II `export_preset` (writes a `.syx` you can
re-import). The Circuit equivalent is **export a project** (`.ncs`) growing into
**export a whole pack** (projects + synth patchbanks + samples).

## Why

The project's safety contract is *read-before-write, no silent overwrites,
acknowledged writes* (see `docs/SAFE-EDIT-WORKFLOW.md`). Backups complete that
contract: today the overwrite gates *warn* before clobbering a slot, but the user
still loses the prior contents. With backups, a destructive write is reversible,
the missing piece that makes users say yes to overwriting.

## What can be read today vs. what needs decoding

| Pack content | File type | Read path | Status |
|---|---|---|---|
| Project | `.ncs` (160,780 B) | `downloadProject(conn, slot)` | ✅ hardware-confirmed, byte-exact |
| Synth patchbank | `.cpb` | file-transfer READ, type `0x04` | ↺ same READ envelope, type byte 0x04, small change |
| Drum sample | `.wav` | file-transfer READ, type `0x05` | ↺ same READ envelope, type byte 0x05, small change |
| Pack manifest | n/a | `Get Pack` (READ_INIT per file, all types) | seen in capture |

Evidence (corrected from the `get_pack_from_circuit_tracks.pcapng` capture): a
"Get Pack" reads **every** file type via the SAME file-transfer READ envelope
`downloadProject` already uses: the host issues READ_INIT (`0x01`, read-flag
`0x02`) frames for projects (`0x03`), patchbanks (`0x04`), **and samples (`0x05`,
~38 read frames in the capture)** plus one undocumented `0x07` file. So sample and
patchbank READ are NOT a new protocol: they are `downloadProject` with the
fileId TYPE byte swapped (`0x03` → `0x05`/`0x04`), reusing the proven session +
CRC loop. (Sample *names* don't appear as `0x0c` dir-replies, which is why the
naive directory read returned empty, but the sample DATA is fully readable.) A
full pack backup is three reads over one envelope: projects (done), samples
(type-swap), patchbanks (type-swap), much less work than first assumed.

## Tiers

### Tier 1: Project backup + backup-before-overwrite (SHIPPED)

Everything needed existed and is hardware-confirmed (`downloadProject`). What
landed (see the top-of-doc summary for the surface):

- **`export_preset(port, location=slot, directory?)`** → reads that project slot
  byte-exact and writes `<device>-<name>-<timestamp>.ncs`. Empty slot →
  `empty:true`, no file. Backed by `reader.dumpStoredPresetBinary`, which returns a
  `PresetBinaryDump` carrying `file_extension:'ncs'` + an `empty` flag (both new
  optional fields on the shared type so the export tool stays device-agnostic).
- **Restore** = the already-shipped **`upload_project`** (slot-addressed, gated).
  `import_preset` was NOT reused; see the deviation note at the top.
- **Backup-before-overwrite**: `backup_first` (default true) on `upload_project`
  and `apply_pattern mode:ncs_upload`. Implemented in the DISPATCHER
  (`backupProjectSlot`), gated on `confirm_overwrite` (the only path where an
  occupied slot is clobbered without the writer's own gate reading it first, so no
  double read). A CRC-failed / failed backup read THROWS and aborts the overwrite.

Naming/layout: reuse the shipped backup convention, **`~/mcp-midi-backups/`**
(homedir, `directory`-overridable). The auto backup-before-overwrite file is
`<device>-slotNN-<name>-<timestamp>.ncs` (slot tag = the wire slot 0..63). Perf
note: a 160,780-byte project read over SysEx is ~seconds, not sub-second; budget
accordingly for a 64-slot backup, and for the extra read each backup-before-
overwrite adds.

**Deferred from Tier 1 (not blocking):** a range/all `export_preset` variant that
backs up every occupied slot in one call (loop `downloadProject` per slot); the
shipped tool is single-slot. Sample-slot backup-before-overwrite still waits on the
sample READ (Tier 2); the sample gate refuses-by-default today.

### Tier 2: Full pack backup (Fractal-style, follow-on)

A complete pack = projects (Tier 1) + patchbanks + samples.

- Decode the **sample READ** (type `0x05`): we own the WRITE (READ_INIT/READ_DATA
  is the inverse, like `downloadProject` is to `uploadProject`); plus the `0x08`
  directory read for names. The `get_pack`/sample captures are the source.
- Decode the **patchbank READ** (type `0x04`) similarly.
- **`export_pack(port, directory?)`** → a folder holding every project, patchbank,
  and sample, plus a small manifest (slot → file → name) so a restore can put
  each file back. **`import_pack(port, directory)`** restores them
  (upload_project + upload_sample + upload_patchbank).

## Open questions (for review)

1. **Backup-before-overwrite default**: on by default (safest) vs opt-in (the
   extra ~1 s download per destructive write; and sample slots can't be read for
   occupancy yet, so sample backup-before-overwrite waits on Tier 2). Proposed:
   default-on for projects now; samples when their READ lands.
2. **Backup location**: a dedicated `circuit-backups/` dir vs the user's choice
   each call vs OneDrive-style synced folder (the `export_preset` precedent used a
   local dir + `directory` override; MCP can't create chat artifacts).
3. **Full-pack one-shot vs per-file**: replay the `Get Pack` dump as one stream
   (faster, matches Components) vs loop per-slot `downloadProject`-style reads
   (simpler, reuses proven code). Lean per-file for projects (proven) + decode
   per-file for samples/patchbanks; revisit one-shot if too slow.
4. **MCP tool surface**: one `export`/`import` verb with a `scope` (project | pack)
   vs separate tools. Prefer the unified surface (a `backup`/`restore` pair with
   scope), consistent with the project's "adding a device is a descriptor, not a
   tool" ethos.
5. **Restore safety**: restoring overwrites slots; restore itself should honor the
   overwrite gate (and could back up first), so restore is also reversible.

## Phasing

1. ~~Tier 1 (project export + backup-before-overwrite on `upload_project` +
   `apply_pattern ncs_upload`).~~ **SHIPPED.** Resolved open questions: Q1 default
   ON for projects; Q4 reuse `export_preset` for read but `upload_project` (not
   `import_preset`) for restore.
2. Decode sample READ (unblocks sample backup + a directory-name read, which also
   resolves the "read what samples I have" gap).
3. Decode patchbank READ → `export_pack` / `import_pack`.
