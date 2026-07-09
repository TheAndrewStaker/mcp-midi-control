"""
User-assigned song names for the Sleep Token II groove-pack folders.

MixWave ships the grooves anonymized (Song 01-10, by BPM) for licensing, and the
MIDI files carry no titles. These are the user's chosen labels for our own use
(pattern naming, catalog display); not an official MixWave mapping.
"""

SONG_NAMES = {
    "Song 01 (110 BPM)": "The Summoning",
    "Song 02 (135 BPM)": "Granite",
    "Song 03 (170 BPM)": "The Offering",
    "Song 04 (170 BPM)": "Take Me Back To Eden",
    "Song 05 (150 BPM)": "Aqua Regia",
    "Song 06 (120 BPM)": "Ascensionism",
    "Song 07 (120 BPM)": "Hypnosis",
    "Song 08 (135 BPM)": "Chokehold",
    "Song 09 (160 BPM)": "Vore",
    "Song 10 (160 BPM)": "Rain",
}


def name_for(folder: str) -> str:
    """folder may be 'Song 03 (170 BPM)' or a path ending in it."""
    import os
    key = os.path.basename(folder.rstrip("/\\"))
    return SONG_NAMES.get(key, key)
