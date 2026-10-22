# Security policy

## What this extension can do
QuickMediaPaste is an **unsigned** Adobe CEP panel with Node.js enabled, so it runs with the same OS permissions as Premiere Pro. It:
- reads the clipboard (PowerShell on Windows, osascript on macOS);
- writes files next to your project in `_PastedMedia`;
- downloads URLs you copy (http/https only);
- may run external tools you installed (ffmpeg, ImageMagick, sips, PowerShell);
- on Windows, runs `hotkey.ps1`, a low-level keyboard hook that only reacts to the paste and frame shortcuts while Premiere is the foreground app.

The installer turns on CEP `PlayerDebugMode` for your user account. The uninstall script offers to turn it off again.

## Check it yourself
There is no build step and no dependencies. Everything that runs is in `QuickMediaPaste/` (`main.js`, `hostscript.jsx`, `hotkey.ps1`, `index.html`). Only install releases from this repository and compare against the source. Run `node tools/check.js` for a basic consistency check.

## Reporting a vulnerability
Please do **not** open a public issue for a security problem. Use GitHub's private "Report a vulnerability" option on the Security tab of this repository. Include the version, your OS, and the steps to reproduce. You will get an answer as soon as the maintainer can.
