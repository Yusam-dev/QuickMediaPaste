#!/bin/bash
rm -rf "$HOME/Library/Application Support/Adobe/CEP/extensions/com.quickmediapaste"
echo "QuickMediaPaste removed."
echo
echo "The installer turned on CEP debug mode so unsigned extensions can load."
read -r -p "Turn it off again? Answer n if you use other unsigned Premiere extensions. [y/N] " ans
case "$ans" in
  [yY]*)
    for v in 9 10 11 12 13 14 15 16; do defaults delete "com.adobe.CSXS.$v" PlayerDebugMode 2>/dev/null; done
    killall cfprefsd 2>/dev/null || true
    echo "CEP debug mode turned off." ;;
  *) echo "CEP debug mode left as is." ;;
esac
