/*
 * QuickMediaPaste - hostscript.jsx
 *
 * Premiere Pro ExtendScript (ES3) controller. Loaded automatically through <ScriptPath>
 * in the manifest. main.js calls the QMP_* functions through CSInterface evalScript.
 *
 * Every public function:
 *   - receives one URI-encoded JSON string,
 *   - never throws (everything is wrapped in try/catch),
 *   - returns a JSON string with { ok: boolean, error?: string, log: string[], ... }.
 *
 * ExtendScript has no native JSON object, so a small, strict parser and serializer
 * (QMP_JSON) is included. The source is kept ASCII-only on purpose.
 */

var QMP_VERSION = '1.15.1';
var QMP_TICKS_PER_SECOND = 254016000000;
var QMP_DEFAULT_STILL_SECONDS = 5;

/* ------------------------------------------------------------------ */
/* Media type table (extension -> kind)                                */
/* ------------------------------------------------------------------ */

var QMP_EXT_KIND = (function () {
    var map = {};
    var groups = {
        video: ['mp4', 'm4v', 'mov', 'avi', 'mxf', 'mpg', 'mpeg', 'mpe', 'm2v', 'm2t', 'm2ts', 'mts', 'ts',
            'wmv', 'asf', 'flv', 'f4v', 'webm', 'mkv', '3gp', '3g2', 'r3d', 'braw', 'ari', 'dv', 'vob', 'ogv'],
        audio: ['wav', 'mp3', 'aif', 'aiff', 'aifc', 'aac', 'm4a', 'flac', 'ogg', 'oga', 'opus', 'wma', 'caf',
            'ac3', 'mp2', 'bwf'],
        image: ['png', 'jpg', 'jpeg', 'jpe', 'gif', 'bmp', 'dib', 'tif', 'tiff', 'psd', 'ai', 'eps', 'tga', 'exr',
            'dpx', 'cin', 'hdr', 'jp2', 'j2k', 'pict', 'ico'],
        mogrt: ['mogrt'],
        aep: ['aep']
    };
    for (var kind in groups) {
        if (groups.hasOwnProperty(kind)) {
            for (var i = 0; i < groups[kind].length; i++) {
                map[groups[kind][i]] = kind;
            }
        }
    }
    return map;
})();

/* ------------------------------------------------------------------ */
/* JSON (strict parser + serializer)                                   */
/* ------------------------------------------------------------------ */

var QMP_JSON = (function () {
    function pad4(h) {
        while (h.length < 4) { h = '0' + h; }
        return h;
    }

    function quote(s) {
        var out = '"';
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i);
            var code = s.charCodeAt(i);
            if (c === '"') { out += '\\"'; }
            else if (c === '\\') { out += '\\\\'; }
            else if (c === '\n') { out += '\\n'; }
            else if (c === '\r') { out += '\\r'; }
            else if (c === '\t') { out += '\\t'; }
            else if (c === '\b') { out += '\\b'; }
            else if (c === '\f') { out += '\\f'; }
            else if (code < 32 || code > 126) { out += '\\u' + pad4(code.toString(16)); }
            else { out += c; }
        }
        return out + '"';
    }

    function isArray(v) {
        return Object.prototype.toString.call(v) === '[object Array]';
    }

    function stringify(v, depth) {
        depth = depth || 0;
        if (depth > 20) { return 'null'; }
        if (v === null || v === undefined) { return 'null'; }
        var t = typeof v;
        if (t === 'string') { return quote(v); }
        if (t === 'number') { return isFinite(v) ? String(v) : 'null'; }
        if (t === 'boolean') { return v ? 'true' : 'false'; }
        if (isArray(v)) {
            var parts = [];
            for (var i = 0; i < v.length; i++) { parts.push(stringify(v[i], depth + 1)); }
            return '[' + parts.join(',') + ']';
        }
        if (t === 'object') {
            var props = [];
            for (var k in v) {
                if (v.hasOwnProperty(k) && typeof v[k] !== 'function' && v[k] !== undefined) {
                    props.push(quote(String(k)) + ':' + stringify(v[k], depth + 1));
                }
            }
            return '{' + props.join(',') + '}';
        }
        return 'null';
    }

    function parse(text) {
        var s = String(text);
        var n = s.length;
        var i = 0;

        function fail(msg) { throw new Error('JSON parse error at ' + i + ': ' + msg); }

        function skipWs() {
            while (i < n) {
                var c = s.charAt(i);
                if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; } else { break; }
            }
        }

        function parseString() {
            i++;
            var out = '';
            while (true) {
                if (i >= n) { fail('unterminated string'); }
                var c = s.charAt(i++);
                if (c === '"') { return out; }
                if (c === '\\') {
                    var e = s.charAt(i++);
                    if (e === 'n') { out += '\n'; }
                    else if (e === 'r') { out += '\r'; }
                    else if (e === 't') { out += '\t'; }
                    else if (e === 'b') { out += '\b'; }
                    else if (e === 'f') { out += '\f'; }
                    else if (e === '"') { out += '"'; }
                    else if (e === '\\') { out += '\\'; }
                    else if (e === '/') { out += '/'; }
                    else if (e === 'u') {
                        var hex = s.substr(i, 4);
                        if (!/^[0-9a-fA-F]{4}$/.test(hex)) { fail('bad unicode escape'); }
                        out += String.fromCharCode(parseInt(hex, 16));
                        i += 4;
                    } else { fail('bad escape'); }
                } else {
                    out += c;
                }
            }
        }

        function parseNumber() {
            var m = /^-?\d+(\.\d+)?([eE][+\-]?\d+)?/.exec(s.substring(i));
            if (!m) { fail('unexpected token'); }
            i += m[0].length;
            return Number(m[0]);
        }

        function parseArray(depth) {
            i++;
            var arr = [];
            skipWs();
            if (s.charAt(i) === ']') { i++; return arr; }
            while (true) {
                arr.push(parseValue(depth + 1));
                skipWs();
                var c = s.charAt(i++);
                if (c === ',') { continue; }
                if (c === ']') { return arr; }
                fail('expected , or ]');
            }
        }

        function parseObject(depth) {
            i++;
            var obj = {};
            skipWs();
            if (s.charAt(i) === '}') { i++; return obj; }
            while (true) {
                skipWs();
                if (s.charAt(i) !== '"') { fail('expected string key'); }
                var key = parseString();
                skipWs();
                if (s.charAt(i++) !== ':') { fail('expected :'); }
                obj[key] = parseValue(depth + 1);
                skipWs();
                var c = s.charAt(i++);
                if (c === ',') { continue; }
                if (c === '}') { return obj; }
                fail('expected , or }');
            }
        }

        function parseValue(depth) {
            if (depth > 50) { fail('nesting too deep'); }
            skipWs();
            if (i >= n) { fail('unexpected end of input'); }
            var c = s.charAt(i);
            if (c === '{') { return parseObject(depth); }
            if (c === '[') { return parseArray(depth); }
            if (c === '"') { return parseString(); }
            if (s.substr(i, 4) === 'true') { i += 4; return true; }
            if (s.substr(i, 5) === 'false') { i += 5; return false; }
            if (s.substr(i, 4) === 'null') { i += 4; return null; }
            return parseNumber();
        }

        var value = parseValue(0);
        skipWs();
        if (i !== n) { fail('unexpected trailing characters'); }
        return value;
    }

    return { stringify: stringify, parse: parse };
})();

