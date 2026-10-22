# Changelog

## 1.15.1
- **Fixed a Premiere Pro crash with audio.** The crash trace showed Premiere 25.1 dying inside `insertClip` on an audio track. Audio is no longer inserted: it goes to the first free audio track at the playhead (the existing occupied-track check still applies, so nothing is overwritten). Insert mode is unchanged for video and images.

## 1.15.0
- **Editable text (optional):** choose your own `.mogrt` title template in Settings. Copied text is then placed as an Essential Graphics title and its first text field is filled with the copied text. Without a template, text still becomes a transparent title image as before. If the field cannot be filled, the template is still placed and the result says so.
- **Crash trace for audio:** the host script writes the step it is about to do to `qmp_trace.log` (OS temp folder) before every import and placement. If Premiere dies during a paste, the next start of the panel prints the last step. Please send that line.
- **Detailed timing line** in the log: clipboard (and which reader: worker or slow PowerShell), Premiere context, file preparation, time before Premiere, time placing inside Premiere. Use it to see where a slow paste loses its time.
- Audio-only items now read their length with the explicit audio range first.

## 1.14.0 (speed)
- **Big files no longer wait for a copy.** Files over 16 MB are cloned (copy-on-write, APFS/ReFS) or hard-linked (same volume) into `_PastedMedia` in an instant, with no extra disk space; it only falls back to a real copy across drives or on unsupported file systems. Note: a hard link shares the data with the original, so editing the original file in place also changes the project copy.
- **First paste of a session is fast too:** the working time-argument form is remembered per Premiere version and verified on use (falls back to the careful method if it does not land).
- Track state is read once per paste, not once per item (folders and multi-file pastes).
- The done message shows how long the paste took.

## 1.13.0 (speed and order)
- **Paste time no longer grows.** Before, every paste (and every prepare-on-copy) walked the whole QuickMediaPaste bin asking Premiere for each item's path, so it got slower with every paste. Now the bin is indexed once per Premiere session and a path -> item cache is kept; only new files are imported, one `importFiles` call per bin. If anything looks wrong it falls back to the old careful method.
- **Track search is lazy:** tracks are checked one at a time and the first free one is used, instead of reading every track first.
- The writable-folder test file is no longer written on every paste.
- **Organized storage (new switch, on by default):** files go to `_PastedMedia/Images`, `Video`, `Audio`, `Graphics` (titles and mattes) and `Templates`, and the project bin gets sub-bins with the same names. Turn the switch off for the old flat layout.

## 1.12.0
- **Downloads retry automatically** on dropped connections, timeouts, HTTP 408/425/429 and 5xx (2 retries, growing wait). User cancel and real errors (404, a web page instead of a file) still fail at once.
- **Leftover cleanup:** `.qmp_*.part` downloads older than 1 hour in `_PastedMedia` and `qmp_*` temp files older than 1 day in the OS temp folder are removed in the background, once per session.
- **Uninstall can turn CEP debug mode off** (it asks first; default is to leave it on).
- New `tools/check.js`: syntax check of `main.js`, ES3 check of `hostscript.jsx`, and a version-sync check across manifest, host script and changelog.
- Docs refreshed.

## 1.11.0
- Prepare on copy now also imports the media into the Premiere project (the slowest step), so a paste only places the clip.
  If the copy is never pasted, the item is removed again when Premiere supports it (deleteAsset); otherwise it stays in the
  QuickMediaPaste bin together with its file.
- Every paste logs a timing line ("Timing: X ms before Premiere, Y ms placing") so you can see where the time goes.

## 1.10.0 (workflow: instant paste)
- **Prepare on copy** (new switch, on by default): when you copy files or an image, the panel saves them next to the
  project in the background. When you then paste, only the placement in Premiere is left, so the paste feels instant.
  If you paste while it is still working, the paste waits for it instead of starting over. Copy something else and the
  unused prepared files are deleted. Limits: files and clipboard images only (not links, text or colors), up to 1 GB.
- Auto-paste: the project check now runs while the clipboard is being read, and the fixed 200 ms wait was replaced by an
  80 ms wait with a retry only if the clipboard is still empty.
- Premiere side: after the first correct placement in a session, Overwrite uses a fast path that looks for the new clip
  near the playhead instead of scanning the whole track twice (falls back to the careful method if anything looks off).

## 1.9.0 (speed)
- The clipboard is read while Premiere answers the project check (they ran one after the other before).
- Auto-paste of a copied image no longer reads the clipboard twice.
- Several items are prepared at the same time (3 at once, order kept): copies, downloads, conversions.
- Faster file copy: native copy for files up to 16 MB, 4 MB chunks for bigger ones (was 64 KB).
- Premiere side: all new files are imported with one importFiles call, and the QuickMediaPaste bin is
  scanned once per paste instead of once per file (it grew with every paste and slowed things down).
- Cheaper track checks: fewer Premiere API calls when looking for a free track and for the new clip.
- Clipboard watcher polls every 200 ms instead of 350 ms (Windows).

## 1.8.0
- Title style settings: font, size (% of frame height), text color, position (center / bottom like a subtitle / top), bold, shadow.
- More color inputs: `ff0000`, `255, 0, 0`, CSS color names, Arabic color names, also inside gradients.
  Names and bare hex are only accepted on a manual paste, not by auto-paste.

## 1.7.0
- Auto-paste for color codes (as a matte) and copied text (as a title).

## 1.6.0
- Paste folders, MOGRT, HEIC/AVIF/SVG/WebP/RAW/PDF conversion, color mattes and gradients, text titles.
- Global Ctrl+V on the timeline (Windows), configurable shortcuts, image size modes.

## 1.5.0 and earlier
- Auto-paste on copy, track picker, image duration, recent items, drag and drop, persistent settings.
