# QuickMediaPaste

**Developed by Yusam.** Open source under the MIT license. Contributions are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md).

Paste images, video, audio, links, color codes and text straight onto the active **Adobe Premiere Pro** timeline, at the playhead. Copy something, press paste, done.

[العربية](docs/README_AR.md)

> **Status: beta (v1.15.1).** Tested on **Premiere Pro 25.1 on Windows**. macOS and other Premiere versions are untested: reports are very welcome. If Premiere ever stops during a paste, reopen the panel: it prints the last step from `qmp_trace.log`. Please include that line in your bug report.

## Features
- Paste images, screenshots, video, audio, PSD/AI, folders (sorted naturally), MOGRT and After Effects projects.
- Direct media links are downloaded and pasted.
- HEIC, AVIF, SVG, WebP, RAW and PDF are converted to PNG automatically. WebM/MKV/OGG are converted with ffmpeg if it is installed.
- **Color codes become mattes:** `#ff0000`, `rgb()`, `hsl()`, CSS gradients, and also `ff0000`, `255, 0, 0`, `red`.
- **Text becomes a title** (transparent PNG) with your own font, size, color and position. Works with Arabic (RTL). Optionally choose your own `.mogrt` template and the text becomes an editable Essential Graphics title.
- Auto-paste as soon as you copy, global Ctrl+V on the timeline (Windows), copy the current frame, configurable shortcuts.
- **Prepare on copy:** copied files and images are saved in the background, so the paste that follows is instant.
- Overwrite (free track, nothing erased) or Insert (ripple) placement. Audio always goes to a free track.
- Files and project bins are sorted by type (Images, Video, Audio, Graphics).

## Install
1. Close Premiere Pro.
2. **Windows:** run `install-windows.bat`. **macOS:** right-click `install-mac.command`, Open.
3. Open Premiere, then **Window > Extensions > QuickMediaPaste**.

Supports Premiere Pro 2022 and later (CEP 11+). Uninstall with the matching `uninstall-*` script.

## Security and privacy, please read
This extension is **unsigned**, so the installer turns on CEP `PlayerDebugMode` for your user account (registry on Windows, `defaults` on macOS). The uninstall script asks whether to turn it off again.

The panel runs with Node.js enabled, so it has the same OS permissions as Premiere Pro itself. It reads your clipboard, writes files next to your project in `_PastedMedia`, downloads media URLs you copy, and may run external tools (PowerShell, ffmpeg, ImageMagick, sips) for conversions. On Windows, `hotkey.ps1` installs a low-level keyboard hook that only watches the paste shortcut and only acts while Premiere is the foreground app. Some antivirus tools may flag this behavior. The source is all here, so you can review it.

## Notes
- This is a community project, not made by or affiliated with Adobe. Premiere Pro is a trademark of Adobe.
- Without a `.mogrt` template the title is a PNG image, because CEP scripts cannot create text layers directly.
- The panel must be open (a background tab is fine) for auto-paste and the global shortcut.
- If something is pasted by mistake, press Ctrl+Z in Premiere.
- Full usage notes and history: [docs/README_AR.md](docs/README_AR.md) (Arabic), [CHANGELOG.md](CHANGELOG.md). Security: [SECURITY.md](SECURITY.md).

## Reporting problems
If something breaks, please open an issue with the log (Show details > Copy log), your Premiere version, and OS.

## License
[MIT](LICENSE)