/* ------------------------------------------------------------------ */
/* Generic helpers                                                     */
/* ------------------------------------------------------------------ */

function QMP_errText(e) {
    var msg = (e && e.message) ? String(e.message) : String(e);
    if (e && e.line) { msg += ' (hostscript line ' + e.line + ')'; }
    return msg;
}

function QMP_safe(fn, fallback) {
    try {
        var v = fn();
        return (v === undefined || v === null) ? fallback : v;
    } catch (e) {
        return fallback;
    }
}

function QMP_num(v) {
    var n = Number(v);
    return isNaN(n) ? 0 : n;
}

function QMP_ticksString(n) {
    return Math.round(n).toFixed(0);
}

function QMP_makeTime(ticks) {
    var t = new Time();
    t.ticks = QMP_ticksString(ticks);
    return t;
}

function QMP_extOf(p) {
    var m = /\.([A-Za-z0-9]+)$/.exec(String(p));
    return m ? m[1].toLowerCase() : '';
}

function QMP_fileFromNative(p) {
    var s = String(p).replace(/\\/g, '/').replace(/%/g, '%25');
    return new File(s);
}

function QMP_normPath(p) {
    var s = String(p).replace(/\\/g, '/');
    if (Folder.fs === 'Windows') { s = s.toLowerCase(); }
    return s;
}

function QMP_trackLabel(kind, index) {
    return (kind === 'audio' ? 'A' : 'V') + (index + 1);
}

function QMP_decodeRequest(encoded) {
    var text = decodeURIComponent(String(encoded));
    var req = QMP_JSON.parse(text);
    if (!req || typeof req !== 'object') { throw new Error('Request payload is not an object.'); }
    return req;
}

function QMP_makeLogger(logs) {
    return function (msg) {
        logs.push(String(msg));
        try { $.writeln('[QMP] ' + msg); } catch (e) { /* console not available */ }
    };
}

function QMP_notifyPremiere(message, level) {
    try {
        if (app && typeof app.setSDKEventMessage === 'function') {
            app.setSDKEventMessage('QuickMediaPaste: ' + message, level || 'info');
        }
    } catch (e) { /* Events panel not available */ }
}

/* ------------------------------------------------------------------ */
/* Project, bin and project-item helpers                               */
/* ------------------------------------------------------------------ */

function QMP_itemTypeBin() {
    return (typeof ProjectItemType !== 'undefined' && ProjectItemType.BIN !== undefined) ? ProjectItemType.BIN : 2;
}

function QMP_ensureBin(project, name) {
    return QMP_ensureBinIn(project.rootItem, name);
}

function QMP_ensureBinIn(root, name) {
    var binType = QMP_itemTypeBin();
    var i;
    for (i = 0; i < root.children.numItems; i++) {
        var child = root.children[i];
        if (child && child.type === binType && child.name === name) { return child; }
    }
    var created = null;
    try { created = root.createBin(name); } catch (e) { created = null; }
    if (created && typeof created === 'object') { return created; }
    for (i = 0; i < root.children.numItems; i++) {
        var again = root.children[i];
        if (again && again.type === binType && again.name === name) { return again; }
    }
    return root;
}

function QMP_findItemByPath(container, nativePath, depth) {
    depth = depth || 0;
    if (depth > 30) { return null; }
    var wanted = QMP_normPath(nativePath);
    var binType = QMP_itemTypeBin();
    var n = QMP_safe(function () { return container.children.numItems; }, 0);
    for (var i = 0; i < n; i++) {
        var child = container.children[i];
        if (!child) { continue; }
        if (child.type === binType) {
            var inner = QMP_findItemByPath(child, nativePath, depth + 1);
            if (inner) { return inner; }
        } else {
            var mediaPath = QMP_safe(function () { return child.getMediaPath(); }, '');
            if (mediaPath && QMP_normPath(mediaPath) === wanted) { return child; }
        }
    }
    return null;
}

/* One pass over a bin: normalised media path -> project item (first match wins, like QMP_findItemByPath). */
function QMP_buildPathMap(container, map, depth, startIndex) {
    depth = depth || 0;
    if (depth > 30) { return map; }
    var binType = QMP_itemTypeBin();
    var n = QMP_safe(function () { return container.children.numItems; }, 0);
    for (var i = (startIndex || 0); i < n; i++) {
        var child = container.children[i];
        if (!child) { continue; }
        if (child.type === binType) {
            QMP_buildPathMap(child, map, depth + 1, 0);
        } else {
            var mediaPath = QMP_safe(function () { return child.getMediaPath(); }, '');
            if (mediaPath) {
                var key = QMP_normPath(mediaPath);
                if (!map[key]) { map[key] = child; }
            }
        }
    }
    return map;
}

/* ------------------------------------------------------------------ */
/* Session cache: path -> project item, so a paste never rescans the bin */
/* ------------------------------------------------------------------ */

var QMP_cache = {};
var QMP_cacheOwner = '';
var QMP_rootScanned = false;
var QMP_subBins = {};
var QMP_PASTE_DIR = '_PastedMedia';
var QMP_KIND_FOLDER = { image: 'Images', video: 'Video', audio: 'Audio' };

function QMP_resetCacheFor(project) {
    var owner = String(QMP_safe(function () { return project.documentID; }, '')) + '|' + String(QMP_safe(function () { return project.path; }, ''));
    if (owner !== QMP_cacheOwner) {
        QMP_cache = {};
        QMP_cacheOwner = owner;
        QMP_rootScanned = false;
        QMP_subBins = {};
    }
}

/* Returns the cached item only if it still points at that file (the user may have deleted it). */
function QMP_cacheGet(norm) {
    var it = QMP_cache[norm];
    if (!it) { return null; }
    try {
        var mp = it.getMediaPath();
        if (mp && QMP_normPath(mp) === norm) { return it; }
    } catch (e) { /* stale item */ }
    delete QMP_cache[norm];
    return null;
}

function QMP_subBin(rootBin, name) {
    var b = QMP_subBins[name];
    if (b) {
        try { if (b.name === name) { return b; } } catch (e) { /* recreate below */ }
    }
    b = QMP_ensureBinIn(rootBin, name);
    QMP_subBins[name] = b;
    return b;
}

function QMP_decodeName(n) {
    try { return decodeURI(String(n)); } catch (e) { return String(n); }
}

