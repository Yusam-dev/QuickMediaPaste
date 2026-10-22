#!/usr/bin/env node
/* QuickMediaPaste dev check: node tools/check.js  (no dependencies) */
'use strict';
var fs = require('fs'), path = require('path'), cp = require('child_process');
var root = path.join(__dirname, '..');
var ext = path.join(root, 'QuickMediaPaste');
var failed = 0;
function ok(m) { console.log('  ok   ' + m); }
function bad(m) { failed++; console.log('  FAIL ' + m); }
function read(p) { return fs.readFileSync(p, 'utf8'); }

console.log('main.js syntax');
var r = cp.spawnSync(process.execPath, ['--check', path.join(ext, 'main.js')], { encoding: 'utf8' });
r.status === 0 ? ok('parses') : bad(r.stderr.trim());

console.log('hostscript.jsx (ExtendScript is ES3)');
var jsx = read(path.join(ext, 'hostscript.jsx'));
var tmp = path.join(require('os').tmpdir(), 'qmp_check_host.js');
fs.writeFileSync(tmp, jsx);
r = cp.spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
r.status === 0 ? ok('parses') : bad(r.stderr.trim());
fs.unlinkSync(tmp);
var es6 = [[/\b(let|const)\s+[\w$]+\s*=/, 'let/const'], [/=>/, 'arrow function'], [/`/, 'template literal'], [/\.(includes|startsWith|endsWith|padStart)\(/, 'ES6 string/array method']];
var stripped = jsx.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, '""');
es6.forEach(function (t) { t[0].test(stripped) ? bad('ES6+ syntax in hostscript.jsx: ' + t[1]) : ok('no ' + t[1]); });
/[^\x00-\x7f]/.test(jsx) ? bad('hostscript.jsx must stay ASCII-only') : ok('ASCII-only');

console.log('versions');
var man = read(path.join(ext, 'CSXS', 'manifest.xml'));
var mv = (man.match(/ExtensionBundleVersion="([^"]+)"/) || [])[1];
var ev = (man.match(/<Extension Id="[^"]+" Version="([^"]+)"/) || [])[1];
var hv = (jsx.match(/QMP_VERSION = '([^']+)'/) || [])[1];
var cv = (read(path.join(root, 'CHANGELOG.md')).match(/^## (\d+\.\d+\.\d+)/m) || [])[1];
[['bundle', mv], ['extension', ev], ['hostscript', hv], ['changelog', cv]].forEach(function (p) {
  p[1] === mv ? ok(p[0] + ' ' + p[1]) : bad(p[0] + ' is ' + p[1] + ', manifest says ' + mv);
});

console.log('files');
['index.html', 'main.js', 'hostscript.jsx', 'hotkey.ps1', 'CSXS/manifest.xml'].forEach(function (f) {
  fs.existsSync(path.join(ext, f)) ? ok(f) : bad('missing ' + f);
});

console.log(failed ? '\n' + failed + ' problem(s).' : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
