#!/bin/bash
cd "$(dirname "$0")" || exit 1
SRC="$PWD/QuickMediaPaste"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.quickmediapaste"

if [ ! -f "$SRC/CSXS/manifest.xml" ]; then
  echo "ERROR: QuickMediaPaste folder not found next to this script."
  exit 1
fi

echo "Make sure Premiere Pro is closed, then press Return."
read -r _

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -R "$SRC" "$DEST" || { echo "ERROR: copy failed."; exit 1; }

# Unsigned extensions only load when CEP debug mode is on (CSXS.11 = Premiere 2022-2024, CSXS.12 = 2025+).
for v in 9 10 11 12 13 14 15 16; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done
killall cfprefsd 2>/dev/null || true

echo
echo "Installed to: $DEST"
echo "Open Premiere Pro, then Window > Extensions > QuickMediaPaste"