/* Bin that mirrors the disk folder: _PastedMedia/Images -> QuickMediaPaste/Images. '' means the main bin. */
function QMP_subBinName(f, kind, organize) {
    if (!organize) { return ''; }
    var parentName = QMP_safe(function () { return QMP_decodeName(f.parent.name); }, '');
    var grandName = QMP_safe(function () { return QMP_decodeName(f.parent.parent.name); }, '');
    if (grandName === QMP_PASTE_DIR && parentName) { return parentName; }
    return QMP_KIND_FOLDER[kind] || '';
}

/*
 * Imports every file that is not in the project yet, one importFiles call per bin, and returns
 * normalised path -> item. The QuickMediaPaste bin is indexed once per Premiere session, not on
 * every paste, so the time of a paste no longer grows with the size of the bin. Throws on any
 * doubt so the caller can use the careful method.
 */
function QMP_fastImport(project, rootBin, paths, organize, log) {
    QMP_resetCacheFor(project);
    var wanted = [];
    var seen = {};
    var misses = false;
    var i;
    for (i = 0; i < paths.length; i++) {
        var p = String(paths[i]);
        var k = QMP_EXT_KIND[QMP_extOf(p)];
        if (k !== 'video' && k !== 'audio' && k !== 'image') { continue; }
        var f = QMP_fileFromNative(p);
        if (!f.exists) { continue; }
        var norm = QMP_normPath(f.fsName);
        if (seen[norm]) { continue; }
        seen[norm] = true;
        wanted.push({ norm: norm, fs: f.fsName, sub: QMP_subBinName(f, k, organize) });
        if (!QMP_cacheGet(norm)) { misses = true; }
    }
    if (misses && !QMP_rootScanned) {
        QMP_buildPathMap(rootBin, QMP_cache, 0, 0);
        QMP_rootScanned = true;
        log('Indexed the QuickMediaPaste bin (once per session).');
    }
    var groups = {};
    var subs = [];
    for (i = 0; i < wanted.length; i++) {
        if (QMP_cacheGet(wanted[i].norm)) { continue; }
        var sub = wanted[i].sub;
        if (!groups.hasOwnProperty(sub)) { groups[sub] = []; subs.push(sub); }
        groups[sub].push(wanted[i].fs);
    }
    for (i = 0; i < subs.length; i++) {
        var bin = subs[i] ? QMP_subBin(rootBin, subs[i]) : rootBin;
        var before = QMP_safe(function () { return bin.children.numItems; }, 0);
        QMP_trace('importFiles -> ' + (subs[i] || 'main bin') + ': ' + groups[subs[i]].join(' ; '));
        project.importFiles(groups[subs[i]], true, bin, false);
        QMP_buildPathMap(bin, QMP_cache, 0, before);
        log('Imported ' + groups[subs[i]].length + ' file(s) into ' + (subs[i] || 'the main bin') + '.');
    }
    var out = {};
    for (i = 0; i < wanted.length; i++) {
        var it = QMP_cache[wanted[i].norm];
        if (!it) { throw new Error('Could not match the imported file ' + wanted[i].fs); }
        out[wanted[i].norm] = it;
    }
    return out;
}

/* Crash trace: the last step is written to disk before every risky Premiere call, so if Premiere dies we know where. */
var QMP_tracePath = '';
function QMP_trace(msg, reset) {
    if (!QMP_tracePath) { return; }
    try {
        var tf = new File(QMP_tracePath);
        tf.encoding = 'UTF-8';
        if (tf.open(reset ? 'w' : 'a')) {
            tf.writeln(new Date().toString() + ' | ' + msg);
            tf.close();
        }
    } catch (e) { /* tracing must never break a paste */ }
}

function QMP_itemDurationTicks(item, kind) {
    var d = 0;
    var mediaType = (kind === 'audio') ? 2 : 1;
    if (kind === 'audio') {
        /* Audio-only items: ask for the audio range explicitly instead of the argument-less form. */
        try { d = QMP_num(item.getOutPoint(2).ticks) - QMP_num(item.getInPoint(2).ticks); } catch (e0) { d = 0; }
    }
    if (!(d > 0)) {
        try {
            var inPoint = item.getInPoint();
            var outPoint = item.getOutPoint();
            d = QMP_num(outPoint.ticks) - QMP_num(inPoint.ticks);
        } catch (e1) { d = 0; }
    }
    if (!(d > 0)) {
        try {
            d = QMP_num(item.getOutPoint(mediaType).ticks) - QMP_num(item.getInPoint(mediaType).ticks);
        } catch (e3) { d = 0; }
    }
    if (!(d > 0)) {
        try { d = QMP_num(item.getOutPoint().ticks); } catch (e2) { d = 0; }
    }
    if (!(d > 0)) {
        d = QMP_DEFAULT_STILL_SECONDS * QMP_TICKS_PER_SECOND;
    }
    return d;
}

function QMP_importAsset(project, bin, filePath, log, pathMap) {
    var f = QMP_fileFromNative(filePath);
    if (!f.exists) { throw new Error('File not found: ' + filePath); }
    var nativePath = f.fsName;

    var existing = pathMap ? pathMap[QMP_normPath(nativePath)] : QMP_findItemByPath(bin, nativePath, 0);
    if (existing) {
        log('Reusing project item for ' + f.displayName);
        return existing;
    }

    var before = QMP_safe(function () { return bin.children.numItems; }, 0);
    QMP_trace('importFiles (single): ' + nativePath);
    var returned = project.importFiles([nativePath], true, bin, false);
    log('importFiles returned ' + String(returned));

    var item = QMP_findItemByPath(bin, nativePath, 0);
    if (!item) {
        var after = QMP_safe(function () { return bin.children.numItems; }, 0);
        if (after > before) { item = bin.children[after - 1]; }
    }
    if (!item) {
        item = QMP_findItemByPath(project.rootItem, nativePath, 0);
    }
    if (!item) {
        throw new Error('Premiere Pro could not import "' + f.displayName + '". The format may not be supported by this version.');
    }
    var offline = QMP_safe(function () { return (typeof item.isOffline === 'function') ? item.isOffline() : false; }, false);
    if (offline) { throw new Error('"' + f.displayName + '" was imported but is offline.'); }
    return item;
}

/* ------------------------------------------------------------------ */
/* Track helpers                                                       */
/* ------------------------------------------------------------------ */

function QMP_listCandidates(seq, kind) {
    var tracks = (kind === 'audio') ? seq.audioTracks : seq.videoTracks;
    var count = QMP_safe(function () { return tracks.numTracks; }, 0);
    var list = [];
    for (var i = 0; i < count; i++) {
        var t = tracks[i];
        if (!t) { continue; }
        var locked = QMP_safe(function () { return (typeof t.isLocked === 'function') ? !!t.isLocked() : false; }, false);
        if (locked) { continue; }
        var targeted = QMP_safe(function () { return (typeof t.isTargeted === 'function') ? !!t.isTargeted() : false; }, false);
        var muted = QMP_safe(function () { return (typeof t.isMuted === 'function') ? !!t.isMuted() : false; }, false);
        var score = (targeted ? 0 : 2) + (muted ? 1 : 0);
        list.push({ track: t, index: i, score: score });
    }
    // Insertion sort by (score, index): deterministic regardless of engine sort stability.
    for (var a = 1; a < list.length; a++) {
        var cur = list[a];
        var b = a - 1;
        while (b >= 0 && (list[b].score > cur.score || (list[b].score === cur.score && list[b].index > cur.index))) {
            list[b + 1] = list[b];
            b--;
        }
        list[b + 1] = cur;
    }
    return list;
}

