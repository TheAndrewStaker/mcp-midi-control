# Editor driver (AM4-Edit / Axe-Edit read-back)

Checks what the device holds against what the Fractal editor shows, without
anyone taking screenshots.

## The stack (researched and measured 2026-11-26)

| Layer | Tool | Why |
|---|---|---|
| Read the editor | `uia.ps1` (Windows UI Automation, built into PowerShell) | JUCE exposes every widget: each slider's label, the exact text it shows ("5.29", "1500.0 Hz") and its position 0..10, which is 10 x the register `get_param` returns. Dropdowns, tabs, channel buttons and the chain blocks are all there. No OCR, ~0.6 s per page. |
| Audit our decode | `audit-am4.ts` | Decodes each slider position through the catalog and compares with the editor's text; checks dropdown text against our roster. No MIDI traffic. |
| Pictures | `editor.py shot` (PrintWindow, PW_RENDERFULLCONTENT) | The window's own rendering, no focus change, works while covered. Not while minimized. |
| Fallback text | `editor.py ocr` (Windows.Media.Ocr via `ocr.ps1`) | Only for apps without UI Automation. |
| Isolation | `bench.py` (hidden Win32 desktop) | Pilot. See "Focus" below. |

Nothing to install: Pillow and the Windows built-ins only. The Python UIA
wrappers (pywinauto, uiautomation) add dependencies for no gain here.

```
powershell -File uia.ps1 "block Amp; press Speaker; read"   # JSON of the page
npx tsx scripts/_research/editor-driver/audit-am4.ts --blocks Amp,Reverb --all-tabs
python editor.py shot out.png                               # picture, no focus change
```

## Things learned the hard way

- **Focus.** UI Automation READS never take focus. Every ACTION (Invoke,
  Toggle, Select: pressing a tab, selecting a block) brings a JUCE editor to
  the front, because JUCE grabs keyboard focus. Posted mouse messages
  (PostMessage) do not take focus. AM4-Edit ignores them; **Axe-Edit accepts
  them** (`postclick.py <title> <x> <y>`, client coordinates via ScreenToClient)
  as long as the window is not minimized and the coordinates were read from the
  restored window (a minimized window reports stale rects, and UIA skips its
  offscreen controls). So Axe-Edit can be driven with no focus change at all:
  select a block through UIA (that one action may raise it), switch pages with
  posted clicks, read through UIA. For AM4-Edit, run while the owner is away or
  put the editor on a hidden Win32 desktop (`bench.py`).
- **Pick the window by title.** JUCE editors own drop-shadow windows, and
  `Process.MainWindowHandle` can be one of them (Axe-Edit), which yields an
  empty tree. `uia.ps1` uses FindWindow on the exact title first.
- **Axe-Edit layout.** Each knob is a `Slider` named `Label: value[, Modifier
  ...]` with no position; page tabs are unnamed-pattern `Custom` elements about
  111x36 left of the page; the grid is `RadioButton`s named `Grid row r column
  c: Amp 1A, Active`. `audit-ii.ts dump` walks every block and page.
- **The II needs no editor to check a decode.** Its fn 0x02 GET reply carries
  the device's own display text, identical to what Axe-Edit shows (checked on
  all 8 Amp pages). `scripts/_research/ii-label-sweep.ts` reads that text for
  every param of every stored preset; `ii-label-score.ts` scores the decode.
- **Never press Bypass.** The block's Bypass switch is the same size as a tab; pressing it sends a bypass request (it caused the 2026-11-26 stall). `uia.ps1` skips it from `tabs` and refuses `press Bypass`; `read` reports it as `bypassed`.
- **Dropdown lists** open as an overlay UI Automation cannot see. Set the
  value over MIDI (MCP tools) and read the result instead.
- **The editor can stall silently.** A request the device did not answer
  (2026-11-26: "Communication time-out ... Bypass Block") raises a modal
  dialog; until it is dismissed the editor shows "Connected!" but stops
  updating (its CPU readout freezes). Check that the CPU text changes before
  trusting a page; a page of empty values is the same symptom.
- After closing a stalled editor, its process can linger without a window and
  keep the device ("in use by another Fractal Audio application"): end it in
  Task Manager.
- Selecting a block is not passive: with amp DynaMatch On it makes the AM4
  reset the speaker-curve knobs.
- Hidden controls stay in the tree with empty text; `read` skips off-screen
  ones.

Window positions (only for `editor.py click`, which takes focus): amp tabs at
y=136 (Expert 468, Preamp 623, Power Amp 778, Cabinet 932, Speaker 1087);
chain blocks at y=362, x = 99 / 165 / 231 / 298 for slots 1-4.
