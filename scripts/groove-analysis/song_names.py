"""
Display names for the groove-pack song folders.

MixWave ships the grooves anonymized (Song 01-10, by BPM) for licensing, and the
MIDI files carry no titles, so the default label is simply the folder's song
number. To use your own labels (pattern naming, catalog display), create
`song_names_local.py` beside this file exporting a `SONG_NAMES` dict with the
same keys; it is local only, never tracked, and overrides these defaults.
"""

SONG_NAMES = {
    "Song 01 (110 BPM)": "Song 01",
    "Song 02 (135 BPM)": "Song 02",
    "Song 03 (170 BPM)": "Song 03",
    "Song 04 (170 BPM)": "Song 04",
    "Song 05 (150 BPM)": "Song 05",
    "Song 06 (120 BPM)": "Song 06",
    "Song 07 (120 BPM)": "Song 07",
    "Song 08 (135 BPM)": "Song 08",
    "Song 09 (160 BPM)": "Song 09",
    "Song 10 (160 BPM)": "Song 10",
}

try:
    from song_names_local import SONG_NAMES as _LOCAL_SONG_NAMES
    SONG_NAMES.update(_LOCAL_SONG_NAMES)
except ImportError:
    pass


def name_for(folder: str) -> str:
    """folder may be 'Song 03 (170 BPM)' or a path ending in it."""
    import os
    key = os.path.basename(folder.rstrip("/\\"))
    return SONG_NAMES.get(key, key)