function QMP_trackHasOverlap(track, startTicks, endTicks) {
    var n = QMP_safe(function () { return track.clips.numItems; }, 0);
    for (var i = 0; i < n; i++) {
        var c = track.clips[i];
        if (!c) { continue; }
        var cs = QMP_num(QMP_safe(function () { return c.start.ticks; }, 0));
        if (cs >= endTicks) { continue; }
        var ce = QMP_num(QMP_safe(function () { return c.end.ticks; }, 0));
        if (ce > startTicks) { return true; }
    }
    return false;
}

function QMP_sameItem(clip, item, itemId) {
    try {
        var pi = clip.projectItem;
        if (!pi) { return false; }
        var wantedId = (itemId !== undefined) ? itemId : item.nodeId;
        if (pi.nodeId !== undefined && wantedId !== undefined) { return pi.nodeId === wantedId; }
        return pi.name === item.name;
    } catch (e) {
        return false;
    }
}

function QMP_clipKey(clip) {
    return String(QMP_safe(function () { return clip.start.ticks; }, '')) + ':' +
        String(QMP_safe(function () { return clip.end.ticks; }, ''));
}

function QMP_itemId(item) {
    try { return item.nodeId; } catch (e) { return undefined; }
}

function QMP_snapshot(track, item) {
    var keys = {};
    var itemId = QMP_itemId(item);
    var n = QMP_safe(function () { return track.clips.numItems; }, 0);
    for (var i = 0; i < n; i++) {
        var c = track.clips[i];
        if (c && QMP_sameItem(c, item, itemId)) { keys[QMP_clipKey(c)] = true; }
    }
    return keys;
}

function QMP_findNewClip(track, item, snapshot, targetTicks) {
    var best = null;
    var bestDist = 0;
    var itemId = QMP_itemId(item);
    var n = QMP_safe(function () { return track.clips.numItems; }, 0);
    for (var i = 0; i < n; i++) {
        var c = track.clips[i];
        if (!c || !QMP_sameItem(c, item, itemId)) { continue; }
        if (snapshot[QMP_clipKey(c)]) { continue; }
        var dist = Math.abs(QMP_num(QMP_safe(function () { return c.start.ticks; }, 0)) - targetTicks);
        if (best === null || dist < bestDist) { best = c; bestDist = dist; }
    }
    return best;
}

/*
 * The Track API documents the time argument inconsistently across Premiere versions
 * (seconds as a number, a Time object, or a ticks string). Each form is tried in turn and
 * the result is verified against the timeline, so a call that silently lands at the wrong
 * position is rolled back instead of being left behind.
 */
/* Time argument form that landed correctly earlier in this Premiere session (null until one is verified). */
var QMP_okVariant = null;
var QMP_candCache = null;

function QMP_timeArg(variant, startTicks) {
    if (variant === 'seconds') { return startTicks / QMP_TICKS_PER_SECOND; }
    if (variant === 'time') { return QMP_makeTime(startTicks); }
    return QMP_ticksString(startTicks);
}

/*
 * Fast path for Overwrite once a time argument has been verified in this session: no snapshot of the
 * whole track, just one look for the new clip around the playhead (the range was checked free before).
 */
function QMP_fastPlace(track, item, startTicks, tolTicks, log) {
    var n0 = QMP_safe(function () { return track.clips.numItems; }, 0);
    try { track.overwriteClip(item, QMP_timeArg(QMP_okVariant, startTicks)); } catch (e) { /* checked below */ }
    var n1 = QMP_safe(function () { return track.clips.numItems; }, 0);
    var itemId = QMP_itemId(item);
    for (var i = 0; i < n1; i++) {
        var c = track.clips[i];
        if (!c) { continue; }
        var s = QMP_num(QMP_safe(function () { return c.start.ticks; }, 0));
        if (Math.abs(s - startTicks) > tolTicks) { continue; }
        if (!QMP_sameItem(c, item, itemId)) { continue; }
        var en = QMP_num(QMP_safe(function () { return c.end.ticks; }, 0));
        log('Placed using "' + QMP_okVariant + '" time argument (fast path).');
        return { ok: true, startTicks: s, endTicks: en, clip: c };
    }
    return { ok: false, added: n1 > n0 };
}

function QMP_tryPlaceOnTrack(track, item, mode, startTicks, tolTicks, log) {
    var variants = ['seconds', 'time', 'ticks'];
    var lastError = 'no attempt was made';
    if (mode === 'overwrite' && QMP_okVariant) {
        QMP_trace('fast overwriteClip, variant ' + QMP_okVariant + ', start ' + startTicks);
        var fast = QMP_fastPlace(track, item, startTicks, tolTicks, log);
        if (fast.ok) { return fast; }
        if (fast.added) {
            return { ok: false, error: 'A clip was added but not found at the playhead. Check the timeline or use Edit > Undo.' };
        }
        log('Fast placement did not work; using the careful method.');
        QMP_okVariant = null;
    }
    for (var v = 0; v < variants.length; v++) {
        var snapshot = QMP_snapshot(track, item);
        var arg = QMP_timeArg(variants[v], startTicks);

        var thrown = null;
        QMP_trace(mode + 'Clip, variant ' + variants[v] + ', start ' + startTicks);
        try {
            if (mode === 'insert') { track.insertClip(item, arg); }
            else { track.overwriteClip(item, arg); }
        } catch (e) {
            thrown = e;
        }

        var placed = QMP_findNewClip(track, item, snapshot, startTicks);
        if (placed) {
            var s = QMP_num(QMP_safe(function () { return placed.start.ticks; }, 0));
            var en = QMP_num(QMP_safe(function () { return placed.end.ticks; }, 0));
            if (Math.abs(s - startTicks) <= tolTicks) {
                log('Placed using "' + variants[v] + '" time argument.');
                if (mode === 'overwrite') { QMP_okVariant = variants[v]; }
                return { ok: true, startTicks: s, endTicks: en, clip: placed };
            }
            log('Time argument "' + variants[v] + '" landed at ' + (s / QMP_TICKS_PER_SECOND) + 's instead of ' +
                (startTicks / QMP_TICKS_PER_SECOND) + 's. Rolling back.');
            try {
                placed.remove(mode === 'insert', mode === 'insert');
            } catch (re) {
                return { ok: false, error: 'The clip landed at the wrong time and could not be removed (' + QMP_errText(re) + '). Use Edit > Undo.' };
            }
            lastError = 'time argument "' + variants[v] + '" was placed at the wrong position';
            continue;
        }
        lastError = variants[v] + ': ' + (thrown ? QMP_errText(thrown) : 'no clip was created');
    }
    return { ok: false, error: lastError };
}

