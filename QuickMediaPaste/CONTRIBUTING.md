# Contributing

Issues and pull requests are welcome.

- The panel is plain JavaScript (no build step, no npm dependencies): `QuickMediaPaste/main.js`, `index.html`, and the ExtendScript host file `hostscript.jsx`.
- Windows only: `hotkey.ps1` is the global Ctrl+V helper.
- To test, copy `QuickMediaPaste/` into your CEP extensions folder (see `install-*` scripts) and reload the panel.
- When reporting a bug, include your Premiere Pro version, your OS, and the log (Show details > Copy log).
- Keep new UI strings in both English and Arabic (see the translation table in `main.js`).
- Before sending a change run `node tools/check.js` (syntax, ES3 check for `hostscript.jsx`, version sync).
