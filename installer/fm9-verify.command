#!/bin/bash
# MCP MIDI Control - FM9 WRITE-VERIFY probe (SAFE: never saves).
#
# Connects to a plugged-in FM9 over USB MIDI and runs each shipped write op
# (set a knob, set a model, place a block, switch scene, bypass) against the
# LOADED preset, reading each one back to confirm the device applied it. It
# NEVER saves, and it RELOADS your preset at the end to discard every change,
# so your FM9 ends exactly where it started. Quit FM9-Edit first so it isn't
# holding the MIDI port.
#
# Double-click in Finder, or run `bash fm9-verify.command` in Terminal.
# Hand the resulting JSON file back to the maintainer.

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS .pkg from https://nodejs.org, then re-run."
  read -r -p "Press Return to close." _ || true
  exit 1
fi

ENTRY="node_modules/@mcp-midi-control/server-all/dist/cli/gen3-verify-probe.js"
[ -f "$ENTRY" ] || ENTRY="packages/server-all/dist/cli/gen3-verify-probe.js"
[ -f "$ENTRY" ] || ENTRY="../packages/server-all/dist/cli/gen3-verify-probe.js"
[ -f "$ENTRY" ] || ENTRY="dist/cli/gen3-verify-probe.js"

if [ ! -f "$ENTRY" ]; then
  echo "gen3-verify-probe.js not found. Run the macOS setup (or 'npm install') first."
  read -r -p "Press Return to close." _ || true
  exit 1
fi

OUT="$HOME/Desktop/fm9-verify-output.json"

echo
echo "Running the FM9 WRITE-VERIFY probe."
echo "SAFE: it never saves, and it reloads your preset at the end to discard changes."
echo "Make sure your FM9 is connected and FM9-Edit is closed."
echo

node "$ENTRY" fm9 "$OUT"
RC=$?

echo
if [ "$RC" = "0" ]; then
  echo "Done. Please attach this file to a new GitHub issue:"
  echo "  $OUT"
else
  echo "The probe could not reach the FM9. See the messages above."
fi
echo
read -r -p "Press Return to close." _ || true
exit $RC