function QMP_placeOnTrack(seq, item, kind, mode, startTicks, durTicks, tolTicks, log, forcedIndex) {
    /* A trace from Premiere Pro 25.1 showed it dying inside insertClip on an audio track. Audio is therefore never
       inserted: it goes to the first audio track that is free at the playhead, as an overwrite that cannot erase anything. */
    if (kind === 'audio' && mode === 'insert') {
        log('Audio is placed on a free audio track instead of using Insert (Insert on audio crashed Premiere Pro 25.1).');
        mode = 'overwrite';
    }
    /* Track state does not change inside one request, so it is read once per kind, not once per item. */
    var candidates;
    if (QMP_candCache && QMP_candCache[kind]) { candidates = QMP_candCache[kind]; }
    else {
        candidates = QMP_listCandidates(seq, kind);
        if (QMP_candCache) { QMP_candCache[kind] = candidates; }
    }
    if (forcedIndex >= 0 && kind !== 'audio') {
        var only = [];
        for (var q = 0; q < candidates.length; q++) {
            if (candidates[q].index === forcedIndex) { only.push(candidates[q]); }
        }
        if (only.length === 0) {
            throw new Error('Video track V' + (forcedIndex + 1) + ' does not exist in this sequence or is locked.');
        }
        candidates = only;
    }
    var trackWord = (kind === 'audio') ? 'audio' : 'video';
    if (candidates.length === 0) {
        throw new Error('No unlocked ' + trackWord + ' track is available in the active sequence.');
    }

    var endTicks = startTicks + durTicks;
    /* Tracks are tried in order and checked one at a time, so the first free one wins without reading the others. */
    var lastError = '';
    var anyFree = false;
    for (var j = 0; j < candidates.length; j++) {
        var c = candidates[j];
        var label = QMP_trackLabel(kind, c.index);
        if (mode !== 'insert' && QMP_trackHasOverlap(c.track, startTicks, endTicks)) {
            log(label + ' is occupied at the playhead, skipping.');
            continue;
        }
        anyFree = true;
        log('Trying ' + label + ' (' + mode + ').');
        var result = QMP_tryPlaceOnTrack(c.track, item, mode, startTicks, tolTicks, log);
        if (result.ok) {
            return {
                trackIndex: c.index,
                trackLabel: label,
                startTicks: result.startTicks,
                endTicks: result.endTicks,
                clip: result.clip
            };
        }
        lastError = result.error;
        log(label + ' refused the clip: ' + result.error);
    }
    if (!anyFree) {
        throw new Error('Every unlocked ' + trackWord + ' track already has media at the playhead. ' +
            'Add or unlock a track, move the playhead, or switch to Insert mode.');
    }
    throw new Error('Premiere Pro refused the placement: ' + lastError);
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

function QMP_ping() {
    try {
        return QMP_JSON.stringify({
            ok: true,
            hostVersion: String(QMP_safe(function () { return app.version; }, 'unknown')),
            hostBuild: String(QMP_safe(function () { return app.build; }, '')),
            hostscriptVersion: QMP_VERSION,
            os: String(QMP_safe(function () { return Folder.fs; }, ''))
        });
    } catch (e) {
        return QMP_JSON.stringify({ ok: false, error: 'Ping failed: ' + QMP_errText(e) });
    }
}

function QMP_getContext(encoded) {
    var logs = [];
    var log = QMP_makeLogger(logs);
    try {
        if (typeof app === 'undefined' || !app || !app.project) {
            return QMP_JSON.stringify({ ok: false, error: 'No Premiere Pro project is open.', log: logs });
        }
        var project = app.project;
        var projectPath = String(QMP_safe(function () { return project.path; }, ''));
        var projectName = String(QMP_safe(function () { return project.name; }, ''));

        var seq = QMP_safe(function () { return project.activeSequence; }, null);
        if (!seq) {
            var msg = 'No active sequence. Open a sequence in the Timeline panel, then try again.';
            QMP_notifyPremiere(msg, 'warning');
            return QMP_JSON.stringify({ ok: false, error: msg, log: logs });
        }

        if (!projectPath) {
            var unsaved = 'The project has not been saved yet. Save it (File > Save) so media can be stored next to it in "_PastedMedia".';
            QMP_notifyPremiere(unsaved, 'warning');
            return QMP_JSON.stringify({ ok: false, error: unsaved, log: logs });
        }

        var projectFile = new File(projectPath);
        var parent = projectFile.parent;
        if (!parent || !parent.exists) {
            return QMP_JSON.stringify({ ok: false, error: 'The project folder could not be found: ' + projectPath, log: logs });
        }

        var pos = seq.getPlayerPosition();
        var playheadTicks = QMP_num(pos.ticks);
        var playheadSeconds = playheadTicks / QMP_TICKS_PER_SECOND;
        log('Project "' + projectName + '", sequence "' + seq.name + '", playhead ' + playheadSeconds + 's.');

        return QMP_JSON.stringify({
            ok: true,
            projectName: projectName,
            projectPath: projectFile.fsName,
            projectDir: parent.fsName,
            sequenceName: String(seq.name),
            playheadSeconds: playheadSeconds,
            playheadTicks: String(pos.ticks),
            frameWidth: QMP_num(QMP_safe(function () { return seq.frameSizeHorizontal; }, 0)),
            frameHeight: QMP_num(QMP_safe(function () { return seq.frameSizeVertical; }, 0)),
            videoTrackCount: QMP_safe(function () { return seq.videoTracks.numTracks; }, 0),
            audioTrackCount: QMP_safe(function () { return seq.audioTracks.numTracks; }, 0),
            log: logs
        });
    } catch (e) {
        return QMP_JSON.stringify({ ok: false, error: 'Could not read the project context: ' + QMP_errText(e), log: logs });
    }
}

/* Imports files into the QuickMediaPaste bin ahead of the paste (called when the media is copied). */
function QMP_preImport(encoded) {
    var logs = [];
    try {
        var req = QMP_decodeRequest(encoded);
        if (typeof app === 'undefined' || !app || !app.project) { return QMP_JSON.stringify({ ok: false, error: 'No project.', log: logs }); }
        var project = app.project;
        var binName = (typeof req.binName === 'string' && req.binName.length > 0) ? req.binName : 'QuickMediaPaste';
        var bin = QMP_ensureBin(project, binName);
        try {
            var fm = QMP_fastImport(project, bin, req.paths, req.organize !== false, QMP_makeLogger(logs));
            var fcount = 0;
            for (var fk in fm) { if (fm.hasOwnProperty(fk)) { fcount++; } }
            return QMP_JSON.stringify({ ok: true, imported: fcount, log: logs });
        } catch (fastErr) {
            QMP_rootScanned = false;
            logs.push('Fast pre-import skipped: ' + QMP_errText(fastErr));
        }
        var map = QMP_buildPathMap(bin, {}, 0, 0);
        var needed = [];
        var seen = {};
        var all = [];
        for (var i = 0; i < req.paths.length; i++) {
            var f = QMP_fileFromNative(String(req.paths[i]));
            if (!f.exists) { continue; }
            var kind = QMP_EXT_KIND[QMP_extOf(f.fsName)];
            if (kind !== 'video' && kind !== 'audio' && kind !== 'image') { continue; }
            var key = QMP_normPath(f.fsName);
            all.push(key);
            if (map[key] || seen[key]) { continue; }
            seen[key] = true;
            needed.push(f.fsName);
        }
        if (needed.length > 0) {
            project.importFiles(needed, true, bin, false);
            map = QMP_buildPathMap(bin, {}, 0, 0);
        }
        for (var j = 0; j < all.length; j++) {
            if (!map[all[j]]) { return QMP_JSON.stringify({ ok: false, error: 'Could not match an imported file.', log: logs }); }
        }
        return QMP_JSON.stringify({ ok: true, imported: needed.length, log: logs });
    } catch (e) {
        return QMP_JSON.stringify({ ok: false, error: QMP_errText(e), log: logs });
    }
}

/* Removes pre-imported items again when the copy was never pasted. Does nothing where deleteAsset does not exist. */
function QMP_removeImported(encoded) {
    try {
        var req = QMP_decodeRequest(encoded);
        var project = app.project;
        if (typeof project.deleteAsset !== 'function') { return QMP_JSON.stringify({ ok: true, removedAll: false, removed: 0 }); }
        var binName = (typeof req.binName === 'string' && req.binName.length > 0) ? req.binName : 'QuickMediaPaste';
        var bin = QMP_ensureBin(project, binName);
        QMP_resetCacheFor(project);
        var map = null;
        var removed = 0;
        var done = 0;
        for (var i = 0; i < req.paths.length; i++) {
            var key = QMP_normPath(QMP_fileFromNative(String(req.paths[i])).fsName);
            var item = QMP_cacheGet(key);
            if (!item) {
                if (!map) { map = QMP_buildPathMap(bin, {}, 0, 0); }
                item = map[key];
            }
            if (!item) { done++; continue; }
            try { project.deleteAsset(item); delete QMP_cache[key]; removed++; done++; } catch (e1) { /* keep it */ }
        }
        return QMP_JSON.stringify({ ok: true, removedAll: done === req.paths.length, removed: removed });
    } catch (e) {
        return QMP_JSON.stringify({ ok: false, error: QMP_errText(e) });
    }
}

/* Motion Graphics templates go through importMGT, on the first video track that is free at the playhead. */
/* Fills the first text-like field of an Essential Graphics clip. Returns true when a value was set. */
function QMP_setMogrtText(ti, text, log) {
    try {
        var comp = ti.getMGTComponent();
        if (!comp) { return false; }
        var props = comp.properties;
        var n = QMP_safe(function () { return props.numItems; }, 0);
        var order = [];
        var i;
        for (i = 0; i < n; i++) {
            var nm = String(QMP_safe(function () { return props[i].displayName; }, ''));
            if (/text|title|name|caption|headline/i.test(nm)) { order.push(i); }
        }
        if (!order.length && n > 0) { order.push(0); }
        for (i = 0; i < order.length; i++) {
            try { props[order[i]].setValue(text, true); log('Text written into template field "' + QMP_safe(function () { return props[order[i]].displayName; }, '') + '".'); return true; } catch (e1) { /* try the next field */ }
        }
    } catch (e) { log('Could not fill the template text: ' + QMP_errText(e)); }
    return false;
}

function QMP_placeMogrt(seq, filePath, startTicks, log, text) {
    var f = QMP_fileFromNative(filePath);
    if (!f.exists) { throw new Error('File not found: ' + filePath); }
    var count = QMP_safe(function () { return seq.videoTracks.numTracks; }, 0);
    var guess = 5 * QMP_TICKS_PER_SECOND;
    var idx = -1;
    for (var i = 0; i < count; i++) {
        var t = seq.videoTracks[i];
        if (!t) { continue; }
        var locked = QMP_safe(function () { return (typeof t.isLocked === 'function') ? !!t.isLocked() : false; }, false);
        if (locked) { continue; }
        if (!QMP_trackHasOverlap(t, startTicks, startTicks + guess)) { idx = i; break; }
    }
    if (idx < 0) { throw new Error('Every video track is busy at the playhead. Move the playhead or add a track.'); }
    log('Importing MOGRT on ' + QMP_trackLabel('video', idx) + '.');
    var ti = seq.importMGT(f.fsName, QMP_ticksString(startTicks), idx, 0);
    if (!ti) { throw new Error('Premiere Pro could not import the MOGRT.'); }
    var filled = (text ? QMP_setMogrtText(ti, String(text), log) : true);
    var s0 = QMP_num(QMP_safe(function () { return ti.start.ticks; }, startTicks));
    var e0 = QMP_num(QMP_safe(function () { return ti.end.ticks; }, 0));
    if (!(e0 > s0)) { e0 = startTicks + guess; }
    return { trackLabel: QMP_trackLabel('video', idx), startTicks: s0, endTicks: e0, filled: filled };
}

/* Writes the frame under the playhead to a PNG file (used by the "copy frame" shortcut). */
function QMP_exportFrame(encoded) {
    var logs = [];
    var log = QMP_makeLogger(logs);
    try {
        var req = QMP_decodeRequest(encoded);
        if (typeof app === 'undefined' || !app || !app.project) {
            return QMP_JSON.stringify({ ok: false, error: 'No Premiere Pro project is open.', log: logs });
        }
        var seq = QMP_safe(function () { return app.project.activeSequence; }, null);
        if (!seq) { return QMP_JSON.stringify({ ok: false, error: 'No active sequence.', log: logs }); }
        var out = new File(String(req.outPath));
        var pos = seq.getPlayerPosition();
        var done = false;
        var errs = [];
        var attempts = [pos, String(pos.ticks)];
        for (var i = 0; i < attempts.length && !done; i++) {
            try { done = !!seq.exportFramePNG(attempts[i], out.fsName); } catch (e1) { errs.push(QMP_errText(e1)); }
            if (!done && out.exists) { done = true; }
        }
        if (!done && !out.exists) {
            return QMP_JSON.stringify({ ok: false, error: 'Premiere Pro could not export the frame. ' + errs.join(' '), log: logs });
        }
        return QMP_JSON.stringify({ ok: true, path: out.fsName, log: logs });
    } catch (e) {
        return QMP_JSON.stringify({ ok: false, error: 'Frame export failed: ' + QMP_errText(e), log: logs });
    }
}

/* Pixel size of a project item from its metadata ("1920 x 1080"), or null. */
function QMP_itemPixelSize(item) {
    try {
        var xmp = String(item.getProjectMetadata());
        var m = /Column\.Intrinsic\.VideoInfo>\s*([0-9]+)\s*x\s*([0-9]+)/i.exec(xmp);
        if (m) { return { w: parseInt(m[1], 10), h: parseInt(m[2], 10) }; }
    } catch (e) { /* not available */ }
    return null;
}

/* Sets the Motion > Scale of a clip so the still fits / fills the sequence frame. */
function QMP_applyStillFit(clip, dims, seqW, seqH, mode, log) {
    if (!clip || mode === 'original') { return 'original size kept'; }
    if (!dims || !(dims.w > 0) || !(dims.h > 0)) { return 'image size unknown, left as Premiere placed it'; }
    if (!(seqW > 0) || !(seqH > 0)) { return 'sequence size unknown'; }
    var sx = seqW / dims.w, sy = seqH / dims.h;
    var factor = (mode === 'fill') ? Math.max(sx, sy) : Math.min(sx, sy);
    if (mode === 'shrink' && factor > 1) { factor = 1; }
    var pct = factor * 100;
    var comps = clip.components;
    var n = QMP_safe(function () { return comps.numItems; }, 0);
    for (var i = 0; i < n; i++) {
        var comp = comps[i];
        var cname = String(QMP_safe(function () { return comp.displayName; }, ''));
        var mname = String(QMP_safe(function () { return comp.matchName; }, ''));
        if (cname !== 'Motion' && mname.indexOf('ADBE Motion') === -1) { continue; }
        var props = comp.properties;
        var pn = QMP_safe(function () { return props.numItems; }, 0);
        for (var j = 0; j < pn; j++) {
            var prop = props[j];
            var pname = String(QMP_safe(function () { return prop.displayName; }, ''));
            if (pname === 'Scale') {
                prop.setValue(pct, true);
                log('Scale set to ' + pct + '% (' + dims.w + 'x' + dims.h + ' into ' + seqW + 'x' + seqH + ', ' + mode + ').');
                return 'scale ' + Math.round(pct * 10) / 10 + '%';
            }
        }
    }
    return 'Motion > Scale not found';
}

/* Every non-bin project item below a container (recursive). */
function QMP_collectItems(container, out, depth) {
    if (depth > 20) { return; }
    var binType = QMP_itemTypeBin();
    var n = QMP_safe(function () { return container.children.numItems; }, 0);
    for (var i = 0; i < n; i++) {
        var c = container.children[i];
        if (!c) { continue; }
        if (c.type === binType) { QMP_collectItems(c, out, depth + 1); } else { out.push(c); }
    }
}

/* Imports every composition of an After Effects project (Dynamic Link) and returns the new items. */
function QMP_importAepComps(project, bin, filePath, log) {
    var f = QMP_fileFromNative(filePath);
    if (!f.exists) { throw new Error('File not found: ' + filePath); }
    var before = [];
    QMP_collectItems(project.rootItem, before, 0);
    var seen = {};
    for (var i = 0; i < before.length; i++) { seen[String(QMP_safe(function () { return before[i].nodeId; }, i))] = true; }
    if (typeof project.importAllAEComps !== 'function') {
        throw new Error('This Premiere Pro version cannot import After Effects compositions by script.');
    }
    project.importAllAEComps(f.fsName, bin);
    var after = [];
    QMP_collectItems(project.rootItem, after, 0);
    var fresh = [];
    for (var j = 0; j < after.length; j++) {
        var id = String(QMP_safe(function () { return after[j].nodeId; }, 'x' + j));
        if (!seen[id]) { fresh.push(after[j]); }
    }
    log('After Effects import created ' + fresh.length + ' item(s).');
    if (fresh.length === 0) {
        throw new Error('No compositions were imported from "' + f.displayName + '". After Effects must be installed for Dynamic Link.');
    }
    return fresh;
}

function QMP_insertMedia(encoded) {
    var logs = [];
    var log = QMP_makeLogger(logs);
    try {
        var req = QMP_decodeRequest(encoded);
        var paths = req.paths;
        if (!paths || Object.prototype.toString.call(paths) !== '[object Array]' || paths.length === 0) {
            return QMP_JSON.stringify({ ok: false, error: 'No media paths were provided.', log: logs });
        }
        var mode = (req.mode === 'insert') ? 'insert' : 'overwrite';
        QMP_candCache = {};
        QMP_tracePath = String(req.tracePath || '');
        QMP_trace('insertMedia start: ' + paths.length + ' file(s), mode ' + mode, true);
        if (!QMP_okVariant && mode === 'overwrite' && (req.variantHint === 'seconds' || req.variantHint === 'time' || req.variantHint === 'ticks')) { QMP_okVariant = req.variantHint; }
        var stillTicks = QMP_num(req.stillSeconds) * QMP_TICKS_PER_SECOND;
        var forcedIndex = (typeof req.trackIndex === 'number' && req.trackIndex >= 0) ? Math.floor(req.trackIndex) : -1;
        var binName = (typeof req.binName === 'string' && req.binName.length > 0) ? req.binName : 'QuickMediaPaste';

        if (typeof app === 'undefined' || !app || !app.project) {
            return QMP_JSON.stringify({ ok: false, error: 'No Premiere Pro project is open.', log: logs });
        }
        var project = app.project;

        var seq = QMP_safe(function () { return project.activeSequence; }, null);
        if (!seq) {
            return QMP_JSON.stringify({
                ok: false,
                error: 'No active sequence. Open a sequence in the Timeline panel, then try again.',
                log: logs
            });
        }

        var playhead = seq.getPlayerPosition();
        var cursorTicks = QMP_num(playhead.ticks);
        var frameTicks = QMP_num(QMP_safe(function () { return seq.timebase; }, 0));
        if (!(frameTicks > 0)) { frameTicks = QMP_TICKS_PER_SECOND / 24; }
        var tolTicks = frameTicks;
        log('Playhead at ' + (cursorTicks / QMP_TICKS_PER_SECOND) + 's, frame = ' + frameTicks + ' ticks, mode = ' + mode + '.');

        var bin = QMP_ensureBin(project, binName);
        var fitMode = (typeof req.fit === 'string') ? req.fit : 'fit';
        var seqW = QMP_num(QMP_safe(function () { return seq.frameSizeHorizontal; }, 0));
        var seqH = QMP_num(QMP_safe(function () { return seq.frameSizeVertical; }, 0));

        /*
         * Import everything that is not in the bin yet with ONE importFiles call and build ONE path
         * index of the bin, instead of scanning the whole bin (it grows with every paste) per file.
         * Any problem here just drops back to the per-file import below.
         */
        var organize = (req.organize !== false);
        var pathMap = null;
        try {
            pathMap = QMP_fastImport(project, bin, paths, organize, log);
        } catch (fastErr) {
            pathMap = null;
            QMP_rootScanned = false;
            log('Fast import skipped: ' + QMP_errText(fastErr));
        }
        if (!pathMap) try {
            pathMap = QMP_buildPathMap(bin, {}, 0, 0);
            var needed = [];
            var neededSeen = {};
            for (var qi = 0; qi < paths.length; qi++) {
                var qp = String(paths[qi]);
                var qk = QMP_EXT_KIND[QMP_extOf(qp)];
                if (qk !== 'video' && qk !== 'audio' && qk !== 'image') { continue; }
                var qf = QMP_fileFromNative(qp);
                if (!qf.exists) { continue; }
                var qn = QMP_normPath(qf.fsName);
                if (pathMap[qn] || neededSeen[qn]) { continue; }
                neededSeen[qn] = true;
                needed.push(qf.fsName);
            }
            if (needed.length > 0) {
                var binBefore = QMP_safe(function () { return bin.children.numItems; }, 0);
                project.importFiles(needed, true, bin, false);
                QMP_buildPathMap(bin, pathMap, 0, binBefore);
                var anyMissing = false;
                for (var qm = 0; qm < needed.length; qm++) {
                    if (!pathMap[QMP_normPath(needed[qm])]) { anyMissing = true; break; }
                }
                if (anyMissing) { pathMap = QMP_buildPathMap(bin, {}, 0, 0); }
                for (var qc = 0; qc < needed.length; qc++) {
                    if (!pathMap[QMP_normPath(needed[qc])]) { pathMap = null; break; }
                }
                log(pathMap ? ('Imported ' + needed.length + ' file(s) in one call.') : 'Batch import could not be matched; importing one by one.');
            }
        } catch (batchErr) {
            pathMap = null;
            log('Batch import skipped: ' + QMP_errText(batchErr));
        }

        var results = [];
        var okCount = 0;
        for (var i = 0; i < paths.length; i++) {
            var p = String(paths[i]);
            var entry = { path: p, ok: false, mode: mode };
            try {
                var ext = QMP_extOf(p);
                var kind = QMP_EXT_KIND[ext];
                if (!kind) { throw new Error('Unsupported file type ".' + ext + '".'); }
                entry.kind = kind;
                log('Asset ' + (i + 1) + ': ' + p + ' (' + kind + ').');

                if (kind === 'aep') {
                    var comps = QMP_importAepComps(project, bin, p, log);
                    var firstStart = cursorTicks, lastLabel = '';
                    for (var ci = 0; ci < comps.length; ci++) {
                        var cdur = QMP_itemDurationTicks(comps[ci], 'video');
                        var cp = QMP_placeOnTrack(seq, comps[ci], 'video', mode, cursorTicks, cdur, tolTicks, log, forcedIndex);
                        lastLabel = cp.trackLabel;
                        cursorTicks = cp.endTicks;
                    }
                    entry.ok = true;
                    entry.kind = 'video';
                    entry.trackLabel = lastLabel;
                    entry.startSeconds = firstStart / QMP_TICKS_PER_SECOND;
                    entry.endSeconds = cursorTicks / QMP_TICKS_PER_SECOND;
                    entry.note = comps.length + ' composition(s) placed one after another.';
                    okCount++;
                    results.push(entry);
                    continue;
                }
                if (kind === 'mogrt') {
                    var mg = QMP_placeMogrt(seq, p, cursorTicks, log, (req.texts && req.texts[i]) ? req.texts[i] : '');
                    if (!mg.filled) { entry.note = 'The template was placed, but its text field could not be filled. Edit the text in the Essential Graphics panel.'; }
                    entry.ok = true;
                    entry.trackLabel = mg.trackLabel;
                    entry.startSeconds = mg.startTicks / QMP_TICKS_PER_SECOND;
                    entry.endSeconds = mg.endTicks / QMP_TICKS_PER_SECOND;
                    cursorTicks = mg.endTicks;
                    okCount++;
                    results.push(entry);
                    continue;
                }
                var item = QMP_importAsset(project, bin, p, log, pathMap);
                var durTicks = QMP_itemDurationTicks(item, kind);
                var wantStill = (kind === 'image' && stillTicks > 0);
                if (wantStill) { durTicks = stillTicks; }
                log('Duration ' + (durTicks / QMP_TICKS_PER_SECOND) + 's.');

                var placed = QMP_placeOnTrack(seq, item, kind, mode, cursorTicks, durTicks, tolTicks, log, forcedIndex);
                if (wantStill && mode === 'overwrite' && placed.clip && Math.abs(placed.endTicks - placed.startTicks - durTicks) > tolTicks) {
                    try {
                        placed.clip.end = QMP_makeTime(placed.startTicks + durTicks);
                        var newEnd = QMP_num(placed.clip.end.ticks);
                        if (newEnd > 0) { placed.endTicks = newEnd; }
                        log('Still length set to ' + (durTicks / QMP_TICKS_PER_SECOND) + 's.');
                    } catch (trimErr) {
                        log('Could not change the still length: ' + QMP_errText(trimErr));
                        entry.note = 'The image length could not be changed; Premiere default was kept.';
                    }
                }
                if (kind === 'image' && placed.clip) {
                    try {
                        var d = (req.dims && req.dims[i]) ? req.dims[i] : QMP_itemPixelSize(item);
                        var fitNote = QMP_applyStillFit(placed.clip, d, seqW, seqH, fitMode, log);
                        entry.note = (entry.note ? entry.note + ' ' : '') + 'Image: ' + fitNote + '.';
                    } catch (fitErr) { log('Could not resize the image: ' + QMP_errText(fitErr)); }
                }
                entry.ok = true;
                entry.trackLabel = placed.trackLabel;
                entry.startSeconds = placed.startTicks / QMP_TICKS_PER_SECOND;
                entry.endSeconds = placed.endTicks / QMP_TICKS_PER_SECOND;
                if (kind === 'video') {
                    entry.note = 'Linked audio, if any, goes to the targeted audio tracks and follows Premiere Pro track targeting.';
                }
                cursorTicks = placed.endTicks;
                okCount++;
            } catch (itemErr) {
                entry.error = QMP_errText(itemErr);
                log('Failed: ' + entry.error);
            }
            results.push(entry);
        }

        var summary = okCount + ' of ' + paths.length + ' asset(s) placed.';
        QMP_trace('FINISHED');
        QMP_notifyPremiere(summary, okCount === paths.length ? 'info' : 'warning');
        return QMP_JSON.stringify({
            ok: okCount > 0,
            error: okCount > 0 ? '' : 'None of the assets could be placed.',
            results: results,
            variant: QMP_okVariant || '',
            log: logs
        });
    } catch (e) {
        QMP_trace('FINISHED (error: ' + QMP_errText(e) + ')');
        QMP_notifyPremiere('Placement failed: ' + QMP_errText(e), 'error');
        return QMP_JSON.stringify({ ok: false, error: 'Placement failed: ' + QMP_errText(e), log: logs });
    }
}
