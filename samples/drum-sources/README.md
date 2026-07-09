# Drum / instrument sample sources

Audio test sources for the SPD-SX / Circuit Tracks sample work. The **audio is
local-only** (gitignored: these libraries are large and commercially licensed).
Only this `README.md` and `manifest.json` are committed, so the tree can always
be rebuilt after a delete. `manifest.json` is the registry of which sources exist.

> History: an earlier loose **Invasion** download
> (`C:/Users/Steph/Downloads/Invasion/`) was deleted ~2026-06-13 and is not in the
> Recycle Bin. It was re-installed cleanly via **Native Access** on 2026-06-20.

## These are Kontakt libraries, not loose WAVs

All current sources are **Native Instruments Kontakt Player libraries** installed
via Native Access (this corrects an earlier note in this repo: Invasion *is*
delivered through Native Access). They live under
`C:/Users/Public/Documents/<Library>/` and ship as **encrypted `.nkx`/`.nkc`/
`.nkr` monoliths**: you **cannot** `ffmpeg` them directly. To get WAVs you must
**render ("bounce") them out of Kontakt 8**, then run the converter on the WAVs.

Runtime + installed sources (all verified complete 2026-06-20):

| label                       | vendor          | install path                                   | size   |
| --------------------------- | --------------- | ---------------------------------------------- | ------ |
| _runtime_ Kontakt 8 Player  | NI              | `Program Files/Native Instruments/Kontakt 8`   | 1.2 GB |
| `invasion`                  | GetGood Drums   | `Public/Documents/Invasion`                    | 16 GB  |
| `kinetic-treats`            | NI Play Series  | `Public/Documents/Kinetic Treats Library`      | 413 MB |
| `kontakt-factory-selection` | NI              | `Public/Documents/Kontakt Factory Selection Library` | 631 MB |
| `play-series-selection`     | NI              | `Public/Documents/Play Series Selection Library` | 1.7 GB |
| `sleep-token-ii` (planned)  | Mixwave         | not yet purchased                              | n/a    |

See `manifest.json` for per-source detail (versions, kit/snapshot names, bounce notes).

## Layout

```
samples/drum-sources/
  README.md            # committed
  manifest.json        # committed, source registry
  <label>/
    raw/               # WAVs rendered ("bounced") out of Kontakt (local-only)
    spdsx/             # 44.1kHz/16-bit/stereo PCM, ready for SPD-SX (generated)
```

## Workflow: Kontakt → bounce → SPD-SX / Circuit Tracks

1. **Open** the library in **Kontakt 8** (`Kontakt 8.exe`, or the VST3 in a DAW).
2. **Render ("bounce")** the pads/articulations/instruments you want to WAV into
   `samples/drum-sources/<label>/raw/` (any subfolder layout, it's preserved).
   This is the one manual step: Kontakt monoliths are encrypted, so audio has to
   come out through Kontakt's audio engine (play/render each pad, or export from
   your DAW).
3. **Convert** to SPD-SX format:

   ```bash
   npm run samples:to-spdsx -- invasion
   # custom source, or re-run forcing overwrite:
   npm run samples:to-spdsx -- invasion --src "D:/bounces/invasion" --force
   # preview without writing:
   npm run samples:to-spdsx -- invasion --dry-run
   ```

   Output lands in `samples/drum-sources/<label>/spdsx/` (44.1kHz/16-bit/stereo),
   with a `_convert.log`. Re-runs are idempotent (skips up-to-date files unless
   `--force`). Files that fail are retried automatically with metadata stripped.
4. **Load** the `spdsx/` tree onto the SPD-SX, or feed it into the Circuit Tracks
   pack tooling.

The converter is `scripts/bounce-to-spdsx.ts`. Flags: `--src --out --rate
--bits --channels --force --dry-run`.

## Licensing / machine limits

These are NI/Kontakt Player libraries, so they're governed by Native Instruments'
account activation policy (managed in Native Access), not a per-machine file
license. If activation on this second machine is ever blocked, it's an NI-account
limit to resolve in Native Access, not something the repo controls.
