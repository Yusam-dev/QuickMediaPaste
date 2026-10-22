/*
 * QuickMediaPaste - main.js
 *
 * Runs inside the CEP panel (Chromium + Node.js, enabled by the manifest flags
 * --enable-nodejs and --mixed-context). Responsibilities:
 *   1. Read the OS clipboard (PowerShell on Windows, osascript/JXA on macOS).
 *   2. Work out what is on it: files, a bitmap, a URL, a data: URL.
 *   3. Download URLs asynchronously, convert WebP/AVIF/HEIC/SVG to PNG.
 *   4. Store every asset in "<project folder>/_PastedMedia".
 *   5. Ask hostscript.jsx to import the files and place them at the playhead.
 *
 * No external dependencies. The CEP bridge (window.__adobe_cep__) is used directly,
 * so CSInterface.js is not required.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Configuration                                                       */
  /* ------------------------------------------------------------------ */

  var CONFIG = {
    PASTE_DIR_NAME: '_PastedMedia',
    BIN_NAME: 'QuickMediaPaste',
    MAX_DOWNLOAD_BYTES: 4 * 1024 * 1024 * 1024,
    DOWNLOAD_IDLE_TIMEOUT_MS: 30000,
    MAX_REDIRECTS: 8,
    DOWNLOAD_RETRIES: 2,
    DOWNLOAD_RETRY_BASE_MS: 1500,
    STALE_PART_MS: 60 * 60 * 1000,        /* leftover .part downloads older than this are removed */
    STALE_TMP_MS: 24 * 60 * 60 * 1000,    /* leftover qmp_* temp files in the OS temp folder */
    HOST_CALL_TIMEOUT_MS: 180000,
    HOST_PING_TIMEOUT_MS: 8000,
    CLIPBOARD_TIMEOUT_MS: 20000,
    CONVERT_TIMEOUT_MS: 90000,
    MAX_LOG_LINES: 600,
    MAX_LOG_HISTORY: 3000,
    MAX_CLIPBOARD_ITEMS: 25,
    AUTO_TEXT_MAX_CHARS: 1000,
    MAX_EXPANDED_ITEMS: 300,
    MAX_CANVAS_PIXELS: 200 * 1000 * 1000,
    SVG_TARGET_SIDE: 2048,
    SNIFF_BYTES: 4096,
    FAST_COPY_BYTES: 16 * 1024 * 1024,   /* files up to this size use the native fs.copyFile */
    COPY_CHUNK_BYTES: 4 * 1024 * 1024,   /* stream chunk for bigger files (Node default is 64 KB) */
    LINK_BIG_FILES: true,                /* big files: try clone, then hard link, before a real copy */
    PREPARE_CONCURRENCY: 3,
    STAGE_MAX_BYTES: 1024 * 1024 * 1024, /* pre-stage on copy only up to this much file data */
    SETTLE_MS: 80,
    FFMPEG_TIMEOUT_MS: 30 * 60 * 1000,
    SETTINGS_KEY: 'quickmediapaste.settings.v1',
    /* Many CDNs answer 403 to non-browser agents, so present a normal browser string. */
    USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36'
  };

  /* ------------------------------------------------------------------ */
  /* DOM references                                                      */
  /* ------------------------------------------------------------------ */

  function byId(id) { return document.getElementById(id); }

  var ui = {
    pill: byId('statusPill'),
    langBtn: byId('langBtn'),
    kbdHint: byId('kbdHint'),
    modeHint: byId('modeHint'),
    placement: byId('placementMode'),
    copyLocal: byId('optCopyLocal'),
    organize: byId('optOrganize'),
    autoConvert: byId('optAutoConvert'),
    pasteBtn: byId('pasteBtn'),
    pasteLabel: byId('pasteBtnLabel'),
    cancelBtn: byId('cancelBtn'),
    progress: byId('progress'),
    progressBar: byId('progressBar'),
    verbose: byId('optVerbose'),
    copyLogBtn: byId('copyLogBtn'),
    clearLogBtn: byId('clearLogBtn'),
    console: byId('console'),
    msg: byId('msg'),
    recentBox: byId('recentBox'),
    recentList: byId('recentList'),
    toggleLogBtn: byId('toggleLogBtn'),
    logBox: byId('logBox'),
    dropOverlay: byId('dropOverlay'),
    track: byId('optTrack'),
    still: byId('optStill'),
    fit: byId('optFit'),
    openFolderBtn: byId('openFolderBtn'),
    auto: byId('optAuto'),
    autoColor: byId('optAutoColor'),
    stage: byId('optStage'),
    autoText: byId('optAutoText'),
    titleFont: byId('optTitleFont'),
    titleTemplate: byId('optTitleTemplate'),
    titleTemplateBrowse: byId('optTitleTemplateBrowse'),
    titleSize: byId('optTitleSize'),
    titleColor: byId('optTitleColor'),
    titleColorPick: byId('optTitleColorPick'),
    titlePos: byId('optTitlePos'),
    titleBold: byId('optTitleBold'),
    titleShadow: byId('optTitleShadow'),
    hotkey: byId('optHotkey'),
    hotkeyRow: byId('hotkeyRow'),
    hotkeyText: byId('optHotkeyText'),
    hotkeyTextRow: byId('hotkeyTextRow'),
    frameKey: byId('optFrameKey'),
    frameKeyRow: byId('frameKeyRow'),
    frameBtn: byId('frameBtn'),
    frameKbd: byId('frameKbd'),
    keyPaste: byId('keyPaste'),
    keyFrame: byId('keyFrame'),
    keyPasteReset: byId('keyPasteReset'),
    keyFrameReset: byId('keyFrameReset'),
    keyErr: byId('keyErr')
  };

  /* ------------------------------------------------------------------ */
  /* Small utilities                                                     */
  /* ------------------------------------------------------------------ */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function clock() {
    var d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function stamp() {
    var d = new Date();
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' +
      pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }

  function errMsg(e) {
    if (e === null || e === undefined) { return 'Unknown error'; }
    if (typeof e === 'string') { return e; }
    if (e.message) { return String(e.message); }
    try { return String(e); } catch (x) { return 'Unknown error'; }
  }

  function truncate(s, n) {
    s = String(s === undefined || s === null ? '' : s);
    return s.length > n ? s.slice(0, n) + '...' : s;
  }

  function formatBytes(n) {
    if (!isFinite(n) || n < 0) { return '0 B'; }
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? String(Math.round(n)) : n.toFixed(n >= 100 ? 0 : 1)) + ' ' + units[i];
  }

  function formatSeconds(sec) {
    if (!isFinite(sec) || sec < 0) { sec = 0; }
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec - h * 3600 - m * 60;
    var whole = Math.floor(s);
    var ms = Math.round((s - whole) * 1000);
    if (ms === 1000) { whole += 1; ms = 0; }
    var msText = ms < 10 ? '00' + ms : (ms < 100 ? '0' + ms : String(ms));
    return h + ':' + pad2(m) + ':' + pad2(whole) + '.' + msText;
  }

  function randomId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ------------------------------------------------------------------ */
  /* Logging (UI console + devtools)                                     */
  /* ------------------------------------------------------------------ */

  var LEVEL_LABEL = { debug: 'DBG', info: 'INFO', ok: 'OK', warn: 'WARN', error: 'ERR' };
  var logHistory = [];

  function appendLog(level, message) {
    var text = String(message);
    var line = clock() + ' ' + (LEVEL_LABEL[level] || level) + ' ' + text;
    logHistory.push(line);
    if (logHistory.length > CONFIG.MAX_LOG_HISTORY) { logHistory.shift(); }
    try { console.log('[QMP][' + level + '] ' + text); } catch (e) { /* devtools unavailable */ }

    if (level === 'debug' && !ui.verbose.checked) { return; }
    if (level === 'error' && ui.logBox) { ui.logBox.classList.remove('collapsed'); if (ui.toggleLogBtn) { updateLogToggle(); } }

    var row = document.createElement('div');
    row.className = 'line ' + level;
    var t = document.createElement('span');
    t.className = 't';
    t.textContent = clock();
    var l = document.createElement('span');
    l.className = 'l';
    l.textContent = LEVEL_LABEL[level] || level;
    var m = document.createElement('span');
    m.className = 'm';
    m.textContent = text;
    row.appendChild(t);
    row.appendChild(l);
    row.appendChild(m);

    var box = ui.console;
    var stick = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
    box.appendChild(row);
    while (box.childNodes.length > CONFIG.MAX_LOG_LINES) { box.removeChild(box.firstChild); }
    if (stick) { box.scrollTop = box.scrollHeight; }
  }

  function logDebug(m) { appendLog('debug', m); }
  function logInfo(m) { appendLog('info', m); }
  function logOk(m) { appendLog('ok', m); }
  function logWarn(m) { appendLog('warn', m); }
  function logError(m) { appendLog('error', m); }

  /* ------------------------------------------------------------------ */
  /* Interface language (English / Arabic)                               */
  /* ------------------------------------------------------------------ */

  var I18N_AR = {
    'Paste clipboard media at the playhead': 'الصق من الحافظة عند مؤشر التشغيل',
    'Paste to Timeline': 'الصق على التايم لاين',
    'Copy a file, image or link, then press the button.': 'انسخ ملف أو صورة أو رابط، وبعدين اضغط الزر.',
    'Working': 'عم يشتغل',
    'Cancel': 'إلغاء',
    'Placement': 'طريقة الوضع',
    'Overwrite': 'على مسار فاضي',
    'Insert': 'إدراج وإزاحة',
    'Placed on a free track, nothing gets erased.': 'بينحط على أول مسار فاضي، وما بيمسح شي.',
    'Pushes everything after it forward (ripple).': 'بيزيح كل اللي بعده لقدام.',
    'Copy local files into the project folder': 'انسخ الملفات لمجلد المشروع',
    'Keeps the project self-contained': 'بيخلي المشروع كامل ومنقول',
    'Convert WebM / MKV / OGG with ffmpeg': 'حوّل WebM / MKV / OGG بـ ffmpeg',
    'Only used if ffmpeg is installed': 'بيشتغل بس إذا ffmpeg منزّل',
    'Activity': 'السجل',
    'Verbose': 'تفصيلي',
    'Copy log': 'نسخ السجل',
    'Clear': 'مسح',
    'Starting': 'عم يبدأ',
    'Ready': 'جاهز',
    'Done': 'تم',
    'Error': 'خطأ',
    'Cancelled': 'انلغى',
    'Finished with errors': 'خلص مع أخطاء',
    'Host offline': 'Premiere مو متصل',
    'Node.js off': 'Node.js مقفل',
    'Unsupported OS': 'نظام مو مدعوم',
    'Or drag files or links onto this panel.': 'أو اسحب ملفات أو روابط وفلّتها على اللوحة.',
    'Drop to paste': 'فلّت هون للصق',
    'Recent': 'آخر العناصر',
    'Show details': 'إظهار التفاصيل',
    'Hide details': 'إخفاء التفاصيل',
    'Video track': 'مسار الفيديو',
    'Auto': 'تلقائي',
    'Image length (sec)': 'مدة الصورة (ثانية)',
    'Image size': 'حجم الصورة',
    'Fit to frame': 'ملاءمة الفريم',
    'Fit only if larger': 'ملاءمة فقط إذا أكبر',
    'Fill frame': 'ملء الفريم',
    'Original size': 'الحجم الأصلي',
    'Open folder': 'فتح المجلد',
    'Editable text (optional)': 'نص قابل للتعديل (اختياري)',
    'Title template (.mogrt)': 'قالب العنوان (.mogrt)',
    'Choose': 'اختيار',
    'When set, copied text becomes an editable Essential Graphics title using your template. Leave empty to get a text image.': 'إذا حدّدت قالباً، النص المنسوخ بيصير عنوان Essential Graphics قابل للتعديل بقالبك. اتركه فاضي للحصول على صورة نص.',
    'Sort files and bins by type': 'ترتيب الملفات والـ bin حسب النوع',
    'Images, Video, Audio, Graphics folders, same names in the project bin': 'مجلدات صور وفيديو وصوت وجرافيك، وبنفس الأسماء داخل الـ bin',
    'Click to paste again': 'انقر للصق مرة ثانية',
    'Auto-paste as soon as you copy': 'لصق تلقائي فور النسخ',
    'Images, videos, audio and media links': 'صور وفيديو وصوت وروابط وسائط',
    'Prepare on copy (instant paste)': 'تجهيز مسبق عند النسخ (لصق فوري)',
    'Saves copied files and images in the background so Paste only places them': 'يحفظ الملفات والصور المنسوخة بالخلفية فيصير اللصق مجرد وضعها على التايم لاين',
    'Watching': 'عم يراقب الحافظة',
    'Auto-paste color codes as a matte': 'لصق تلقائي لأكواد الألوان كـ Matte',
    'Copy #ff0000, rgb() or a gradient and it becomes a background': 'انسخ #ff0000 أو rgb() أو تدرج وبيصير خلفية ملونة',
    'Auto-paste copied text as a title': 'لصق تلقائي للنص المنسوخ كعنوان',
    'Text copied from another app (not Premiere); long text and links are skipped': 'نص منسوخ من برنامج ثاني (مش Premiere)؛ النص الطويل والروابط بيتجاهلهم',
    'Ctrl+V on the timeline': 'Ctrl+V على التايم لاين',
    'Copy current frame': 'انسخ الفريم الحالي',
    'Shortcuts (click, then press the keys)': 'الاختصارات (اضغط الزر ثم اضغط المفاتيح)',
    'Paste': 'لصق',
    'Reset': 'إعادة',
    'Text becomes a title on Ctrl+V': 'النص يصير عنوان عند Ctrl+V',
    'Off by default: it would also catch text you paste into Premiere fields': 'مطفي افتراضياً: لأنه بيلتقط كمان النص اللي بتلصقه بحقول Premiere',
    'Ctrl+Shift+C copies the current frame': 'Ctrl+Shift+C ينسخ الفريم الحالي',
    'Works while Premiere Pro is focused': 'بيشتغل والتركيز على Premiere',
    'Works while Premiere Pro is focused, even without clicking this panel': 'بيشتغل والتركيز على Premiere، بدون ما تضغط على هاي اللوحة',
    'Title style': 'تنسيق العنوان',
    'Font': 'الخط',
    'Size (% of height)': 'الحجم (% من الارتفاع)',
    'Text color': 'لون النص',
    'Position': 'المكان',
    'Center': 'وسط',
    'Bottom (subtitle)': 'تحت (مثل الترجمة)',
    'Top': 'فوق',
    'Bold': 'عريض',
    'Shadow': 'ظل'
  };

  function idleLabel() { return ui.auto && ui.auto.checked ? 'Watching' : 'Ready'; }

  var MSG_AR = [
    [/has not been saved/i, 'احفظ المشروع أولاً (File ▸ Save) وبعدين جرّب.'],
    [/No active sequence/i, 'افتح تسلسل (Sequence) على التايم لاين وبعدين جرّب.'],
    [/No Premiere Pro project is open/i, 'ما في مشروع مفتوح بـ Premiere.'],
    [/clipboard is empty/i, 'الحافظة فاضية. انسخ ملف أو صورة أو رابط مباشر.'],
    [/not a media URL or file path/i, 'النص المنسوخ مو رابط ولا مسار ملف.'],
    [/opens a web page, not a media file/i, 'هذا الرابط صفحة ويب مو ملف. انسخ رابط الصورة/الفيديو نفسه.'],
    [/Every unlocked .* track already has media/i, 'كل المسارات مشغولة عند المؤشر. أضف مسار أو حرّك المؤشر أو اختار إدراج.'],
    [/did not answer|not responding|hostscript/i, 'Premiere ما رد. جرّب تسكّر اللوحة وتفتحها من جديد.'],
    [/None of the assets could be placed/i, 'ما انلصق أي عنصر. شوف السبب بقائمة آخر العناصر.'],
    [/Nothing from the clipboard could be prepared/i, 'ما قدرت أجهّز أي عنصر من الحافظة. شوف السجل.']
  ];

  function friendlyError(text) {
    if (uiLang === 'ar') {
      for (var i = 0; i < MSG_AR.length; i++) { if (MSG_AR[i][0].test(text)) { return MSG_AR[i][1]; } }
    }
    return text;
  }

  function doneText(n) {
    if (uiLang === 'ar') { return 'تم لصق ' + n + (n === 1 ? ' عنصر' : ' عناصر') + ' على التايم لاين'; }
    return 'Pasted ' + n + ' item' + (n === 1 ? '' : 's') + ' to the timeline';
  }

  var lastMessage = null;

  function setMessage(kind, text) {
    lastMessage = text ? { kind: kind, text: text } : null;
    if (!lastMessage) { ui.msg.hidden = true; ui.msg.textContent = ''; return; }
    ui.msg.hidden = false;
    ui.msg.className = 'msg ' + kind;
    ui.msg.textContent = text;
  }

  function addRecent(ok, kind, name, detail, srcPath) {
    ui.recentBox.hidden = false;
    var li = document.createElement('li');
    li.className = ok ? 'ok' : 'bad';
    if (ok && srcPath) {
      li.className += ' clickable';
      li.title = tr('Click to paste again');
      li.addEventListener('click', function () {
        if (!state.busy) { runPaste([{ kind: 'file', value: srcPath }]); }
      });
    }
    var badge = document.createElement('span');
    badge.className = 'badge ' + (kind || 'file');
    badge.textContent = kind === 'video' ? 'VID' : kind === 'audio' ? 'AUD' : kind === 'image' ? 'IMG' : 'FILE';
    var body = document.createElement('span');
    body.className = 'body';
    var n = document.createElement('span');
    n.className = 'name';
    n.textContent = name;
    var d = document.createElement('span');
    d.className = 'detail';
    d.textContent = detail || '';
    body.appendChild(n);
    body.appendChild(d);
    li.appendChild(badge);
    li.appendChild(body);
    ui.recentList.insertBefore(li, ui.recentList.firstChild);
    while (ui.recentList.childNodes.length > 6) { ui.recentList.removeChild(ui.recentList.lastChild); }
  }

  function setLogCollapsed(collapsed) {
    ui.logBox.classList.toggle('collapsed', collapsed);
    updateLogToggle();
  }

  function updateLogToggle() {
    var collapsed = ui.logBox.classList.contains('collapsed');
    ui.toggleLogBtn.textContent = tr(collapsed ? 'Show details' : 'Hide details');
    ui.toggleLogBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }

  var uiLang = 'en';
  var lastStatus = { state: 'idle', text: 'Starting' };

  function tr(text) {
    return (uiLang === 'ar' && Object.prototype.hasOwnProperty.call(I18N_AR, text)) ? I18N_AR[text] : text;
  }

  function updateModeUi() {
    var mode = ui.placement.value === 'insert' ? 'insert' : 'overwrite';
    var btns = document.querySelectorAll ? document.querySelectorAll('.seg-btn') : [];
    Array.prototype.forEach.call(btns, function (b) {
      b.setAttribute('aria-checked', b.getAttribute('data-mode') === mode ? 'true' : 'false');
    });
    ui.modeHint.textContent = tr(mode === 'insert' ? 'Pushes everything after it forward (ripple).' : 'Placed on a free track, nothing gets erased.');
  }

  function applyLang() {
    var rtl = uiLang === 'ar';
    document.documentElement.setAttribute('lang', rtl ? 'ar' : 'en');
    document.documentElement.setAttribute('dir', rtl ? 'rtl' : 'ltr');
    var nodes = document.querySelectorAll ? document.querySelectorAll('[data-i18n]') : [];
    Array.prototype.forEach.call(nodes, function (el) {
      var key = el.getAttribute('data-i18n');
      el.textContent = tr(key);
    });
    ui.langBtn.textContent = rtl ? 'EN' : 'AR';
    ui.pasteLabel.textContent = tr(state.busy ? 'Working' : 'Paste to Timeline');
    ui.pill.textContent = tr(lastStatus.text);
    updateModeUi();
    updateLogToggle();
    if (lastMessage && lastMessage.kind === 'idle') { setMessage('idle', ''); }
  }

  var statusTimer = null;

  function setStatus(state, text) {
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
    ui.pill.setAttribute('data-state', state);
    lastStatus = { state: state, text: text };
    ui.pill.textContent = tr(text);
  }

  /* Returns the pill to "Ready" after a few seconds, unless something else changed it first. */
  function resetStatusSoon() {
    if (statusTimer) { clearTimeout(statusTimer); }
    statusTimer = setTimeout(function () {
      statusTimer = null;
      if (!state.busy) { setStatus('idle', idleLabel()); }
    }, 6000);
  }

  function setProgress(fraction) {
    if (fraction === false) {
      ui.progress.hidden = true;
      ui.progress.classList.remove('indeterminate');
      ui.progressBar.style.width = '0';
      return;
    }
    ui.progress.hidden = false;
    if (fraction === null || fraction === undefined || !isFinite(fraction)) {
      ui.progress.classList.add('indeterminate');
      ui.progressBar.style.width = '';
      ui.progress.removeAttribute('aria-valuenow');
      return;
    }
    ui.progress.classList.remove('indeterminate');
    var pct = Math.max(0, Math.min(1, fraction)) * 100;
    ui.progressBar.style.width = pct.toFixed(1) + '%';
    ui.progress.setAttribute('aria-valuenow', String(Math.round(pct)));
  }

  function makeProgressReporter() {
    var last = 0;
    return function (fraction) {
      var now = Date.now();
      if (fraction !== null && fraction < 1 && now - last < 90) { return; }
      last = now;
      setProgress(fraction);
    };
  }

  /* ------------------------------------------------------------------ */
  /* Node.js environment                                                 */
  /* ------------------------------------------------------------------ */

  var nodeReady = false;
  var fs, fsp, path, os, https, http, crypto, childProcess, nodeUrl;

  try {
    if (typeof require === 'function') {
      fs = require('fs');
      fsp = fs.promises;
      path = require('path');
      os = require('os');
      https = require('https');
      http = require('http');
      crypto = require('crypto');
      childProcess = require('child_process');
      nodeUrl = require('url');
      nodeReady = !!(fsp && typeof fsp.copyFile === 'function');
    }
  } catch (nodeErr) {
    nodeReady = false;
  }

  var IS_WIN = typeof process !== 'undefined' && process.platform === 'win32';
  var IS_MAC = typeof process !== 'undefined' && process.platform === 'darwin';

  /* ------------------------------------------------------------------ */
  /* Media knowledge: extensions, MIME, magic-byte sniffing              */
  /* ------------------------------------------------------------------ */

  var EXT_KIND = {};
  (function () {
    var groups = {
      video: ['mp4', 'm4v', 'mov', 'avi', 'mxf', 'mpg', 'mpeg', 'mpe', 'm2v', 'm2t', 'm2ts', 'mts', 'ts',
        'wmv', 'asf', 'flv', 'f4v', 'webm', 'mkv', '3gp', '3g2', 'r3d', 'braw', 'ari', 'dv', 'vob', 'ogv'],
      audio: ['wav', 'mp3', 'aif', 'aiff', 'aifc', 'aac', 'm4a', 'flac', 'ogg', 'oga', 'opus', 'wma', 'caf', 'ac3', 'mp2', 'bwf'],
      image: ['png', 'jpg', 'jpeg', 'jpe', 'gif', 'bmp', 'dib', 'tif', 'tiff', 'psd', 'ai', 'eps', 'tga', 'exr', 'dpx',
        'cin', 'hdr', 'jp2', 'j2k', 'pict', 'ico', 'webp', 'avif', 'heic', 'heif', 'svg',
        'cr2', 'cr3', 'nef', 'nrw', 'arw', 'dng', 'raf', 'orf', 'rw2', 'pef', 'srw', 'pdf'],
      mogrt: ['mogrt'],
      aep: ['aep']
    };
    Object.keys(groups).forEach(function (kind) {
      groups[kind].forEach(function (ext) { EXT_KIND[ext] = kind; });
    });
  })();

  /* Formats Premiere cannot import directly; they are converted to PNG first. */
  var CONVERT_EXTS = { webp: true, avif: true, heic: true, heif: true, svg: true,
    cr2: true, cr3: true, nef: true, nrw: true, arw: true, dng: true, raf: true, orf: true, rw2: true, pef: true, srw: true, pdf: true };
  /* Their file signature looks like TIFF/MP4/PDF, so the extension decides, not the sniffed type. */
  var CONVERT_BY_EXT = { cr2: 1, cr3: 1, nef: 1, nrw: 1, arw: 1, dng: 1, raf: 1, orf: 1, rw2: 1, pef: 1, srw: 1, pdf: 1 };

  /*
   * Containers Premiere Pro does not import natively. When ffmpeg is installed they are
   * converted (video -> H.264/AAC MP4, audio -> 48 kHz WAV) before being handed to Premiere.
   */
  var TRANSCODE_EXTS = { webm: 'video', mkv: 'video', ogv: 'video', ogg: 'audio', oga: 'audio', opus: 'audio' };

  var MIME_EXT = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/avif': 'avif', 'image/heic': 'heic', 'image/heif': 'heif', 'image/bmp': 'bmp', 'image/tiff': 'tif',
    'image/svg+xml': 'svg', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
    'video/x-matroska': 'mkv', 'video/x-msvideo': 'avi', 'video/mpeg': 'mpg', 'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/flac': 'flac', 'audio/ogg': 'ogg', 'audio/aiff': 'aiff',
    'audio/x-aiff': 'aiff'
  };

  var EXT_MIME = {
    png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
    heic: 'image/heic', heif: 'image/heif', svg: 'image/svg+xml', bmp: 'image/bmp', tiff: 'image/tiff'
  };

  var ISO_GROUP = { mp4: 1, m4v: 1, mov: 1, '3gp': 1, '3g2': 1, m4a: 1 };
  var EXT_EQUIV = { jpeg: 'jpg', jpe: 'jpg', tif: 'tiff', m4v: 'mp4', mpeg: 'mpg', aif: 'aiff' };

  function normExt(ext) {
    return String(ext || '').toLowerCase().replace(/^\./, '').replace(/[^a-z0-9]/g, '');
  }

  function sniffBuffer(b) {
    if (!b || b.length < 4) { return null; }
    var ascii = function (s, e) { return b.toString('latin1', s, e); };

    if (b[0] === 0x89 && ascii(1, 4) === 'PNG') { return { ext: 'png', kind: 'image' }; }
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) { return { ext: 'jpg', kind: 'image' }; }
    if (ascii(0, 4) === 'GIF8') { return { ext: 'gif', kind: 'image' }; }
    if (ascii(0, 4) === '8BPS') { return { ext: 'psd', kind: 'image' }; }

    if (ascii(0, 4) === 'RIFF' && b.length >= 12) {
      var riff = ascii(8, 12);
      if (riff === 'WEBP') { return { ext: 'webp', kind: 'image' }; }
      if (riff === 'WAVE') { return { ext: 'wav', kind: 'audio' }; }
      if (riff === 'AVI ') { return { ext: 'avi', kind: 'video' }; }
    }

    if (ascii(0, 2) === 'BM' && b.length >= 18) {
      var dib = b.readUInt32LE(14);
      if (dib === 12 || dib === 40 || dib === 52 || dib === 56 || dib === 64 || dib === 108 || dib === 124) {
        return { ext: 'bmp', kind: 'image' };
      }
    }

    if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A && b[3] === 0x00) ||
        (b[0] === 0x4D && b[1] === 0x4D && b[2] === 0x00 && b[3] === 0x2A)) {
      return { ext: 'tiff', kind: 'image' };
    }

    if (b.length >= 12 && ascii(4, 8) === 'ftyp') {
      var brand = ascii(8, 12);
      if (brand === 'avif' || brand === 'avis') { return { ext: 'avif', kind: 'image' }; }
      if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'heim' || brand === 'heis' ||
          brand === 'mif1' || brand === 'msf1') { return { ext: 'heic', kind: 'image' }; }
      if (brand === 'qt  ') { return { ext: 'mov', kind: 'video' }; }
      if (brand === 'M4A ' || brand === 'M4B ') { return { ext: 'm4a', kind: 'audio' }; }
      if (brand.slice(0, 3) === '3gp') { return { ext: '3gp', kind: 'video' }; }
      return { ext: 'mp4', kind: 'video' };
    }

    if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) {
      var ebml = b.toString('latin1', 0, Math.min(b.length, 64));
      return { ext: ebml.indexOf('webm') !== -1 ? 'webm' : 'mkv', kind: 'video', ambiguous: true };
    }

    if (b.length >= 16 && b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xB2 && b[3] === 0x75) {
      return { ext: 'wmv', kind: 'video', ambiguous: true };
    }

    if (ascii(0, 3) === 'ID3') { return { ext: 'mp3', kind: 'audio' }; }
    if (b[0] === 0xFF && (b[1] & 0xF6) === 0xF0) { return { ext: 'aac', kind: 'audio' }; }
    if (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) { return { ext: 'mp3', kind: 'audio' }; }
    if (ascii(0, 4) === 'OggS') { return { ext: 'ogg', kind: 'audio', ambiguous: true }; }
    if (ascii(0, 4) === 'fLaC') { return { ext: 'flac', kind: 'audio' }; }
    if (ascii(0, 4) === 'FORM' && b.length >= 12 && (ascii(8, 12) === 'AIFF' || ascii(8, 12) === 'AIFC')) {
      return { ext: 'aiff', kind: 'audio' };
    }

    if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && (b[3] === 0xBA || b[3] === 0xB3)) {
      return { ext: 'mpg', kind: 'video' };
    }
    if (b.length > 376 && b[0] === 0x47 && b[188] === 0x47 && b[376] === 0x47) {
      return { ext: 'ts', kind: 'video' };
    }

    var head = b.toString('utf8', 0, Math.min(b.length, CONFIG.SNIFF_BYTES)).replace(/^\uFEFF/, '').replace(/^\s+/, '').toLowerCase();
    var startsLikeMarkup = head.indexOf('<svg') === 0 || head.indexOf('<?xml') === 0 ||
      head.indexOf('<!--') === 0 || head.indexOf('<!doctype svg') === 0;
    if (startsLikeMarkup && /<svg[\s>]/.test(head)) {
      return { ext: 'svg', kind: 'image' };
    }
    if (head.indexOf('<!doctype html') === 0 || head.indexOf('<html') === 0 || head.indexOf('<head') === 0 ||
        head.indexOf('<body') === 0) {
      return { ext: 'html', kind: 'text' };
    }
    return null;
  }

  async function sniffFile(filePath) {
    var handle = await fsp.open(filePath, 'r');
    try {
      var buf = Buffer.alloc(CONFIG.SNIFF_BYTES);
      var res = await handle.read(buf, 0, CONFIG.SNIFF_BYTES, 0);
      return sniffBuffer(buf.slice(0, res.bytesRead));
    } finally {
      await handle.close();
    }
  }

  function chooseExt(hint, sniff) {
    var s = sniff.ext;
    if (!hint) { return s; }
    if (hint === s) { return hint; }
    if ((EXT_EQUIV[hint] || hint) === (EXT_EQUIV[s] || s)) { return hint; }
    if (ISO_GROUP[hint] && ISO_GROUP[s]) { return hint; }
    return s;
  }

  /* Returns { ext, kind, convert } or null when the type is unsupported. */
  function classifyMedia(sniff, extHint) {
    var hint = normExt(extHint);
    var hintKind = EXT_KIND[hint] || null;
    if (CONVERT_BY_EXT[hint]) { return { ext: hint, kind: 'image', convert: true }; }
    if (sniff) {
      if (sniff.kind === 'text') { return null; }
      if (CONVERT_EXTS[sniff.ext]) { return { ext: sniff.ext, kind: 'image', convert: true }; }
      if (sniff.ambiguous && hintKind) { return { ext: hint, kind: hintKind, convert: !!CONVERT_EXTS[hint] }; }
      var finalExt = chooseExt(hint, sniff);
      return { ext: finalExt, kind: EXT_KIND[finalExt] || sniff.kind, convert: false };
    }
    if (hintKind) { return { ext: hint, kind: hintKind, convert: !!CONVERT_EXTS[hint] }; }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* File system helpers                                                 */
  /* ------------------------------------------------------------------ */

  var WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  function sanitizeBaseName(name, fallback) {
    var s = String(name || '');
    s = s.replace(/[\u0000-\u001F\u007F]/g, '').replace(/[<>:"\/\\|?*]/g, '_').replace(/\s+/g, ' ');
    s = s.replace(/^[\s.]+|[\s.]+$/g, '');
    if (s.length > 100) { s = s.slice(0, 100).replace(/[\s.]+$/g, ''); }
    if (!s) { s = fallback || 'Pasted_Media'; }
    if (WIN_RESERVED.test(s)) { s = '_' + s; }
    return s;
  }

  var writableDirs = {};
  async function ensureWritableDir(dir) {
    if (writableDirs[dir]) {
      try { await fsp.access(dir, fs.constants.W_OK); return; } catch (e0) { writableDirs[dir] = false; }
    }
    await fsp.mkdir(dir, { recursive: true });
    var st = await fsp.stat(dir);
    if (!st.isDirectory()) { throw new Error('"' + dir + '" exists but is not a folder.'); }
    await fsp.access(dir, fs.constants.W_OK);
    var probe = path.join(dir, '.qmp_write_test_' + randomId());
    await fsp.writeFile(probe, 'ok');
    await fsp.unlink(probe);
    writableDirs[dir] = true;
  }


  /* Removes leftovers of crashed or cancelled work: old .part downloads in the paste folder and old qmp_* temp files. */
  var sweptDirs = {};
  async function sweepStale(pastedDir) {
    try {
      var now = Date.now();
      if (!sweptDirs[pastedDir]) {
        sweptDirs[pastedDir] = true;
        var names = await fsp.readdir(pastedDir);
        for (var i = 0; i < names.length; i++) {
          if (!/^\.qmp_.*\.part$/.test(names[i])) { continue; }
          var f = path.join(pastedDir, names[i]);
          try { var st = await fsp.stat(f); if (now - st.mtimeMs > CONFIG.STALE_PART_MS) { await safeUnlink(f); logDebug('Removed leftover ' + names[i]); } } catch (e1) { /* gone */ }
        }
      }
      if (!sweptDirs.__tmp) {
        sweptDirs.__tmp = true;
        var tdir = os.tmpdir();
        var tnames = await fsp.readdir(tdir);
        for (var j = 0; j < tnames.length; j++) {
          if (!/^qmp_(clip|stage|peek|frame|gen|data)_/.test(tnames[j])) { continue; }
          var tf = path.join(tdir, tnames[j]);
          try { var ts = await fsp.stat(tf); if (ts.isFile() && now - ts.mtimeMs > CONFIG.STALE_TMP_MS) { await safeUnlink(tf); } } catch (e2) { /* gone */ }
        }
      }
    } catch (e) { logDebug('Cleanup skipped: ' + errMsg(e)); }
  }

  async function reserveUniquePath(dir, base, ext) {
    for (var i = 0; i < 2000; i++) {
      var suffix = i === 0 ? '' : '_' + i;
      var candidate = path.join(dir, base + suffix + '.' + ext);
      try {
        var handle = await fsp.open(candidate, 'wx');
        await handle.close();
        return candidate;
      } catch (e) {
        if (e && e.code === 'EEXIST') { continue; }
        throw e;
      }
    }
    throw new Error('Could not find a free file name for "' + base + '" in ' + dir);
  }

  async function safeUnlink(p) {
    if (!p) { return; }
    try { await fsp.unlink(p); } catch (e) { /* already gone */ }
  }

  async function moveFile(src, dest) {
    try {
      await fsp.rename(src, dest);
    } catch (e) {
      if (e && (e.code === 'EXDEV' || e.code === 'EPERM' || e.code === 'EEXIST' || e.code === 'EBUSY')) {
        await fsp.copyFile(src, dest);
        await safeUnlink(src);
        return;
      }
      throw e;
    }
  }

  function isInside(dir, target) {
    var rel = path.relative(dir, target);
    if (!rel || path.isAbsolute(rel)) { return false; }
    return rel !== '..' && rel.indexOf('..' + path.sep) !== 0;
  }

  function copyFileStream(src, dest, ctx, onProgress) {
    return new Promise(function (resolve, reject) {
      fsp.stat(src).then(function (st) {
        var total = st.size;
        if (total > CONFIG.FAST_COPY_BYTES && CONFIG.LINK_BIG_FILES) {
          return instantCopy(src, dest).then(function (how) {
            if (how) { logDebug('Instant ' + how + ' instead of copying ' + formatBytes(total) + '.'); onProgress(1); resolve(); return null; }
            return slowCopy(st);
          });
        }
        return slowCopy(st);
      }).catch(reject);

      function slowCopy(st) {
        var total = st.size;
        if (total <= CONFIG.FAST_COPY_BYTES) {
          /* Small file: one native copy call is much faster than a JS stream. */
          return fsp.copyFile(src, dest).then(function () { onProgress(1); resolve(); });
        }
        var done = 0;
        var settled = false;
        var rs = fs.createReadStream(src, { highWaterMark: CONFIG.COPY_CHUNK_BYTES });
        var ws = fs.createWriteStream(dest, { highWaterMark: CONFIG.COPY_CHUNK_BYTES });

        function fail(err) {
          if (settled) { return; }
          settled = true;
          ctx.abort = null;
          try { rs.destroy(); } catch (e1) { /* ignore */ }
          var finish = function () { reject(err); };
          if (ws.closed || ws.destroyed) { finish(); return; }
          ws.once('close', finish);
          try { ws.destroy(); } catch (e2) { finish(); }
        }

        ctx.abort = function () { fail(new Error('Cancelled by user')); };
        rs.on('error', fail);
        ws.on('error', fail);
        rs.on('data', function (chunk) {
          done += chunk.length;
          if (total > 0) { onProgress(done / total); }
        });
        ws.on('close', function () {
          if (settled) { return; }
          settled = true;
          ctx.abort = null;
          if (done !== total) { reject(new Error('Copy was incomplete (' + done + ' of ' + total + ' bytes).')); }
          else { resolve(); }
        });
        rs.pipe(ws);
      }
    });
  }

  /* Big files: a copy-on-write clone (APFS, ReFS) or a hard link (same volume) takes no time and no extra disk space. */
  async function instantCopy(src, dest) {
    try { await fsp.copyFile(src, dest, fs.constants.COPYFILE_FICLONE_FORCE); return 'clone'; } catch (e1) { /* not supported here */ }
    try {
      try { await fsp.unlink(dest); } catch (eU) { /* a failed clone already removed the placeholder */ }
      await fsp.link(src, dest);
      return 'link';
    } catch (e2) {
      try { var h = await fsp.open(dest, 'wx'); await h.close(); } catch (e3) { /* the stream below recreates it */ }
      return '';
    }
  }

  /* ------------------------------------------------------------------ */
  /* Child processes                                                     */
  /* ------------------------------------------------------------------ */

  function execFileP(file, args, options, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var opts = Object.assign({
        timeout: timeoutMs || 30000,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8'
      }, options || {});
      try {
        childProcess.execFile(file, args, opts, function (err, stdout, stderr) {
          if (err) {
            var detail = (stderr && String(stderr).trim()) || err.message;
            var wrapped = new Error(path.basename(file) + ' failed: ' + truncate(detail, 600));
            wrapped.code = err.code;
            wrapped.killed = err.killed;
            wrapped.stdout = String(stdout || '');
            wrapped.stderr = String(stderr || '');
            reject(wrapped);
            return;
          }
          resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
      } catch (spawnErr) {
        reject(spawnErr);
      }
    });
  }

  function extractMarker(text, marker) {
    var idx = String(text || '').indexOf(marker);
    if (idx === -1) { return null; }
    var rest = text.slice(idx + marker.length);
    var nl = rest.search(/\r?\n/);
    return (nl === -1 ? rest : rest.slice(0, nl)).trim();
  }

  /* ------------------------------------------------------------------ */
  /* Clipboard: Windows (PowerShell)                                     */
  /* ------------------------------------------------------------------ */

  /* Name of the process that owns the clipboard, so text copied inside Premiere itself is never auto-pasted. */
  var WIN_OWN_TYPE_PS = `try { Add-Type -Namespace QMP -Name Own -MemberDefinition '[DllImport("user32.dll")] static extern IntPtr GetClipboardOwner(); [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); public static string Name() { IntPtr o = GetClipboardOwner(); if (o == IntPtr.Zero) { return ""; } uint pid; GetWindowThreadProcessId(o, out pid); try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { return ""; } }' } catch { }`;

  var WIN_CLIPBOARD_PS = `
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
${WIN_OWN_TYPE_PS}
$outPng = $env:QMP_OUT_PNG
$res = @{ ok = $true; files = @(); text = ''; image = ''; error = ''; owner = '' }
$lastError = ''
try { $res.owner = [string][QMP.Own]::Name() } catch { }
for ($attempt = 1; $attempt -le 6; $attempt++) {
  try {
    $res.files = @()
    $res.text = ''
    $res.image = ''
    if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
      $list = [System.Windows.Forms.Clipboard]::GetFileDropList()
      $arr = New-Object System.Collections.ArrayList
      foreach ($f in $list) { [void]$arr.Add([string]$f) }
      $res.files = $arr.ToArray()
    }
    if ($res.files.Count -eq 0) {
      if ([System.Windows.Forms.Clipboard]::ContainsData('PNG')) {
        $stream = [System.Windows.Forms.Clipboard]::GetData('PNG')
        if ($stream -is [System.IO.Stream]) {
          $out = [System.IO.File]::Create($outPng)
          try { [void]$stream.Seek(0, 'Begin'); $stream.CopyTo($out) } finally { $out.Dispose() }
          if ((Get-Item -LiteralPath $outPng).Length -gt 0) { $res.image = $outPng }
        }
      }
      if ($res.image -eq '' -and [System.Windows.Forms.Clipboard]::ContainsImage()) {
        $img = [System.Windows.Forms.Clipboard]::GetImage()
        if ($img -ne $null) {
          try { $img.Save($outPng, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $img.Dispose() }
          $res.image = $outPng
        }
      }
      if ($res.image -eq '' -and [System.Windows.Forms.Clipboard]::ContainsText()) {
        $t = [System.Windows.Forms.Clipboard]::GetText([System.Windows.Forms.TextDataFormat]::UnicodeText)
        if ($t.Length -gt 200000) { $t = $t.Substring(0, 200000) }
        $res.text = $t
      }
    }
    $lastError = ''
    break
  } catch {
    $lastError = $_.Exception.Message
    Start-Sleep -Milliseconds 150
  }
}
if ($lastError -ne '') { $res.ok = $false; $res.error = $lastError }
$json = ConvertTo-Json -Compress -Depth 4 -InputObject $res
Write-Output ('QMP_B64:' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json)))
`;

  var WIN_WIC_CONVERT_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore
$src = $env:QMP_SRC
$dst = $env:QMP_DST
$uri = New-Object System.Uri($src)
$decoder = [System.Windows.Media.Imaging.BitmapDecoder]::Create($uri, [System.Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat, [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
$encoder = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
$encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($decoder.Frames[0]))
$out = [System.IO.File]::Create($dst)
try { $encoder.Save($out) } finally { $out.Dispose() }
Write-Output 'QMP_OK'
`;

  function powershellExe() {
    var root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    var full = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try { if (fs.existsSync(full)) { return full; } } catch (e) { /* fall through */ }
    return 'powershell.exe';
  }

  function runPowerShell(script, env, timeoutMs) {
    var encoded = Buffer.from(script, 'utf16le').toString('base64');
    return execFileP(powershellExe(),
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { env: Object.assign({}, process.env, env || {}) }, timeoutMs);
  }

  /*
   * Starting PowerShell and loading System.Windows.Forms costs about a second on every paste.
   * A single long-lived STA PowerShell process answers clipboard requests in milliseconds.
   * Any failure falls back to the one-shot reader below, so this can only make things faster.
   */
  var winWorker = { proc: null, ready: false, buf: '', waiter: null, failed: false };

  function killWinWorker() {
    var p = winWorker.proc;
    winWorker.proc = null;
    winWorker.ready = false;
    if (winWorker.waiter) { var w = winWorker.waiter; winWorker.waiter = null; w.reject(new Error('Clipboard worker stopped.')); }
    if (p) { try { p.kill(); } catch (e) { /* already gone */ } }
  }

  function startWinWorker() {
    if (!IS_WIN || winWorker.proc || winWorker.failed) { return; }
    var body = WIN_CLIPBOARD_PS.split('$outPng = $env:QMP_OUT_PNG\n')[1];
    if (!body) { winWorker.failed = true; return; }
    body = body.replace('Write-Output (', 'return (');
    var script = [
      "$ErrorActionPreference = 'Stop'",
      'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }',
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$seqOk = $true',
      WIN_OWN_TYPE_PS,
      "try { Add-Type -Namespace QMP -Name Native -MemberDefinition '[DllImport(\"user32.dll\")] public static extern uint GetClipboardSequenceNumber();' } catch { $seqOk = $false }",
      'function Read-Clip([string]$outPng) {',
      body,
      '}',
      '$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)',
      '$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))',
      '$stdout.AutoFlush = $true',
      "$stdout.WriteLine('QMP_READY')",
      'while ($true) {',
      '  $line = $stdin.ReadLine()',
      '  if ($line -eq $null) { break }',
      "  if ($line -eq 'SEQ') {",
      "    if ($seqOk) { $stdout.WriteLine('QMP_SEQ:' + [QMP.Native]::GetClipboardSequenceNumber()) } else { $stdout.WriteLine('QMP_SEQ:-1') }",
      '  }',
      "  if ($line.StartsWith('READ:')) {",
      '    try {',
      '      $p = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring(5)))',
      '      $r = @(Read-Clip $p)',
      '      $stdout.WriteLine([string]$r[$r.Count - 1])',
      '    } catch {',
      '      $j = ConvertTo-Json -Compress -InputObject @{ ok = $false; files = @(); text = \'\'; image = \'\'; error = $_.Exception.Message }',
      "      $stdout.WriteLine('QMP_B64:' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($j)))",
      '    }',
      '  }',
      '}'
    ].join('\n');
    var encoded = Buffer.from(script, 'utf16le').toString('base64');
    try {
      var proc = childProcess.spawn(powershellExe(),
        ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      winWorker.proc = proc;
      winWorker.buf = '';
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', function (chunk) {
        winWorker.buf += chunk;
        var nl;
        while ((nl = winWorker.buf.search(/\r?\n/)) !== -1) {
          var line = winWorker.buf.slice(0, nl).trim();
          winWorker.buf = winWorker.buf.slice(winWorker.buf.indexOf('\n', nl) + 1);
          if (line === 'QMP_READY') { winWorker.ready = true; logDebug('Clipboard worker ready.'); }
          else if (winWorker.waiter && line.indexOf(winWorker.waiter.prefix) === 0) {
            var w = winWorker.waiter;
            winWorker.waiter = null;
            w.resolve(line.slice(w.prefix.length));
          }
        }
      });
      proc.stdin.on('error', function () { /* process ended */ });
      proc.on('error', function () { if (winWorker.proc === proc) { winWorker.failed = true; killWinWorker(); } });
      proc.on('exit', function () { if (winWorker.proc === proc) { winWorker.proc = null; winWorker.ready = false; if (winWorker.waiter) { var w = winWorker.waiter; winWorker.waiter = null; w.reject(new Error('Clipboard worker exited.')); } } });
    } catch (e) {
      winWorker.failed = true;
      winWorker.proc = null;
    }
  }

  function workerRead(tmpPng) {
    return new Promise(function (resolve, reject) {
      if (!winWorker.proc || !winWorker.ready || winWorker.waiter) { reject(new Error('Clipboard worker not ready.')); return; }
      var timer = setTimeout(function () {
        if (winWorker.waiter) { winWorker.waiter = null; reject(new Error('Clipboard worker timed out.')); }
      }, 6000);
      winWorker.waiter = {
        prefix: 'QMP_B64:',
        resolve: function (v) { clearTimeout(timer); resolve(v); },
        reject: function (e) { clearTimeout(timer); reject(e); }
      };
      try { winWorker.proc.stdin.write('READ:' + Buffer.from(tmpPng, 'utf8').toString('base64') + '\n'); }
      catch (e) { clearTimeout(timer); winWorker.waiter = null; reject(e); }
    });
  }

  function workerSeq() {
    return new Promise(function (resolve, reject) {
      if (!winWorker.proc || !winWorker.ready || winWorker.waiter) { reject(new Error('Clipboard worker not ready.')); return; }
      var timer = setTimeout(function () {
        if (winWorker.waiter) { winWorker.waiter = null; reject(new Error('Clipboard worker timed out.')); }
      }, 4000);
      winWorker.waiter = {
        prefix: 'QMP_SEQ:',
        resolve: function (v) { clearTimeout(timer); resolve(v); },
        reject: function (e) { clearTimeout(timer); reject(e); }
      };
      try { winWorker.proc.stdin.write('SEQ\n'); }
      catch (e) { clearTimeout(timer); winWorker.waiter = null; reject(e); }
    });
  }

  var WIN_SEQ_PS = "Add-Type -Namespace QMP -Name Native -MemberDefinition '[DllImport(\"user32.dll\")] public static extern uint GetClipboardSequenceNumber();'\n" +
    "Write-Output ('QMP_SEQ:' + [QMP.Native]::GetClipboardSequenceNumber())\n";

  var MAC_SEQ_JXA = "ObjC.import('AppKit'); 'QMP_SEQ:' + Number($.NSPasteboard.generalPasteboard.changeCount);";

  /* A number that changes every time anything is copied. Returns null when it cannot be read. */
  async function getClipSeq() {
    if (IS_WIN) {
      if (winWorker.proc && !winWorker.ready && !winWorker.failed) { return null; }
      if (winWorker.proc && winWorker.ready) {
        try {
          var n = parseInt(await workerSeq(), 10);
          if (isFinite(n) && n >= 0) { return String(n); }
        } catch (e1) { /* fall back to the one-shot reader */ }
      }
      try {
        var r = await runPowerShell(WIN_SEQ_PS, {}, 8000);
        var m = parseInt(extractMarker(r.stdout, 'QMP_SEQ:'), 10);
        return isFinite(m) ? String(m) : null;
      } catch (e2) { return null; }
    }
    if (IS_MAC) {
      try {
        var r2 = await execFileP('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_SEQ_JXA], {}, 5000);
        var m2 = parseInt(extractMarker(r2.stdout, 'QMP_SEQ:') || extractMarker(r2.stderr, 'QMP_SEQ:'), 10);
        return isFinite(m2) ? String(m2) : null;
      } catch (e3) { return null; }
    }
    return null;
  }

  var lastClipReader = '';
  async function readClipboardWindows(tmpPng) {
    lastClipReader = 'worker';
    if (winWorker.proc && winWorker.ready) {
      try {
        var fastB64 = await workerRead(tmpPng);
        var fast = JSON.parse(Buffer.from(fastB64, 'base64').toString('utf8'));
        if (fast.ok) { return normalizeClip(fast); }
        logDebug('Clipboard worker error: ' + (fast.error || 'unknown') + '. Using the slower reader.');
      } catch (workerErr) {
        logDebug('Clipboard worker failed (' + errMsg(workerErr) + '). Using the slower reader.');
        winWorker.failed = true;
        killWinWorker();
      }
    }
    lastClipReader = 'powershell, slow';
    var r = await runPowerShell(WIN_CLIPBOARD_PS, { QMP_OUT_PNG: tmpPng }, CONFIG.CLIPBOARD_TIMEOUT_MS);
    var b64 = extractMarker(r.stdout, 'QMP_B64:');
    if (!b64) { throw new Error('PowerShell returned no clipboard data. ' + truncate(r.stderr, 300)); }
    var parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    if (!parsed.ok) { throw new Error('Windows clipboard error: ' + (parsed.error || 'unknown')); }
    return normalizeClip(parsed);
  }

  /* ------------------------------------------------------------------ */
  /* Clipboard: macOS (osascript, JXA with AppleScript fallback)         */
  /* ------------------------------------------------------------------ */

  var MAC_JXA_BODY = `
ObjC.import('AppKit');
ObjC.import('Foundation');
function str(o) {
  try { var v = ObjC.unwrap(o); return (typeof v === 'string') ? v : ''; } catch (e) { return ''; }
}
function run() {
  var res = { ok: true, files: [], text: '', image: '', error: '', notes: [] };
  try {
    var pb = $.NSPasteboard.generalPasteboard;
    var seen = {};
    var addFile = function (p) { if (p && !seen[p]) { seen[p] = true; res.files.push(p); } };

    try {
      var classes = $.NSArray.arrayWithObject($.NSURL);
      var opts = $.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true), $.NSPasteboardURLReadingFileURLsOnlyKey);
      var urls = pb.readObjectsForClassesOptions(classes, opts);
      var n = urls ? Number(urls.count) : 0;
      for (var i = 0; i < n; i++) { addFile(str(urls.objectAtIndex(i).path)); }
    } catch (e1) { res.notes.push('readObjects: ' + e1); }

    if (res.files.length === 0) {
      try {
        var list = pb.propertyListForType('NSFilenamesPboardType');
        var m = list ? Number(list.count) : 0;
        for (var j = 0; j < m; j++) { addFile(str(list.objectAtIndex(j))); }
      } catch (e2) { res.notes.push('NSFilenamesPboardType: ' + e2); }
    }

    if (res.files.length === 0) {
      try {
        var fu = str(pb.stringForType('public.file-url'));
        if (fu) { addFile(str($.NSURL.URLWithString(fu).path)); }
      } catch (e3) { res.notes.push('public.file-url: ' + e3); }
    }

    if (res.files.length === 0) {
      try {
        var png = pb.dataForType('public.png');
        if (png && Number(png.length) > 0) {
          if (png.writeToFileAtomically(OUT, true)) { res.image = OUT; }
        }
        if (!res.image) {
          var tiff = pb.dataForType('public.tiff');
          if (tiff && Number(tiff.length) > 0) {
            var rep = $.NSBitmapImageRep.imageRepWithData(tiff);
            if (rep) {
              var pngData = rep.representationUsingTypeProperties(4, $.NSDictionary.dictionary);
              if (pngData && pngData.writeToFileAtomically(OUT, true)) { res.image = OUT; }
            }
          }
        }
      } catch (e4) { res.notes.push('image: ' + e4); }
    }

    if (res.files.length === 0 && !res.image) {
      try {
        var text = str(pb.stringForType('public.utf8-plain-text'));
        if (text.length > 200000) { text = text.slice(0, 200000); }
        res.text = text;
      } catch (e5) { res.notes.push('text: ' + e5); }
    }
  } catch (fatal) {
    res.ok = false;
    res.error = String(fatal);
  }
  return 'QMP_JSON:' + JSON.stringify(res);
}
`;

  var MAC_APPLESCRIPT_FALLBACK = [
    'try',
    '  return "QMP_FILE:" & POSIX path of (the clipboard as \u00ABclass furl\u00BB)',
    'end try',
    'try',
    '  return "QMP_TEXT:" & (the clipboard as text)',
    'end try',
    'return "QMP_EMPTY:"'
  ].join('\n');

  function buildMacScript(outPng) {
    return 'var OUT = ' + JSON.stringify(outPng) + ';\n' + MAC_JXA_BODY;
  }

  async function readClipboardMac(tmpPng) {
    var primaryError;
    try {
      var r = await execFileP('/usr/bin/osascript', ['-l', 'JavaScript', '-e', buildMacScript(tmpPng)], {}, CONFIG.CLIPBOARD_TIMEOUT_MS);
      var payload = extractMarker(r.stdout, 'QMP_JSON:') || extractMarker(r.stderr, 'QMP_JSON:');
      if (!payload) { throw new Error('osascript returned no clipboard data. ' + truncate(r.stderr, 300)); }
      var parsed = JSON.parse(payload);
      if (parsed.notes && parsed.notes.length) { logDebug('JXA notes: ' + parsed.notes.join(' | ')); }
      if (parsed.ok) { return normalizeClip(parsed); }
      primaryError = new Error(parsed.error || 'JXA clipboard read failed');
    } catch (e) {
      primaryError = e;
    }

    logWarn('Primary macOS clipboard reader failed (' + errMsg(primaryError) + '). Trying the AppleScript fallback.');
    var r2 = await execFileP('/usr/bin/osascript', ['-e', MAC_APPLESCRIPT_FALLBACK], {}, CONFIG.CLIPBOARD_TIMEOUT_MS);
    var out = r2.stdout.replace(/\s+$/, '');
    var fileIdx = out.indexOf('QMP_FILE:');
    if (fileIdx !== -1) { return normalizeClip({ files: [out.slice(fileIdx + 9).trim()] }); }
    var textIdx = out.indexOf('QMP_TEXT:');
    if (textIdx !== -1) { return normalizeClip({ text: out.slice(textIdx + 9) }); }
    return normalizeClip({});
  }

  /* ------------------------------------------------------------------ */
  /* Clipboard: shared                                                   */
  /* ------------------------------------------------------------------ */

  function normalizeClip(raw) {
    var files = raw && raw.files;
    if (typeof files === 'string') { files = [files]; }
    if (!Array.isArray(files)) { files = []; }
    files = files.filter(function (f) { return typeof f === 'string' && f.length > 0; });
    return {
      files: files,
      text: raw && typeof raw.text === 'string' ? raw.text : '',
      image: raw && typeof raw.image === 'string' ? raw.image : '',
      owner: raw && typeof raw.owner === 'string' ? raw.owner : ''
    };
  }

  async function readClipboard(tmpPng) {
    if (IS_WIN) { return readClipboardWindows(tmpPng); }
    if (IS_MAC) { return readClipboardMac(tmpPng); }
    throw new Error('Unsupported operating system: ' + (typeof process !== 'undefined' ? process.platform : 'unknown'));
  }

  function stripQuotes(s) {
    return s.replace(/^["'\u201C\u2018]+|["'\u201D\u2019]+$/g, '').trim();
  }

  function looksLikeAbsolutePath(s) {
    return /^[A-Za-z]:[\\\/]/.test(s) || /^\\\\[^\\]+\\[^\\]+/.test(s) || /^\//.test(s) || /^~\//.test(s);
  }

  function fileUrlToPath(u) {
    if (nodeUrl && typeof nodeUrl.fileURLToPath === 'function') { return nodeUrl.fileURLToPath(u); }
    var p = decodeURIComponent(u.replace(/^file:\/\//i, ''));
    if (IS_WIN) { p = p.replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\'); }
    return p;
  }

  function parseClipboardText(text) {
    var items = [];
    var ignored = 0;
    var lines = String(text).split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    if (lines.length > CONFIG.MAX_CLIPBOARD_ITEMS) { lines = lines.slice(0, CONFIG.MAX_CLIPBOARD_ITEMS); }
    lines.forEach(function (line) {
      var s = stripQuotes(line);
      if (/^data:/i.test(s)) {
        items.push({ kind: 'dataurl', value: s });
      } else if (/^https?:\/\//i.test(s)) {
        items.push({ kind: 'url', value: s });
      } else if (/^file:\/\//i.test(s)) {
        try { items.push({ kind: 'file', value: fileUrlToPath(s) }); } catch (e) { ignored++; }
      } else if (looksLikeAbsolutePath(s)) {
        var p = s;
        if (/^~\//.test(p)) { p = path.join(os.homedir(), p.slice(2)); }
        items.push({ kind: 'file', value: p });
      } else {
        ignored++;
      }
    });
    return { items: items, ignored: ignored };
  }

  function describeItem(item) {
    if (item.kind === 'file') { return path.basename(item.value); }
    if (item.kind === 'url') { return truncate(item.value.replace(/^https?:\/\//i, ''), 64); }
    if (item.kind === 'dataurl') { return 'data URL'; }
    if (item.kind === 'color') { return 'color matte'; }
    if (item.kind === 'text') { return 'title: ' + truncate(String(item.value).replace(/\s+/g, ' '), 32); }
    return 'clipboard image';
  }

  /* ------------------------------------------------------------------ */
  /* Network: asynchronous download to disk                              */
  /* ------------------------------------------------------------------ */

  function filenameFromDisposition(header) {
    if (!header) { return ''; }
    var m = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
    if (m) {
      try { return decodeURIComponent(m[2].trim().replace(/^"|"$/g, '')); } catch (e) { /* try next form */ }
    }
    m = /filename\s*=\s*"([^"]+)"/i.exec(header) || /filename\s*=\s*([^;]+)/i.exec(header);
    return m ? m[1].trim() : '';
  }

  function filenameFromUrl(u) {
    try {
      var last = new URL(u).pathname.split('/').pop() || '';
      try { return decodeURIComponent(last); } catch (e) { return last; }
    } catch (e2) {
      return '';
    }
  }

  function downloadUrlOnce(urlStr, destDir, ctx, onProgress) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var redirects = 0;
      var req = null;
      var res = null;
      var ws = null;
      var wsClosed = true;
      var wroteAll = false;
      var partPath = null;
      var received = 0;
      var meta = { contentType: '', nameHint: '' };

      function cleanup(done) {
        try { if (res) { res.destroy(); } } catch (e1) { /* ignore */ }
        try {
          if (req) { if (typeof req.destroy === 'function') { req.destroy(); } else { req.abort(); } }
        } catch (e2) { /* ignore */ }
        var finish = function () {
          if (partPath) { fsp.unlink(partPath).catch(function () { /* ignore */ }).then(done); }
          else { done(); }
        };
        if (ws && !wsClosed) { ws.once('close', finish); try { ws.destroy(); } catch (e3) { finish(); } }
        else { finish(); }
      }

      function fail(err) {
        if (settled) { return; }
        settled = true;
        ctx.abort = null;
        cleanup(function () { reject(err); });
      }

      ctx.abort = function () { fail(new Error('Cancelled by user')); };

      function request(target) {
        var parsed;
        try { parsed = new URL(target); } catch (e) { fail(new Error('Invalid URL: ' + truncate(target, 120))); return; }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          fail(new Error('Only http and https URLs are supported (got ' + parsed.protocol + ').'));
          return;
        }
        var lib = parsed.protocol === 'https:' ? https : http;
        var options = {
          headers: {
            'User-Agent': CONFIG.USER_AGENT,
            'Accept': 'image/*,video/*,audio/*;q=0.9,*/*;q=0.5',
            'Accept-Encoding': 'identity',
            'Referer': parsed.origin + '/'
          },
          timeout: CONFIG.DOWNLOAD_IDLE_TIMEOUT_MS
        };
        try {
          req = lib.get(parsed.href, options, onResponse);
        } catch (e2) {
          fail(e2);
          return;
        }
        req.on('timeout', function () { fail(new Error('The server stopped responding (timed out).')); });
        req.on('error', function (e3) { fail(e3); });

        function onResponse(response) {
          res = response;
          var status = response.statusCode || 0;

          if (status >= 300 && status < 400 && response.headers.location) {
            response.resume();
            redirects++;
            if (redirects > CONFIG.MAX_REDIRECTS) { fail(new Error('Too many redirects.')); return; }
            var next;
            try { next = new URL(response.headers.location, parsed.href).href; }
            catch (e4) { fail(new Error('Bad redirect target.')); return; }
            logDebug('Redirect ' + redirects + ' to ' + truncate(next, 120));
            request(next);
            return;
          }

          if (status !== 200) {
            response.resume();
            fail(new Error('Server answered HTTP ' + status + (response.statusMessage ? ' ' + response.statusMessage : '') + '.'));
            return;
          }

          var ctype = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
          if (ctype === 'text/html' || ctype === 'application/xhtml+xml' || ctype === 'application/json') {
            response.resume();
            fail(new Error('That link opens a web page, not a media file. Copy the direct file or image address instead.'));
            return;
          }

          var length = parseInt(response.headers['content-length'], 10);
          if (isFinite(length) && length > CONFIG.MAX_DOWNLOAD_BYTES) {
            response.resume();
            fail(new Error('File is too large (' + formatBytes(length) + ').'));
            return;
          }

          meta.contentType = ctype;
          meta.nameHint = filenameFromDisposition(response.headers['content-disposition']) || filenameFromUrl(parsed.href);
          partPath = path.join(destDir, '.qmp_' + randomId() + '.part');
          ws = fs.createWriteStream(partPath);
          wsClosed = false;
          ws.on('close', function () {
            wsClosed = true;
            if (settled) { return; }
            if (!wroteAll) { fail(new Error('Download was interrupted.')); return; }
            settled = true;
            ctx.abort = null;
            resolve({ partPath: partPath, bytes: received, contentType: meta.contentType, nameHint: meta.nameHint });
          });
          ws.on('error', fail);
          ws.on('finish', function () {
            if (isFinite(length) && received !== length) {
              fail(new Error('Download incomplete (' + formatBytes(received) + ' of ' + formatBytes(length) + ').'));
              return;
            }
            if (received === 0) { fail(new Error('The server sent an empty file.')); return; }
            wroteAll = true;
          });

          response.on('data', function (chunk) {
            received += chunk.length;
            if (received > CONFIG.MAX_DOWNLOAD_BYTES) { fail(new Error('Download exceeded the size limit.')); return; }
            onProgress(isFinite(length) && length > 0 ? received / length : null);
          });
          response.on('aborted', function () { fail(new Error('Connection closed before the download finished.')); });
          response.on('error', fail);
          response.pipe(ws);
        }
      }

      request(urlStr);
    });
  }


  /* Errors worth a second try: dropped connections, timeouts, HTTP 408/425/429 and 5xx. Never user cancels or 4xx. */
  function isTransientDownloadError(err) {
    var m = errMsg(err);
    if (/Cancelled by user/.test(m)) { return false; }
    if (/HTTP (408|425|429|5\d\d)\b/.test(m)) { return true; }
    if (/HTTP \d{3}/.test(m)) { return false; }
    if (/timed out|interrupted|Connection closed|incomplete|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up/i.test(m)) { return true; }
    return false;
  }

  async function downloadUrl(urlStr, destDir, ctx, onProgress) {
    var attempts = CONFIG.DOWNLOAD_RETRIES + 1;
    var lastErr = null;
    for (var attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await downloadUrlOnce(urlStr, destDir, ctx, onProgress);
      } catch (e) {
        lastErr = e;
        if (attempt >= attempts || !isTransientDownloadError(e) || (state.cancelled)) { throw e; }
        var wait = CONFIG.DOWNLOAD_RETRY_BASE_MS * attempt;
        logWarn('Download failed (' + errMsg(e) + '). Retrying in ' + Math.round(wait / 1000) + ' s (' + attempt + '/' + CONFIG.DOWNLOAD_RETRIES + ')...');
        await sleep(wait);
        if (state.cancelled) { throw new Error('Cancelled by user'); }
      }
    }
    throw lastErr;
  }

  /* ------------------------------------------------------------------ */
  /* Conversion to PNG                                                   */
  /* ------------------------------------------------------------------ */

  var SVG_UNITS = { '': 1, px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, 'in': 96, em: 16 };

  function svgLength(value) {
    if (value === null || value === undefined) { return 0; }
    var m = /^\s*([0-9]*\.?[0-9]+)\s*([a-z%]*)\s*$/i.exec(String(value));
    if (!m) { return 0; }
    var unit = m[2].toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(SVG_UNITS, unit)) { return 0; }
    return parseFloat(m[1]) * SVG_UNITS[unit];
  }

  /*
   * Browsers rasterise an SVG at its declared size, and many files have none (viewBox only) or
   * are tiny icons. Give the root element an explicit, sensibly large pixel size so the PNG is
   * crisp, and make sure it has the xmlns the image decoder insists on.
   */
  function prepareSvg(buffer) {
    var text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    var m = /<svg\b[^>]*>/i.exec(text);
    if (!m) { throw new Error('This SVG file has no <svg> element.'); }
    var tag = m[0];

    function attr(name) {
      var r = new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i').exec(tag);
      return r ? (r[1] !== undefined ? r[1] : r[2]) : null;
    }

    var w = svgLength(attr('width'));
    var h = svgLength(attr('height'));
    var vb = attr('viewBox');
    var vbW = 0;
    var vbH = 0;
    if (vb) {
      var nums = vb.trim().split(/[\s,]+/).map(parseFloat);
      if (nums.length === 4 && isFinite(nums[2]) && isFinite(nums[3]) && nums[2] > 0 && nums[3] > 0) { vbW = nums[2]; vbH = nums[3]; }
    }
    if (!(w > 0) && !(h > 0)) { w = vbW; h = vbH; }
    else if (!(w > 0)) { w = vbW > 0 ? h * (vbW / vbH) : h; }
    else if (!(h > 0)) { h = vbW > 0 ? w * (vbH / vbW) : w; }
    if (!(w > 0) || !(h > 0)) { w = 1024; h = 1024; }

    var longest = Math.max(w, h);
    var scale = 1;
    if (longest < 1024) { scale = CONFIG.SVG_TARGET_SIDE / longest; }
    else if (longest > 4096) { scale = 4096 / longest; }
    var outW = Math.max(1, Math.round(w * scale));
    var outH = Math.max(1, Math.round(h * scale));

    var extra = '';
    if (!/\sxmlns\s*=/.test(tag)) { extra += ' xmlns="http://www.w3.org/2000/svg"'; }
    if (!vb) { extra += ' viewBox="0 0 ' + w + ' ' + h + '"'; }
    var cleaned = tag.replace(/\s(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*')/gi, '');
    var rewritten = cleaned.replace(/\s*\/?>$/, function (end) {
      return extra + ' width="' + outW + '" height="' + outH + '"' + end;
    });
    var out = text.slice(0, m.index) + rewritten + text.slice(m.index + tag.length);
    return { buffer: Buffer.from(out, 'utf8'), width: outW, height: outH };
  }

  function decodeToPngViaCanvas(buffer, mime, forcedSize) {
    return new Promise(function (resolve, reject) {
      var url = null;
      function done(err, result) {
        if (url) { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }
        if (err) { reject(err); } else { resolve(result); }
      }
      try {
        var bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
        url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        var img = new Image();
        img.onerror = function () { done(new Error('The built-in image decoder could not read this file.')); };
        img.onload = function () {
          try {
            var w = (forcedSize && forcedSize.width) || img.naturalWidth || 0;
            var h = (forcedSize && forcedSize.height) || img.naturalHeight || 0;
            if (!w || !h) { done(new Error('Decoded image has no size.')); return; }
            if (w * h > CONFIG.MAX_CANVAS_PIXELS) { done(new Error('Image is too large to convert (' + w + 'x' + h + ').')); return; }
            var canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            var ctx2d = canvas.getContext('2d');
            ctx2d.drawImage(img, 0, 0, w, h);
            canvas.toBlob(function (blob) {
              if (!blob) { done(new Error('Canvas could not encode PNG.')); return; }
              var reader = new FileReader();
              reader.onerror = function () { done(new Error('Could not read the encoded PNG.')); };
              reader.onload = function () { done(null, Buffer.from(new Uint8Array(reader.result))); };
              reader.readAsArrayBuffer(blob);
            }, 'image/png');
          } catch (drawErr) {
            done(drawErr);
          }
        };
        img.src = url;
      } catch (e) {
        done(e);
      }
    });
  }

  async function convertWithSips(src, dest) {
    await execFileP('/usr/bin/sips', ['-s', 'format', 'png', src, '--out', dest], {}, CONFIG.CONVERT_TIMEOUT_MS);
  }

  async function convertWithWic(src, dest) {
    var r = await runPowerShell(WIN_WIC_CONVERT_PS, { QMP_SRC: src, QMP_DST: dest }, CONFIG.CONVERT_TIMEOUT_MS);
    if (r.stdout.indexOf('QMP_OK') === -1) { throw new Error('Windows imaging codec produced no output.'); }
  }

  async function convertPdfExternal(srcPath, destPath) {
    var tools = [
      ['magick', ['-density', '200', srcPath + '[0]', '-background', 'white', '-alpha', 'remove', destPath]],
      ['pdftoppm', ['-png', '-r', '200', '-f', '1', '-l', '1', '-singlefile', srcPath, destPath.replace(/\.png$/i, '')]],
      ['mutool', ['draw', '-r', '200', '-o', destPath, srcPath, '1']],
      [IS_WIN ? 'gswin64c' : 'gs', ['-q', '-dNOPAUSE', '-dBATCH', '-dFirstPage=1', '-dLastPage=1', '-sDEVICE=png16m', '-r200', '-sOutputFile=' + destPath, srcPath]]
    ];
    for (var i = 0; i < tools.length; i++) {
      try {
        await execFileP(tools[i][0], tools[i][1], {}, 120000);
        var st = await fsp.stat(destPath);
        if (st.size) { return; }
      } catch (e) { /* tool missing or failed, try the next one */ }
    }
    throw new Error('No PDF converter found. Install ImageMagick or poppler (pdftoppm) to paste PDFs on Windows.');
  }

  async function convertToPng(srcPath, destPath, info) {
    var label = info.ext.toUpperCase();
    var canvasError = null;
    if (info.ext === 'pdf') {
      if (IS_MAC) { await convertWithSips(srcPath, destPath); } else { await convertPdfExternal(srcPath, destPath); }
      return;
    }
    try {
      var data = await fsp.readFile(srcPath);
      var forced = null;
      if (info.ext === 'svg') {
        var svg = prepareSvg(data);
        data = svg.buffer;
        forced = { width: svg.width, height: svg.height };
      }
      var png = await decodeToPngViaCanvas(data, EXT_MIME[info.ext] || 'application/octet-stream', forced);
      await fsp.writeFile(destPath, png);
      logDebug('Converted ' + label + ' with the built-in decoder (' + formatBytes(png.length) + ' PNG).');
      return;
    } catch (e) {
      canvasError = e;
      logDebug('Built-in decoder failed: ' + errMsg(e));
    }

    logInfo('Built-in decoder could not read this ' + label + ' file. Trying the system converter.');
    try {
      if (IS_MAC) { await convertWithSips(srcPath, destPath); }
      else if (IS_WIN) { await convertWithWic(srcPath, destPath); }
      else { throw new Error('No system converter available on this platform.'); }
      var st = await fsp.stat(destPath);
      if (!st.size) { throw new Error('System converter wrote an empty file.'); }
    } catch (e2) {
      throw new Error('Could not convert ' + label + ' to PNG. Built-in: ' + errMsg(canvasError) + ' System: ' + errMsg(e2));
    }
  }


  /* ------------------------------------------------------------------ */
  /* Optional ffmpeg: containers Premiere cannot import (WebM, MKV, ...) */
  /* ------------------------------------------------------------------ */

  var ffmpegCache; /* undefined = not looked up yet, null = not found, string = path */

  function extensionFolder() {
    try {
      var cep = window.__adobe_cep__;
      if (cep && typeof cep.getSystemPath === 'function') {
        var raw = cep.getSystemPath('extension');
        if (raw) { return /^file:/i.test(raw) ? fileUrlToPath(raw) : raw; }
      }
    } catch (e) { /* fall through */ }
    return '';
  }

  async function isExecutableFile(p) {
    try {
      var st = await fsp.stat(p);
      return st.isFile();
    } catch (e) {
      return false;
    }
  }

  async function findFfmpeg() {
    if (ffmpegCache !== undefined) { return ffmpegCache; }
    var exe = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg';
    var candidates = [];
    var extDir = extensionFolder();
    if (extDir) { candidates.push(path.join(extDir, 'bin', exe)); }
    if (IS_WIN) {
      var env = process.env;
      candidates.push(
        path.join(env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin', exe),
        'C:\\ffmpeg\\bin\\ffmpeg.exe',
        path.join(env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', exe),
        path.join(env.USERPROFILE || '', 'scoop', 'shims', exe),
        path.join(env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin', exe)
      );
    } else {
      /* GUI apps on macOS do not inherit the shell PATH, so look in the usual places. */
      candidates.push('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/local/bin/ffmpeg', '/usr/bin/ffmpeg');
    }
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i] && await isExecutableFile(candidates[i])) { ffmpegCache = candidates[i]; return ffmpegCache; }
    }
    try {
      var r = await execFileP(IS_WIN ? 'where.exe' : '/usr/bin/which', ['ffmpeg'], {}, 5000);
      var first = r.stdout.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean)[0];
      if (first && await isExecutableFile(first)) { ffmpegCache = first; return ffmpegCache; }
    } catch (e2) { /* not on PATH */ }
    ffmpegCache = null;
    return null;
  }

  function runFfmpeg(ffmpeg, args, ctx) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var tail = '';
      var child;
      var timer;

      function finish(err) {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        ctx.abort = null;
        if (err) { reject(err); } else { resolve(); }
      }

      try {
        child = childProcess.spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (spawnErr) {
        finish(spawnErr);
        return;
      }

      ctx.abort = function () {
        try { child.kill(); } catch (e) { /* already gone */ }
        finish(new Error('Cancelled by user'));
      };
      timer = setTimeout(function () {
        try { child.kill(); } catch (e) { /* already gone */ }
        finish(new Error('ffmpeg took too long and was stopped.'));
      }, CONFIG.FFMPEG_TIMEOUT_MS);

      child.stderr.on('data', function (chunk) { tail = (tail + chunk.toString('utf8')).slice(-1500); });
      child.on('error', function (e) { finish(e); });
      child.on('close', function (code) {
        if (code === 0) { finish(null); }
        else { finish(new Error('ffmpeg exited with code ' + code + ': ' + truncate(tail.trim().split(/\r?\n/).slice(-3).join(' '), 400))); }
      });
    });
  }

  /* Returns { path, kind, ext } or null when conversion was not possible (caller then imports the original). */
  async function transcodeWithFfmpeg(srcPath, baseName, kind, destDir, ctx) {
    var ffmpeg = await findFfmpeg();
    if (!ffmpeg) { return null; }
    var outExt = kind === 'audio' ? 'wav' : 'mp4';
    var dest = await reserveUniquePath(destDir, baseName, outExt);
    var args = ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-i', srcPath];
    if (kind === 'audio') {
      args.push('-vn', '-c:a', 'pcm_s16le', '-ar', '48000', dest);
    } else {
      args.push('-map', '0:v:0', '-map', '0:a:0?',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', dest);
    }
    try {
      await runFfmpeg(ffmpeg, args, ctx);
      var st = await fsp.stat(dest);
      if (!st.size) { throw new Error('ffmpeg wrote an empty file.'); }
    } catch (e) {
      await safeUnlink(dest);
      throw e;
    }
    return { path: dest, kind: kind, ext: outExt };
  }

  /* ------------------------------------------------------------------ */
  /* Asset ingestion into _PastedMedia                                   */
  /* ------------------------------------------------------------------ */

  /*
   * mode: 'consume'   src is a temp file owned by us: move it into destDir
   *       'copy'      src belongs to the user: copy it into destDir
   *       'reference' use src in place (conversion output still goes to destDir)
   */
  /* Sub-folder of _PastedMedia for a kind of file (Images, Video, Audio, Graphics, Templates). */
  var KIND_FOLDER = { image: 'Images', video: 'Video', audio: 'Audio', mogrt: 'Templates' };
  async function kindDir(destDir, kind, baseName, ctx) {
    if (!ctx || !ctx.organize) { return destDir; }
    var folder = /^(Title|Matte)_/.test(baseName) ? 'Graphics' : KIND_FOLDER[kind];
    if (!folder) { return destDir; }
    var dir = path.join(destDir, folder);
    try { await fsp.mkdir(dir, { recursive: true }); return dir; } catch (e) { return destDir; }
  }

  async function ingest(srcPath, baseName, extHint, destDir, mode, ctx, onProgress) {
    var sniff = await sniffFile(srcPath);
    var info = classifyMedia(sniff, extHint);
    if (!info) {
      throw new Error('Unrecognised or unsupported file type' + (extHint ? ' (.' + normExt(extHint) + ')' : '') + '.');
    }

    if (info.convert) {
      logInfo('Converting ' + info.ext.toUpperCase() + ' to PNG...');
      if (info.ext === 'webp' || info.ext === 'avif') { logDebug('Animated files keep only their first frame.'); }
      var pngDest = await reserveUniquePath(await kindDir(destDir, 'image', baseName, ctx), baseName, 'png');
      try {
        await convertToPng(srcPath, pngDest, info);
      } catch (convErr) {
        await safeUnlink(pngDest);
        throw convErr;
      }
      if (mode === 'consume') { await safeUnlink(srcPath); }
      return { path: pngDest, kind: 'image', ext: 'png', converted: true, created: true };
    }

    if (TRANSCODE_EXTS[info.ext] && ctx.autoConvert) {
      var tKind = TRANSCODE_EXTS[info.ext];
      var tBase = baseName;
      var ffmpegPath = await findFfmpeg();
      if (!ffmpegPath) {
        logWarn('.' + info.ext + ' files usually cannot be imported by Premiere Pro. Install ffmpeg (or put it in this panel\'s bin folder) to convert them automatically.');
      } else {
        logInfo('Converting .' + info.ext + ' to ' + (tKind === 'audio' ? 'WAV' : 'MP4') + ' with ffmpeg...');
        try {
          var converted = await transcodeWithFfmpeg(srcPath, tBase, tKind, await kindDir(destDir, tKind, tBase, ctx), ctx);
          if (converted) {
            if (mode === 'consume') { await safeUnlink(srcPath); }
            return { path: converted.path, kind: converted.kind, ext: converted.ext, converted: true, created: true };
          }
        } catch (convErr2) {
          if (/Cancelled by user/.test(errMsg(convErr2))) { throw convErr2; }
          logWarn('ffmpeg could not convert this file (' + errMsg(convErr2) + '). Trying to import the original.');
        }
      }
    }

    if (mode === 'reference') {
      return { path: srcPath, kind: info.kind, ext: info.ext, converted: false, created: false };
    }

    var dest = await reserveUniquePath(await kindDir(destDir, info.kind, baseName, ctx), baseName, info.ext);
    try {
      if (mode === 'consume') { await moveFile(srcPath, dest); }
      else { await copyFileStream(srcPath, dest, ctx, onProgress); }
    } catch (moveErr) {
      await safeUnlink(dest);
      throw moveErr;
    }
    return { path: dest, kind: info.kind, ext: info.ext, converted: false, created: true };
  }

  function parseDataUrl(value) {
    var m = /^data:([^,;]*)((?:;[^,;]*)*),(.*)$/is.exec(value);
    if (!m) { throw new Error('Malformed data URL.'); }
    var mime = (m[1] || 'application/octet-stream').toLowerCase();
    var isBase64 = /;base64/i.test(m[2] || '');
    var payload = m[3];
    var buf;
    var decoded;
    try { decoded = decodeURIComponent(payload); } catch (decodeErr) { decoded = payload; }
    if (isBase64) { buf = Buffer.from(decoded, 'base64'); }
    else { buf = Buffer.from(decoded, 'utf8'); }
    if (!buf.length) { throw new Error('Data URL is empty.'); }
    return { mime: mime, buffer: buf };
  }


  /* ------------------------------------------------------------------ */
  /* Folders, color codes, text titles                                   */
  /* ------------------------------------------------------------------ */

  var lastFrame = { w: 1920, h: 1080 };
  var collator = (typeof Intl !== 'undefined' && Intl.Collator) ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }) : null;

  function naturalCompare(a, b) { return collator ? collator.compare(a, b) : (a < b ? -1 : (a > b ? 1 : 0)); }

  /* Replaces every folder item with the media files inside it (sorted by name), keeping the order of the rest. */
  async function expandFolders(items) {
    var out = [];
    async function walk(dir, depth) {
      var entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
      catch (e) { logWarn('Cannot read folder ' + dir + ': ' + errMsg(e)); return; }
      entries.sort(function (a, b) { return naturalCompare(a.name, b.name); });
      for (var i = 0; i < entries.length && out.length < CONFIG.MAX_EXPANDED_ITEMS; i++) {
        var en = entries[i];
        if (en.name.charAt(0) === '.' || en.name === CONFIG.PASTE_DIR_NAME) { continue; }
        var full = path.join(dir, en.name);
        if (en.isDirectory()) { if (depth < 4) { await walk(full, depth + 1); } }
        else if (en.isFile()) {
          var e2 = normExt(path.extname(en.name));
          if (EXT_KIND[e2]) { out.push({ kind: 'file', value: full }); }
        }
      }
    }
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.kind === 'file') {
        var st = null;
        try { st = await fsp.stat(it.value); } catch (e) { st = null; }
        if (st && st.isDirectory()) {
          var before = out.length;
          await walk(it.value, 0);
          logInfo('Folder "' + path.basename(it.value) + '": ' + (out.length - before) + ' media file(s).');
          continue;
        }
      }
      out.push(it);
    }
    return out.slice(0, CONFIG.MAX_EXPANDED_ITEMS);
  }

  function splitTop(str, sep) {
    var parts = [], depth = 0, cur = '';
    for (var i = 0; i < str.length; i++) {
      var ch = str.charAt(i);
      if (ch === '(') { depth++; } else if (ch === ')') { depth--; }
      if (depth === 0 && (sep === ' ' ? /\s/.test(ch) : ch === sep)) { if (cur.trim()) { parts.push(cur.trim()); } cur = ''; }
      else { cur += ch; }
    }
    if (cur.trim()) { parts.push(cur.trim()); }
    return parts;
  }

  function cssColorValid(str) {
    try {
      var c = document.createElement('canvas').getContext('2d');
      c.fillStyle = '#010203'; c.fillStyle = str; var a = c.fillStyle;
      c.fillStyle = '#040506'; c.fillStyle = str; var b = c.fillStyle;
      return a === b;
    } catch (e) { return false; }
  }

  /* Arabic color names (CSS only knows the English ones). */
  var AR_COLORS = {
    'أحمر': '#ff0000', 'احمر': '#ff0000', 'أخضر': '#008000', 'اخضر': '#008000', 'أزرق': '#0000ff', 'ازرق': '#0000ff',
    'أصفر': '#ffff00', 'اصفر': '#ffff00', 'أسود': '#000000', 'اسود': '#000000', 'أبيض': '#ffffff', 'ابيض': '#ffffff',
    'برتقالي': '#ffa500', 'بنفسجي': '#800080', 'وردي': '#ffc0cb', 'رمادي': '#808080', 'بني': '#a52a2a',
    'سماوي': '#00ffff', 'ذهبي': '#ffd700', 'فضي': '#c0c0c0'
  };

  /* "255, 0, 0" or "255 0 0" (optionally with a 4th alpha value) -> "rgb(...)"/"rgba(...)", or null. */
  function rgbTripleToCss(t) {
    var m = /^(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})(?:\s*[,\/\s]\s*(\d*\.?\d+%?))?$/.exec(t);
    if (!m) { return null; }
    var r = +m[1], g = +m[2], b = +m[3];
    if (r > 255 || g > 255 || b > 255) { return null; }
    if (m[4] !== undefined) {
      var a = /%$/.test(m[4]) ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      if (!(a >= 0 && a <= 1)) { return null; }
      return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    }
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  /*
   * Turns one color token into something canvas understands, or null.
   * loose = also accept things that are common words/numbers when copied as plain text:
   * a bare hex (ff0000), and color names (red, أحمر). Those are only accepted when the user presses Paste,
   * never by the auto-paste watcher, otherwise copying the word "red" or "facade" would create a matte.
   */
  function normalizeColor(tok, loose) {
    var t = String(tok || '').trim();
    if (!t) { return null; }
    if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(t)) { return t; }
    if (/^(rgb|rgba|hsl|hsla)\(.+\)$/i.test(t)) { return cssColorValid(t) ? t : null; }
    /* Space-separated triples ("10 20 30") are only taken on a manual paste: they are too likely to be plain text. */
    var tri = (loose || t.indexOf(',') >= 0) ? rgbTripleToCss(t) : null;
    if (tri) { return tri; }
    if (!loose) { return null; }
    /* A bare hex with no digit at all is usually a word ("facade", "decade"): only accept it when it is plainly a color (ffffff, cccccc). */
    if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(t) && (/\d/.test(t) || new Set(t.toLowerCase().split('')).size <= 2)) { return '#' + t; }
    if (AR_COLORS.hasOwnProperty(t)) { return AR_COLORS[t]; }
    if (/^[a-z]+$/i.test(t) && !/^(transparent|currentcolor|inherit|initial|unset)$/i.test(t) && cssColorValid(t)) { return t.toLowerCase(); }
    return null;
  }

  /* Returns { type: 'solid'|'linear'|'radial', ... } or null when the text is not a color code. */
  function parseColorInput(text, loose) {
    var t = String(text || '').replace(/\s+/g, ' ').trim().replace(/;$/, '');
    t = t.replace(/^background(-image|-color)?\s*:\s*/i, '').trim();
    if (!t || t.length > 3000) { return null; }
    var solid = normalizeColor(t, loose);
    if (solid) { return { type: 'solid', color: solid }; }
    var g = /^(linear|radial)-gradient\((.*)\)$/i.exec(t);
    if (!g) { return null; }
    var args = splitTop(g[2], ',');
    if (args.length < 2) { return null; }
    var spec = { type: g[1].toLowerCase(), angle: 180, dir: '', at: [0.5, 0.5], shape: 'ellipse', stops: [] };
    var first = args[0];
    var firstTokens = splitTop(first, ' ');
    var looksLikeStop = cssColorValid(firstTokens[0]) || /^#/.test(firstTokens[0]) || !!normalizeColor(firstTokens[0], true);
    if (!looksLikeStop) {
      args.shift();
      if (spec.type === 'linear') {
        var am = /^(-?[\d.]+)(deg|turn|rad|grad)$/i.exec(first);
        if (am) {
          var v = parseFloat(am[1]), u = am[2].toLowerCase();
          spec.angle = u === 'turn' ? v * 360 : (u === 'rad' ? v * 180 / Math.PI : (u === 'grad' ? v * 0.9 : v));
        } else if (/^to\s/i.test(first)) { spec.dir = first.toLowerCase().replace(/^to\s+/, ''); }
        else { return null; }
      } else {
        if (/circle/i.test(first)) { spec.shape = 'circle'; }
        var at = /at\s+(\S+)(?:\s+(\S+))?/i.exec(first);
        if (at) {
          var pos = function (tok, def) {
            if (!tok) { return def; }
            tok = tok.toLowerCase();
            if (tok === 'left' || tok === 'top') { return 0; }
            if (tok === 'right' || tok === 'bottom') { return 1; }
            if (tok === 'center') { return 0.5; }
            return /%$/.test(tok) ? parseFloat(tok) / 100 : def;
          };
          var ax = pos(at[1], 0.5), ay = pos(at[2], 0.5);
          if (/^(top|bottom)$/i.test(at[1]) && !at[2]) { ay = ax; ax = 0.5; }
          spec.at = [ax, ay];
        }
      }
    }
    if (args.length < 2) { return null; }
    var i;
    for (i = 0; i < args.length; i++) {
      var toks = splitTop(args[i], ' ');
      var positions = [];
      while (toks.length > 1 && /^-?[\d.]+(%|px)$/i.test(toks[toks.length - 1])) { positions.unshift(toks.pop()); }
      var color = normalizeColor(toks.join(' '), true);
      if (!color) { return null; }
      if (!positions.length) { spec.stops.push({ color: color, pos: null }); }
      else { positions.forEach(function (ps) { spec.stops.push({ color: color, pos: ps }); }); }
    }
    return spec;
  }

  function renderColorPng(spec, W, H) {
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');
    var grad = null, lenPx = 1, rx = 1, ry = 1, cx = 0, cy = 0;
    if (spec.type === 'solid') { ctx.fillStyle = spec.color; ctx.fillRect(0, 0, W, H); return dataUrlToBuffer(canvas.toDataURL('image/png')); }
    if (spec.type === 'linear') {
      var a = spec.angle;
      if (spec.dir) {
        var d = spec.dir, base = Math.atan2(W, H) * 180 / Math.PI;
        var map = { top: 0, right: 90, bottom: 180, left: 270, 'top right': base, 'right top': base,
          'bottom right': 180 - base, 'right bottom': 180 - base, 'bottom left': 180 + base, 'left bottom': 180 + base,
          'top left': 360 - base, 'left top': 360 - base };
        a = map.hasOwnProperty(d) ? map[d] : 180;
      }
      var th = a * Math.PI / 180, dx = Math.sin(th), dy = -Math.cos(th);
      lenPx = Math.abs(W * Math.sin(th)) + Math.abs(H * Math.cos(th));
      grad = ctx.createLinearGradient(W / 2 - dx * lenPx / 2, H / 2 - dy * lenPx / 2, W / 2 + dx * lenPx / 2, H / 2 + dy * lenPx / 2);
    } else {
      cx = spec.at[0] * W; cy = spec.at[1] * H;
      var fx = Math.max(cx, W - cx), fy = Math.max(cy, H - cy);
      if (spec.shape === 'circle') { rx = ry = Math.max(1, Math.sqrt(fx * fx + fy * fy)); }
      else { rx = Math.max(1, fx * Math.SQRT2); ry = Math.max(1, fy * Math.SQRT2); }
      lenPx = rx;
      grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    }
    var stops = spec.stops.map(function (st) {
      var pos = null;
      if (st.pos !== null) { pos = /%$/.test(st.pos) ? parseFloat(st.pos) / 100 : parseFloat(st.pos) / lenPx; }
      return { color: st.color, pos: pos };
    });
    if (stops[0].pos === null) { stops[0].pos = 0; }
    if (stops[stops.length - 1].pos === null) { stops[stops.length - 1].pos = 1; }
    var k = 0;
    while (k < stops.length) {
      if (stops[k].pos !== null) { k++; continue; }
      var j = k; while (stops[j].pos === null) { j++; }
      var p0 = stops[k - 1].pos, p1 = stops[j].pos;
      for (var m = k; m < j; m++) { stops[m].pos = p0 + (p1 - p0) * (m - k + 1) / (j - k + 1); }
      k = j;
    }
    var prev = -Infinity;
    stops.forEach(function (st) {
      prev = Math.max(prev, st.pos);
      try { grad.addColorStop(Math.min(1, Math.max(0, prev)), st.color); } catch (e) { /* bad stop */ }
    });
    if (spec.type === 'linear') { ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H); }
    else {
      ctx.setTransform(rx, 0, 0, ry, cx, cy);
      ctx.fillStyle = grad;
      ctx.fillRect(-cx / rx, -cy / ry, W / rx, H / ry);
    }
    return dataUrlToBuffer(canvas.toDataURL('image/png'));
  }

  function dataUrlToBuffer(u) { return Buffer.from(u.slice(u.indexOf(',') + 1), 'base64'); }

  var DEFAULT_TITLE_STYLE = { font: '', size: 9, color: '#ffffff', pos: 'center', bold: true, shadow: true };

  /* Reads the title style controls (clamped, with safe fallbacks). */
  function titleTemplatePath() {
    var p = String(ui.titleTemplate.value || '').trim().replace(/^"|"$/g, '');
    try { return (/\.mogrt$/i.test(p) && fs.existsSync(p)) ? p : ''; } catch (e) { return ''; }
  }

  function readTitleStyle() {
    var size = parseFloat(ui.titleSize.value);
    if (!isFinite(size)) { size = DEFAULT_TITLE_STYLE.size; }
    var col = normalizeColor(ui.titleColor.value, true) || DEFAULT_TITLE_STYLE.color;
    return {
      font: String(ui.titleFont.value || '').replace(/["'\\;{}]/g, '').trim().slice(0, 80),
      size: Math.max(1, Math.min(40, size)),
      color: col,
      pos: /^(top|center|bottom)$/.test(ui.titlePos.value) ? ui.titlePos.value : 'center',
      bold: !!ui.titleBold.checked,
      shadow: !!ui.titleShadow.checked
    };
  }

  /* Text on a transparent frame, wrapped and centred. Font, size, color and position come from the settings. */
  function renderTitlePng(text, W, H, style) {
    var st = Object.assign({}, DEFAULT_TITLE_STYLE, style || {});
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');
    var rtl = /[֐-ࣿ]/.test(text);
    var maxW = W * 0.8, maxH = H * 0.8;
    var fs = Math.max(20, Math.round(H * st.size / 100)), lines = [];
    var base = '"Segoe UI", "Helvetica Neue", Arial, Tahoma, "Noto Sans Arabic", sans-serif';
    var family = st.font ? '"' + st.font + '", ' + base : base;
    var weight = st.bold ? '700 ' : '400 ';
    for (; fs >= 20; fs = Math.floor(fs * 0.9)) {
      ctx.font = weight + fs + 'px ' + family;
      lines = [];
      text.split(/\r?\n/).forEach(function (para) {
        var words = para.split(/\s+/).filter(Boolean), cur = '';
        if (!words.length) { lines.push(''); return; }
        words.forEach(function (w) {
          var tryLine = cur ? cur + ' ' + w : w;
          if (cur && ctx.measureText(tryLine).width > maxW) { lines.push(cur); cur = w; } else { cur = tryLine; }
        });
        lines.push(cur);
      });
      if (lines.length * fs * 1.25 <= maxH) { break; }
    }
    ctx.font = weight + fs + 'px ' + family;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (rtl) { ctx.direction = 'rtl'; }
    if (st.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.65)'; ctx.shadowBlur = fs * 0.12; ctx.shadowOffsetY = fs * 0.04; }
    ctx.fillStyle = st.color;
    var lh = fs * 1.25, blockH = lines.length * lh, cy;
    /* "bottom" sits like a subtitle (inside the title-safe area), "top" mirrors it. */
    if (st.pos === 'bottom') { cy = H * 0.92 - blockH / 2; }
    else if (st.pos === 'top') { cy = H * 0.08 + blockH / 2; }
    else { cy = H / 2; }
    var top = cy - (lines.length - 1) * lh / 2;
    lines.forEach(function (ln, idx) { ctx.fillText(ln, W / 2, top + idx * lh, maxW); });
    return dataUrlToBuffer(canvas.toDataURL('image/png'));
  }

  async function renderToIngest(buffer, base, destDir, ctx, onProgress) {
    var tmp = path.join(os.tmpdir(), 'qmp_gen_' + randomId() + '.png');
    await fsp.writeFile(tmp, buffer);
    try { return await ingest(tmp, base, 'png', destDir, 'consume', ctx, onProgress); }
    catch (e) { await safeUnlink(tmp); throw e; }
  }

  /* Pixel size of an image from its header (PNG, JPEG, GIF, BMP, PSD, WebP). Null when unknown. */
  async function readImageSize(file) {
    var h;
    try {
      h = await fsp.open(file, 'r');
      var buf = Buffer.alloc(524288);
      var n = (await h.read(buf, 0, buf.length, 0)).bytesRead;
      var b = buf.slice(0, n);
      var a = function (s, e) { return b.toString('latin1', s, e); };
      if (n > 24 && b[0] === 0x89 && a(1, 4) === 'PNG') { return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; }
      if (n > 10 && a(0, 4) === 'GIF8') { return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) }; }
      if (n > 26 && a(0, 2) === 'BM') { return { w: Math.abs(b.readInt32LE(18)), h: Math.abs(b.readInt32LE(22)) }; }
      if (n > 22 && a(0, 4) === '8BPS') { return { w: b.readUInt32BE(18), h: b.readUInt32BE(14) }; }
      if (n > 30 && a(0, 4) === 'RIFF' && a(8, 12) === 'WEBP') {
        var fmt = a(12, 16);
        if (fmt === 'VP8X') { return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) }; }
        if (fmt === 'VP8L') { var bits = b.readUInt32LE(21); return { w: (bits & 0x3FFF) + 1, h: ((bits >> 14) & 0x3FFF) + 1 }; }
        if (fmt === 'VP8 ') { return { w: b.readUInt16LE(26) & 0x3FFF, h: b.readUInt16LE(28) & 0x3FFF }; }
      }
      if (n > 4 && b[0] === 0xFF && b[1] === 0xD8) {
        var i = 2;
        while (i + 9 < n) {
          if (b[i] !== 0xFF) { i++; continue; }
          var m = b[i + 1];
          if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
          var len = b.readUInt16BE(i + 2);
          if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) { return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) }; }
          i += 2 + len;
        }
      }
    } catch (e) { logDebug('Could not read the image size: ' + errMsg(e)); }
    finally { if (h) { try { await h.close(); } catch (e2) { /* ignore */ } } }
    return null;
  }

  async function prepareItem(item, destDir, opts, tmpPng, ctx, onProgress) {
    if (item.kind === 'color') {
      var spec = parseColorInput(item.value, true);
      if (!spec) { throw new Error('Not a valid color code.'); }
      logInfo('Creating a ' + lastFrame.w + 'x' + lastFrame.h + ' color matte...');
      return renderToIngest(renderColorPng(spec, lastFrame.w, lastFrame.h), 'Matte_' + stamp(), destDir, ctx, onProgress);
    }
    if (item.kind === 'text') {
      var tpl = titleTemplatePath();
      if (tpl) {
        logInfo('Using your title template for editable text.');
        return { path: tpl, kind: 'mogrt', ext: 'mogrt', converted: false, created: false, mogrtText: String(item.value) };
      }
      logInfo('Creating a title from the text...');
      var snippet = sanitizeBaseName(String(item.value).replace(/\s+/g, ' ').slice(0, 24), 'Text');
      return renderToIngest(renderTitlePng(String(item.value), lastFrame.w, lastFrame.h, opts.titleStyle), 'Title_' + snippet + '_' + stamp(), destDir, ctx, onProgress);
    }
    if (item.kind === 'file') {
      var st;
      try { st = await fsp.stat(item.value); }
      catch (e) { throw new Error('File not found or not readable: ' + item.value); }
      if (st.isDirectory()) { throw new Error('Folder was not expanded.'); }
      if (!st.isFile()) { throw new Error('Not a regular file.'); }
      if (st.size === 0) { throw new Error('File is empty.'); }
      var ext = path.extname(item.value);
      var base = sanitizeBaseName(path.basename(item.value, ext), 'Pasted_File');
      /* An .aep points at its footage by path, so a copy elsewhere would break those links. */
      var mode = (!opts.copyLocal || isInside(destDir, item.value) || normExt(ext) === 'aep') ? 'reference' : 'copy';
      if (mode === 'copy') { logInfo('Copying "' + path.basename(item.value) + '" (' + formatBytes(st.size) + ') into ' + CONFIG.PASTE_DIR_NAME + '...'); }
      return ingest(item.value, base, ext, destDir, mode, ctx, onProgress);
    }

    if (item.kind === 'clipimage') {
      logInfo('Saving clipboard image...');
      return ingest(tmpPng, 'Pasted_Image_' + stamp(), 'png', destDir, 'consume', ctx, onProgress);
    }

    if (item.kind === 'dataurl') {
      logInfo('Decoding data URL...');
      var parsedData = parseDataUrl(item.value);
      var tmpData = path.join(os.tmpdir(), 'qmp_data_' + randomId() + '.bin');
      await fsp.writeFile(tmpData, parsedData.buffer);
      try {
        return await ingest(tmpData, 'Pasted_Data_' + stamp(), MIME_EXT[parsedData.mime] || '', destDir, 'consume', ctx, onProgress);
      } catch (dataErr) {
        await safeUnlink(tmpData);
        throw dataErr;
      }
    }

    if (item.kind === 'url') {
      logInfo('Downloading ' + truncate(item.value, 90));
      var dl = await downloadUrl(item.value, destDir, ctx, onProgress);
      logOk('Downloaded ' + formatBytes(dl.bytes) + (dl.contentType ? ' (' + dl.contentType + ')' : ''));
      var nameHint = dl.nameHint || '';
      var hintExt = path.extname(nameHint);
      if (!hintExt || !EXT_KIND[normExt(hintExt)]) { hintExt = MIME_EXT[dl.contentType] || hintExt; }
      var dlBase = sanitizeBaseName(path.basename(nameHint, path.extname(nameHint)), 'Downloaded_' + stamp());
      try {
        return await ingest(dl.partPath, dlBase, hintExt, destDir, 'consume', ctx, onProgress);
      } catch (ingestErr) {
        await safeUnlink(dl.partPath);
        throw ingestErr;
      }
    }

    throw new Error('Unknown clipboard item type: ' + item.kind);
  }

  /* ------------------------------------------------------------------ */
  /* Bridge to ExtendScript                                              */
  /* ------------------------------------------------------------------ */

  function evalHost(script, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var cep = window.__adobe_cep__;
      if (!cep || typeof cep.evalScript !== 'function') {
        reject(new Error('The CEP bridge is not available. Open this panel inside Premiere Pro.'));
        return;
      }
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) { return; }
        settled = true;
        reject(new Error('Premiere Pro did not answer within ' + Math.round(timeoutMs / 1000) + ' seconds.'));
      }, timeoutMs);
      try {
        cep.evalScript(script, function (result) {
          if (settled) { return; }
          settled = true;
          clearTimeout(timer);
          resolve(result);
        });
      } catch (e) {
        if (!settled) { settled = true; clearTimeout(timer); reject(e); }
      }
    });
  }

  async function hostCall(fnName, payload, timeoutMs) {
    var json = JSON.stringify(payload || {});
    var script = fnName + '(' + JSON.stringify(encodeURIComponent(json)) + ')';
    logDebug('host call ' + fnName + ' ' + truncate(json, 500));
    var raw;
    try {
      raw = await evalHost(script, timeoutMs || CONFIG.HOST_CALL_TIMEOUT_MS);
    } catch (e) {
      logDebug('host call ' + fnName + ' failed: ' + errMsg(e));
      throw e;
    }
    logDebug('host reply ' + truncate(raw, 800));
    if (raw === undefined || raw === null || raw === '' || raw === 'undefined') {
      throw new Error('hostscript.jsx returned nothing for ' + fnName + '. Reload the panel.');
    }
    if (String(raw).indexOf('EvalScript error') === 0) {
      throw new Error('ExtendScript could not run ' + fnName + '. hostscript.jsx may not be loaded; reload the panel.');
    }
    var parsed;
    try { parsed = JSON.parse(raw); }
    catch (parseErr) { throw new Error('Unreadable reply from Premiere Pro: ' + truncate(raw, 200)); }
    if (parsed && Array.isArray(parsed.log)) {
      parsed.log.forEach(function (line) { logDebug('host: ' + line); });
    }
    return parsed;
  }

  /* ------------------------------------------------------------------ */
  /* Orchestration                                                       */
  /* ------------------------------------------------------------------ */

  var lastPastedDir = '';
  var state = { busy: false, cancelled: false, abortActive: null };

  function setBusy(busy) {
    state.busy = busy;
    ui.pasteBtn.disabled = busy;
    if (ui.frameBtn) { ui.frameBtn.disabled = busy; }
    ui.placement.disabled = busy;
    ui.copyLocal.disabled = busy;
    ui.autoConvert.disabled = busy;
    ui.organize.disabled = busy;
    ui.track.disabled = busy;
    ui.still.disabled = busy;
    ui.fit.disabled = busy;
    ui.cancelBtn.hidden = !busy;
    ui.pasteBtn.classList.toggle('is-busy', busy);
    ui.pasteLabel.textContent = tr(busy ? 'Working' : 'Paste to Timeline');
    Array.prototype.forEach.call(document.querySelectorAll('.seg-btn'), function (b) { b.disabled = busy; });
    if (!busy) { setProgress(false); }
  }

  function checkCancelled() {
    if (state.cancelled) { throw new Error('Cancelled by user'); }
  }

  /* Prepares items a few at a time (copy, download, convert). Results keep the order of `items`. */
  async function prepareBatch(items, pastedDir, opts, tmpPng, ctl) {
    var slots = new Array(items.length);
    var errors = [];
    var active = [];
    var next = 0;
    var concurrent = Math.max(1, Math.min(CONFIG.PREPARE_CONCURRENCY, items.length));
    ctl.abort = function () { active.slice().forEach(function (c) { if (c.abort) { c.abort(); } }); };
    var work = async function () {
      while (next < items.length && !ctl.isCancelled()) {
        var i = next++;
        var item = items[i];
        var label = describeItem(item);
        var itemCtx = { abort: null, autoConvert: opts.autoConvert, organize: opts.organize };
        active.push(itemCtx);
        try {
          var reporter = concurrent > 1 ? function () {} : makeProgressReporter();
          var result = await prepareItem(item, pastedDir, opts, tmpPng, itemCtx, reporter);
          slots[i] = { path: result.path, kind: result.kind, label: label, created: !!result.created };
          logOk('Ready: ' + path.basename(result.path) + ' (' + result.kind + ')');
        } catch (itemErr) {
          if (!ctl.isCancelled()) { errors.push({ label: label, error: itemErr }); }
        } finally {
          var at = active.indexOf(itemCtx);
          if (at !== -1) { active.splice(at, 1); }
        }
      }
    };
    var workers = [];
    for (var w = 0; w < concurrent; w++) { workers.push(work()); }
    await Promise.all(workers);
    ctl.abort = null;
    return { slots: slots, errors: errors };
  }

  /* ------------------------------------------------------------------ */
  /* Prepare on copy: files and images are saved next to the project as soon as they are copied, */
  /* so the paste that follows only has to place them on the timeline.                         */
  /* ------------------------------------------------------------------ */

  var stage = { cur: null };

  function deleteCreated(prepared) {
    (prepared || []).forEach(function (p) { if (p && p.created) { safeUnlink(p.path); } });
  }

  /* Gives back what was prepared for a copy that was never pasted. */
  async function releaseStaged(prepared, imported) {
    if (imported) {
      /* Items already live in the Premiere project: the files may only go if Premiere lets us remove the items. */
      try {
        var r = await hostCall('QMP_removeImported', { paths: prepared.map(function (p) { return p.path; }), organize: true, binName: CONFIG.BIN_NAME }, CONFIG.HOST_PING_TIMEOUT_MS * 4);
        if (r && r.ok && r.removedAll) { deleteCreated(prepared); }
      } catch (e) { /* leave the files: the project may use them */ }
      return;
    }
    deleteCreated(prepared);
  }

  /* Drops whatever was prepared for an older copy (and stops the work if it is still running). */
  function discardStage() {
    var t = stage.cur;
    stage.cur = null;
    if (!t) { return; }
    t.cancelled = true;
    if (t.ctl.abort) { try { t.ctl.abort(); } catch (e) { /* ignore */ } }
    t.promise.then(function (res) { if (res && !res.consumed) { releaseStaged(res.prepared, res.imported); } }, function () { /* nothing to clean */ });
  }

  async function readClipSettled(tmp) {
    var clip = null;
    for (var attempt = 0; attempt < 3; attempt++) {
      await sleep(attempt === 0 ? CONFIG.SETTLE_MS : 150);
      clip = await readClipboard(tmp);
      if (clip.files.length || clip.image || (clip.text && clip.text.trim())) { return clip; }
    }
    return clip;
  }

  function startStage(seq) {
    var t = { seq: seq, cancelled: false, promise: null, ctl: null };
    t.ctl = { abort: null, isCancelled: function () { return t.cancelled; } };
    stage.cur = t;
    t.promise = (async function () {
      var tmp = path.join(os.tmpdir(), 'qmp_stage_' + randomId() + '.png');
      var batch = null;
      try {
        var clip = await readClipSettled(tmp);
        if (t.cancelled) { return null; }
        var items = [];
        if (clip.files.length) {
          var total = 0;
          for (var i = 0; i < clip.files.length; i++) {
            var st;
            try { st = await fsp.stat(clip.files[i]); } catch (e0) { return null; }
            if (!st.isFile() || !EXT_KIND[normExt(path.extname(clip.files[i]))]) { return null; }
            total += st.size;
          }
          if (total > CONFIG.STAGE_MAX_BYTES) { return null; }
          items = clip.files.map(function (f) { return { kind: 'file', value: f }; });
        } else if (clip.image) {
          items = [{ kind: 'clipimage', value: clip.image }];
        } else {
          return null;
        }
        var context = await hostCall('QMP_getContext', {}, CONFIG.HOST_PING_TIMEOUT_MS * 4);
        if (!context.ok || t.cancelled) { return null; }
        var pastedDir = path.join(context.projectDir, CONFIG.PASTE_DIR_NAME);
        await ensureWritableDir(pastedDir);
        var opts = { copyLocal: !!ui.copyLocal.checked, autoConvert: !!ui.autoConvert.checked, organize: !!ui.organize.checked, titleStyle: readTitleStyle() };
        logDebug('Preparing ' + items.length + ' item(s) in the background...');
        batch = await prepareBatch(items, pastedDir, opts, tmp, t.ctl);
        var prepared = batch.slots.filter(Boolean);
        if (t.cancelled || batch.errors.length || !prepared.length) { deleteCreated(prepared); return null; }
        /* Import into the Premiere project now too, so the paste does not wait for importFiles. */
        var imported = false;
        var importable = prepared.filter(function (p) { return p.kind === 'image' || p.kind === 'video' || p.kind === 'audio'; });
        if (importable.length) {
          try {
            var pre = await hostCall('QMP_preImport', { paths: importable.map(function (p) { return p.path; }), organize: opts.organize, binName: CONFIG.BIN_NAME });
            imported = !!(pre && pre.ok);
            if (!imported) { logDebug('Pre-import skipped: ' + (pre && pre.error)); }
          } catch (preErr) { logDebug('Pre-import skipped: ' + errMsg(preErr)); }
        }
        if (t.cancelled) { await releaseStaged(prepared, imported); return null; }
        logDebug('Prepared ' + prepared.length + ' item(s)' + (imported ? ' and imported them' : '') + '. Paste will only place them.');
        return { prepared: prepared, pastedDir: pastedDir, context: context, copyLocal: opts.copyLocal, autoConvert: opts.autoConvert, organize: opts.organize, consumed: false, imported: imported };
      } catch (e) {
        logDebug('Prepare on copy skipped: ' + errMsg(e));
        if (batch) { deleteCreated(batch.slots.filter(Boolean)); }
        return null;
      } finally {
        await safeUnlink(tmp);
      }
    })();
    t.promise.catch(function () { /* handled inside */ });
  }

  /* The time-argument form that worked last time (per Premiere version) lets the very first paste of a session use the fast path. */
  var TRACE_PATH = path.join(os.tmpdir(), 'qmp_trace.log');
  var hostVersionStr = '';
  function loadVariantHint() {
    try { var v = JSON.parse(window.localStorage.getItem('quickmediapaste.variant') || 'null'); return (v && v.host === hostVersionStr && hostVersionStr) ? v.variant : ''; } catch (e) { return ''; }
  }
  function saveVariantHint(variant) {
    try { window.localStorage.setItem('quickmediapaste.variant', JSON.stringify({ host: hostVersionStr, variant: variant })); } catch (e) { /* ignore */ }
  }

  /* The trace file ends with a 'finished' line after a normal paste. If it does not, the last session died in the middle of a step. */
  function checkPreviousCrash() {
    try {
      if (!fs.existsSync(TRACE_PATH)) { return; }
      var lines = fs.readFileSync(TRACE_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
      if (!lines.length) { return; }
      var last = lines[lines.length - 1];
      if (/\| FINISHED/.test(last)) { return; }
      logWarn('The previous paste did not finish. Last step before it stopped: ' + last.replace(/^[^|]*\|\s*/, ''));
      logWarn('Full trace: ' + TRACE_PATH);
    } catch (e) { /* ignore */ }
  }

  function browseTitleTemplate() {
    try {
      var r = window.cep.fs.showOpenDialogEx(false, false, 'Choose a title template', '', ['mogrt']);
      if (r && r.data && r.data.length) { ui.titleTemplate.value = String(r.data[0]); saveSettings(); }
    } catch (e) { logWarn('Could not open the file dialog: ' + errMsg(e)); }
  }

  async function runPaste(preset, srcLabel, pre) {
    if (state.busy) { logWarn('A paste is already running.'); return; }
    if (!nodeReady) { logError('Node.js is not available in this panel. See the startup message.'); return; }

    state.cancelled = false;
    state.abortActive = null;
    setMessage('', '');
    setBusy(true);
    setStatus('busy', 'Working');
    setProgress(null);

    var tmpPng = (pre && pre.tmpPng) ? pre.tmpPng : path.join(os.tmpdir(), 'qmp_clip_' + randomId() + '.png');
    var opts = {
      copyLocal: !!ui.copyLocal.checked,
      autoConvert: !!ui.autoConvert.checked,
      organize: !!ui.organize.checked,
      mode: ui.placement.value === 'insert' ? 'insert' : 'overwrite',
      trackIndex: parseInt(ui.track.value, 10),
      stillSeconds: Math.max(0.1, Math.min(600, parseFloat(ui.still.value) || 5)),
      titleStyle: readTitleStyle()
    };
    var failed = false;
    var tStart = Date.now();
    var marks = {};

    /* Media prepared when it was copied: only the placement in Premiere is left to do. */
    var staged = null;
    if (!(preset && preset.length) && !(pre && pre.clip) && stage.cur) {
      try {
        var stageNow = stage.cur;
        var seqNow = await getClipSeq();
        if (seqNow !== null && String(seqNow) === stageNow.seq) {
          state.abortActive = function () { discardStage(); };
          var stageRes = await stageNow.promise;
          state.abortActive = null;
          if (stageRes && stage.cur === stageNow && !state.cancelled &&
              stageRes.copyLocal === opts.copyLocal && stageRes.autoConvert === opts.autoConvert && stageRes.organize === opts.organize &&
              stageRes.prepared.every(function (pp) { return fs.existsSync(pp.path); })) {
            staged = stageRes;
            staged.consumed = true;
            stage.cur = null;
          }
        } else if (stage.cur === stageNow) {
          discardStage();
        }
      } catch (stageErr) { state.abortActive = null; logDebug('Prepared media not used: ' + errMsg(stageErr)); }
    }

    /* The clipboard read does not depend on Premiere, so it runs while Premiere answers the context call. */
    var clipPromise = null;
    if (!staged && !(preset && preset.length) && !(pre && pre.clip)) {
      logInfo('Reading the clipboard...');
      clipPromise = readClipboard(tmpPng);
      clipPromise.catch(function () { /* the error is raised where the result is awaited */ });
    }

    try {
      checkCancelled();
      var context, pastedDir, prepared;
      if (staged) {
        context = staged.context;
        pastedDir = staged.pastedDir;
        prepared = staged.prepared;
        lastPastedDir = pastedDir;
        logOk('Using the media prepared when you copied it.');
      } else {
      logInfo('Checking the active project and sequence...');
      var tCtx0 = Date.now();
      context = await (pre && pre.contextPromise ? pre.contextPromise : hostCall('QMP_getContext', {}, CONFIG.HOST_PING_TIMEOUT_MS * 4));
      if (!context.ok) { throw new Error(context.error || 'Could not read the Premiere Pro project.'); }
      if (context.frameWidth > 0 && context.frameHeight > 0) { lastFrame = { w: Math.min(8192, context.frameWidth), h: Math.min(8192, context.frameHeight) }; }
      marks.context = Date.now() - tCtx0;
      logOk('Sequence "' + context.sequenceName + '", playhead at ' + formatSeconds(context.playheadSeconds) + '.');

      checkCancelled();
      pastedDir = path.join(context.projectDir, CONFIG.PASTE_DIR_NAME);
      await ensureWritableDir(pastedDir);
      sweepStale(pastedDir); /* background, never blocks the paste */
      lastPastedDir = pastedDir;
      logInfo('Storage folder ready: ' + pastedDir);

      checkCancelled();
      var items = [];
      var clip = { files: [], image: '', text: '' };
      if (preset && preset.length) {
        items = await expandFolders(preset);
        logInfo((srcLabel || 'Dropped') + ' ' + items.length + ' item' + (items.length === 1 ? '' : 's') + '.');
      } else if (pre && pre.clip) {
        clip = pre.clip;
      } else {
        clip = await clipPromise;
        marks.clipboard = Date.now() - tStart;
      }
      if (items.length) {
        /* items came from a drop, nothing to read from the clipboard */
      } else if (clip.files.length) {
        items = await expandFolders(clip.files.map(function (f) { return { kind: 'file', value: f }; }));
        logInfo('Clipboard holds ' + clip.files.length + ' file' + (clip.files.length === 1 ? '' : 's') + '.');
      } else if (clip.image) {
        items = [{ kind: 'clipimage', value: clip.image }];
        logInfo('Clipboard holds an image.');
      } else if (clip.text && clip.text.trim()) {
        var parsedText = parseClipboardText(clip.text);
        items = parsedText.items;
        if (!items.length) {
          if (parseColorInput(clip.text, true)) { items = [{ kind: 'color', value: clip.text }]; logInfo('Clipboard holds a color code.'); }
          else { items = [{ kind: 'text', value: clip.text }]; logInfo('Clipboard holds text: it becomes a title.'); }
        }
        if (parsedText.ignored && parsedText.items.length) { logWarn(parsedText.ignored + ' line(s) of clipboard text were ignored.'); }
        if (parsedText.items.length) { logInfo('Clipboard holds ' + items.length + ' link' + (items.length === 1 ? '' : 's') + ' or path' + (items.length === 1 ? '' : 's') + '.'); }
      } else {
        throw new Error('The clipboard is empty. Copy a media file, an image, or a direct link first.');
      }

      setProgress(null);
      var ctl = { abort: null, isCancelled: function () { return state.cancelled; } };
      state.abortActive = function () { if (ctl.abort) { ctl.abort(); } };
      var tPrep0 = Date.now();
      var batch = await prepareBatch(items, pastedDir, opts, tmpPng, ctl);
      marks.prepare = Date.now() - tPrep0;
      state.abortActive = null;
      checkCancelled();
      batch.errors.forEach(function (er) {
        failed = true;
        logError(er.label + ': ' + errMsg(er.error));
        addRecent(false, 'file', er.label, friendlyError(errMsg(er.error)));
      });
      prepared = batch.slots.filter(Boolean);
      }

      if (!prepared.length) { throw new Error('Nothing from the clipboard could be prepared for import.'); }

      checkCancelled();
      setProgress(null);
      logInfo('Importing ' + prepared.length + ' asset' + (prepared.length === 1 ? '' : 's') + ' into Premiere Pro...');
      var dims = await Promise.all(prepared.map(function (p) {
        return p.kind === 'image' ? readImageSize(p.path) : Promise.resolve(null);
      }));
      var tHost = Date.now();
      var reply = await hostCall('QMP_insertMedia', {
        paths: prepared.map(function (p) { return p.path; }),
        mode: opts.mode,
        trackIndex: isFinite(opts.trackIndex) ? opts.trackIndex : -1,
        stillSeconds: opts.stillSeconds,
        fit: ui.fit.value,
        dims: dims,
        organize: opts.organize,
        texts: prepared.map(function (p) { return p.mogrtText || ''; }),
        tracePath: TRACE_PATH,
        variantHint: loadVariantHint(),
        binName: CONFIG.BIN_NAME
      });
      if (reply && reply.variant) { saveVariantHint(reply.variant); }

      var tEnd = Date.now();
      var parts = [];
      if (staged) { parts.push('prepared on copy'); }
      if (marks.clipboard !== undefined) { parts.push('clipboard ready after ' + marks.clipboard + ' ms (' + (lastClipReader || '?') + ')'); }
      if (marks.context !== undefined) { parts.push('Premiere context ' + marks.context + ' ms'); }
      if (marks.prepare !== undefined) { parts.push('prepare files ' + marks.prepare + ' ms'); }
      parts.push('before Premiere ' + (tHost - tStart) + ' ms');
      parts.push('placing in Premiere ' + (tEnd - tHost) + ' ms');
      logInfo('Timing: ' + parts.join(' | '));
      var placedCount = 0;
      var results = Array.isArray(reply.results) ? reply.results : [];
      results.forEach(function (r) {
        var name = r.path ? path.basename(String(r.path)) : 'item';
        if (r.ok) {
          placedCount++;
          logOk('Asset imported: ' + name + ' on ' + r.trackLabel + ' at ' + formatSeconds(r.startSeconds) + ' (' + (r.mode || opts.mode) + ').');
          if (r.note) { logDebug(name + ': ' + r.note); }
          addRecent(true, r.kind, name, (r.trackLabel || '') + '  ' + formatSeconds(r.startSeconds), r.path);
        } else {
          failed = true;
          logError(name + ': ' + (r.error || 'Placement failed.'));
          addRecent(false, r.kind, name, friendlyError(r.error || 'Placement failed.'));
        }
      });

      if (!reply.ok && !placedCount) { throw new Error(reply.error || 'Premiere Pro could not place the media.'); }

      if (failed) {
        logWarn(placedCount + ' of ' + prepared.length + ' asset(s) placed. Check the messages above.');
        setStatus('error', 'Finished with errors');
        setMessage('warn', uiLang === 'ar' ? ('انلصق ' + placedCount + ' من ' + prepared.length + '. شوف التفاصيل.') : (placedCount + ' of ' + prepared.length + ' placed. See details.'));
      } else {
        logOk('Done. ' + placedCount + ' asset' + (placedCount === 1 ? '' : 's') + ' placed on the timeline.');
        setStatus('ok', 'Done');
        setMessage('ok', doneText(placedCount) + ' (' + ((Date.now() - tStart) / 1000).toFixed(1) + (uiLang === 'ar' ? ' ث)' : ' s)'));
      }
    } catch (e) {
      failed = true;
      var cancelled = state.cancelled || /Cancelled by user/.test(errMsg(e));
      if (cancelled) { logWarn('Cancelled.'); setStatus('idle', 'Cancelled'); setMessage('warn', tr('Cancelled')); }
      else { logError(errMsg(e)); setStatus('error', 'Error'); setMessage('error', friendlyError(errMsg(e))); }
    } finally {
      if (clipPromise) { try { await clipPromise; } catch (e3) { /* already reported */ } }
      await safeUnlink(tmpPng);
      setBusy(false);
      resetStatusSoon();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Auto-paste: watch the clipboard and paste media as soon as it appears */
  /* ------------------------------------------------------------------ */

  var watch = { timer: null, lastSeq: null, running: false, warnedNoSeq: false };

  function copiedInsidePremiere(clip) {
    return /^(Adobe Premiere Pro|CEPHtmlEngine)/i.test(String(clip && clip.owner || ''));
  }

  function isMediaItem(item) {
    try {
      if (item.kind === 'file') { return !!EXT_KIND[normExt(path.extname(item.value))]; }
      if (item.kind === 'url') { return !!EXT_KIND[normExt(path.extname(new URL(item.value).pathname))]; }
      if (item.kind === 'dataurl') { return /^data:(image|video|audio)\//i.test(item.value); }
    } catch (e) { /* not media */ }
    return false;
  }

  async function autoPasteIfMedia() {
    var tmp = path.join(os.tmpdir(), 'qmp_peek_' + randomId() + '.png');
    var clip;
    var keepTmp = false;
    var ctxPromise = hostCall('QMP_getContext', {}, CONFIG.HOST_PING_TIMEOUT_MS * 4);
    ctxPromise.catch(function () { /* reported when the paste uses it */ });
    try { clip = await readClipSettled(tmp); }
    catch (e) { logDebug('Auto-paste could not read the clipboard: ' + errMsg(e)); await safeUnlink(tmp); return; }

    try {
      if (clip.files.length) {
        var fileItems = clip.files.map(function (f) { return { kind: 'file', value: f }; }).filter(isMediaItem);
        if (!fileItems.length) { logDebug('Auto-paste: copied files are not media, ignored.'); return; }
        await runPaste(fileItems, 'Auto-paste:', { contextPromise: ctxPromise });
      } else if (clip.image) {
        /* hand over what was just read (and its PNG) instead of reading the clipboard a second time */
        keepTmp = true;
        await runPaste(null, 'Auto-paste:', { clip: clip, tmpPng: tmp, contextPromise: ctxPromise });
      } else if (clip.text && clip.text.trim()) {
        var parsedAuto = parseClipboardText(clip.text);
        var textItems = parsedAuto.items.filter(isMediaItem);
        if (textItems.length) { await runPaste(textItems, 'Auto-paste:', { contextPromise: ctxPromise }); return; }
        if (parsedAuto.items.length) { logDebug('Auto-paste: copied link or path is not media, ignored. Press Paste to force it.'); return; }
        if (copiedInsidePremiere(clip)) { logDebug('Auto-paste: text was copied inside Premiere, ignored.'); return; }
        if (parseColorInput(clip.text, false)) {
          if (!ui.autoColor.checked) { logDebug('Auto-paste: color code ignored (switch is off). Press Paste to force it.'); return; }
          await runPaste([{ kind: 'color', value: clip.text }], 'Auto-paste:', { contextPromise: ctxPromise });
          return;
        }
        if (!ui.autoText.checked) { logDebug('Auto-paste: copied text ignored (switch is off). Press Paste to force it.'); return; }
        if (clip.text.trim().length > CONFIG.AUTO_TEXT_MAX_CHARS) { logDebug('Auto-paste: copied text is too long for a title, ignored. Press Paste to force it.'); return; }
        await runPaste([{ kind: 'text', value: clip.text }], 'Auto-paste:', { contextPromise: ctxPromise });
      }
    } finally {
      if (!keepTmp) { await safeUnlink(tmp); }
    }
  }

  async function watchTick() {
    watch.timer = null;
    if (!(ui.auto.checked || ui.stage.checked) || !nodeReady) { watch.running = false; return; }
    var delay = IS_WIN && winWorker.proc && winWorker.ready ? 200 : (IS_MAC ? 1200 : 2500);
    try {
      if (!state.busy) {
        var seq = await getClipSeq();
        if (seq === null) {
          if (!watch.warnedNoSeq && (!winWorker.proc || winWorker.ready || winWorker.failed)) {
            watch.warnedNoSeq = true;
            logWarn('Auto-paste could not watch the clipboard on this computer. Use the Paste button or Ctrl+V.');
          }
        } else if (watch.lastSeq === null) {
          watch.lastSeq = seq; /* what is on the clipboard now is not pasted */
          watch.warnedNoSeq = false;
        } else if (seq !== watch.lastSeq) {
          watch.lastSeq = seq;
          discardStage(); /* whatever was prepared belongs to an older copy */
          if (ui.auto.checked && !state.busy) { await autoPasteIfMedia(); }
          else if (ui.stage.checked && !state.busy) { startStage(String(seq)); }
        }
      }
    } catch (e) {
      logDebug('Clipboard watcher: ' + errMsg(e));
    }
    if (ui.auto.checked || ui.stage.checked) { watch.timer = setTimeout(watchTick, delay); } else { watch.running = false; }
  }

  function updateWatch() {
    if (ui.auto.checked || ui.stage.checked) {
      if (!watch.running) {
        watch.running = true;
        watch.lastSeq = null;
        if (!state.busy && lastStatus.state === 'idle') { setStatus('idle', 'Watching'); }
        watch.timer = setTimeout(watchTick, 300);
      }
    } else {
      if (watch.timer) { clearTimeout(watch.timer); watch.timer = null; }
      watch.running = false;
      if (!state.busy && lastStatus.state === 'idle') { setStatus('idle', 'Ready'); }
    }
  }

  /* ------------------------------------------------------------------ */
  /* UI wiring and start-up                                              */
  /* ------------------------------------------------------------------ */

  function copyLogToClipboard() {
    var text = logHistory.join('\n');
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(area);
    if (ok) { logInfo('Log copied to the clipboard (' + logHistory.length + ' lines).'); }
    else { logWarn('Could not copy the log automatically. Select the text in the console and copy it.'); }
  }

  /* ---- remembered options ---- */

  /* ------------------------------------------------------------------ */
  /* Configurable shortcuts. "ctrl" means Cmd on macOS.                  */
  /* ------------------------------------------------------------------ */

  var DEFAULT_COMBOS = {
    paste: { ctrl: true, shift: false, alt: false, vk: 86, name: 'V' },
    frame: { ctrl: true, shift: true, alt: false, vk: 67, name: 'C' }
  };
  var combos = { paste: Object.assign({}, DEFAULT_COMBOS.paste), frame: Object.assign({}, DEFAULT_COMBOS.frame) };

  function validCombo(c) {
    return !!c && typeof c === 'object' && typeof c.vk === 'number' && c.vk > 0 && typeof c.name === 'string' &&
      (c.ctrl || c.shift || c.alt || (c.vk >= 112 && c.vk <= 123));
  }

  function comboLabel(c) {
    return (c.ctrl ? (IS_MAC ? 'Cmd+' : 'Ctrl+') : '') + (c.shift ? 'Shift+' : '') + (c.alt ? (IS_MAC ? 'Option+' : 'Alt+') : '') + c.name;
  }

  function comboFromEvent(ev) {
    var kc = ev.keyCode;
    if (kc === 16 || kc === 17 || kc === 18 || kc === 91 || kc === 93 || kc === 224) { return null; }
    var name;
    if ((kc >= 48 && kc <= 57) || (kc >= 65 && kc <= 90)) { name = String.fromCharCode(kc); }
    else if (kc >= 112 && kc <= 123) { name = 'F' + (kc - 111); }
    else { name = (ev.key && ev.key.length === 1) ? ev.key.toUpperCase() : (ev.code || ev.key || '').replace(/^Key/, ''); }
    return { ctrl: IS_MAC ? !!ev.metaKey : !!ev.ctrlKey, shift: !!ev.shiftKey, alt: !!ev.altKey, vk: kc, name: name };
  }

  function comboMatches(c, ev) {
    return ev.keyCode === c.vk && (IS_MAC ? !!ev.metaKey : !!ev.ctrlKey) === c.ctrl && !!ev.shiftKey === c.shift && !!ev.altKey === c.alt;
  }

  function sameCombo(a, b) { return a.vk === b.vk && a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt; }
  function comboArg(c) { return (c.ctrl ? '1' : '0') + ',' + (c.shift ? '1' : '0') + ',' + (c.alt ? '1' : '0') + ',' + c.vk; }

  function refreshComboUi() {
    ui.keyPaste.textContent = comboLabel(combos.paste);
    ui.keyFrame.textContent = comboLabel(combos.frame);
    ui.kbdHint.textContent = comboLabel(combos.paste);
    ui.frameKbd.textContent = comboLabel(combos.frame);
  }

  var capturing = null;

  function bindComboButton(btn, resetBtn, which) {
    btn.addEventListener('click', function () {
      capturing = which;
      btn.textContent = uiLang === 'ar' ? 'اضغط المفاتيح...' : 'Press the keys...';
      ui.keyErr.textContent = '';
      btn.focus();
    });
    btn.addEventListener('blur', function () { if (capturing === which) { capturing = null; refreshComboUi(); } });
    btn.addEventListener('keydown', function (ev) {
      if (capturing !== which) { return; }
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.key === 'Escape') { capturing = null; refreshComboUi(); return; }
      var c = comboFromEvent(ev);
      if (!c) { return; }
      if (!validCombo(c)) { ui.keyErr.textContent = uiLang === 'ar' ? 'لازم تستعمل Ctrl أو Shift أو Alt مع المفتاح (أو F1-F12).' : 'Use Ctrl, Shift or Alt with the key (or F1-F12).'; return; }
      var other = which === 'paste' ? combos.frame : combos.paste;
      if (sameCombo(c, other)) { ui.keyErr.textContent = uiLang === 'ar' ? 'هالاختصار مستعمل للوظيفة الثانية.' : 'That shortcut is already used by the other action.'; return; }
      combos[which] = c;
      capturing = null;
      ui.keyErr.textContent = (uiLang === 'ar' ? 'تم. ' : 'Saved. ') + (IS_WIN ? '' : (uiLang === 'ar' ? 'على ماك بيشتغل والتركيز على اللوحة.' : 'On macOS it works while this panel has focus.'));
      refreshComboUi();
      saveSettings();
      registerPasteShortcut();
      if (IS_WIN) { updateHotkey(); }
      btn.blur();
    });
    resetBtn.addEventListener('click', function () {
      var d = Object.assign({}, DEFAULT_COMBOS[which]);
      var other = which === 'paste' ? combos.frame : combos.paste;
      if (sameCombo(d, other)) { ui.keyErr.textContent = uiLang === 'ar' ? 'الاختصار الافتراضي مستعمل للوظيفة الثانية. غيّرها أولاً.' : 'The default is used by the other action. Change that one first.'; return; }
      combos[which] = d;
      ui.keyErr.textContent = '';
      refreshComboUi();
      saveSettings();
      registerPasteShortcut();
      if (IS_WIN) { updateHotkey(); }
    });
  }

  /* Keeps the color swatch and the text box in step; the text box accepts any color format. */
  function syncTitleColorPicker() {
    var c = normalizeColor(ui.titleColor.value, true);
    var m = c && /^#([0-9a-f]{6})/i.exec(c);
    if (m) { ui.titleColorPick.value = '#' + m[1].toLowerCase(); }
  }

  function loadSettings() {
    try {
      var saved = JSON.parse(window.localStorage.getItem(CONFIG.SETTINGS_KEY) || 'null');
      if (!saved || typeof saved !== 'object') { return; }
      if (saved.mode === 'insert' || saved.mode === 'overwrite') { ui.placement.value = saved.mode; }
      if (typeof saved.copyLocal === 'boolean') { ui.copyLocal.checked = saved.copyLocal; }
      if (typeof saved.autoConvert === 'boolean') { ui.autoConvert.checked = saved.autoConvert; }
      if (typeof saved.organize === 'boolean') { ui.organize.checked = saved.organize; }
      if (typeof saved.verbose === 'boolean') { ui.verbose.checked = saved.verbose; }
      if (typeof saved.auto === 'boolean') { ui.auto.checked = saved.auto; }
      if (typeof saved.autoColor === 'boolean') { ui.autoColor.checked = saved.autoColor; }
      if (typeof saved.stage === 'boolean') { ui.stage.checked = saved.stage; }
      if (typeof saved.autoText === 'boolean') { ui.autoText.checked = saved.autoText; }
      if (typeof saved.hotkey === 'boolean') { ui.hotkey.checked = saved.hotkey; }
      if (typeof saved.hotkeyText === 'boolean') { ui.hotkeyText.checked = saved.hotkeyText; }
      if (typeof saved.frameKey === 'boolean') { ui.frameKey.checked = saved.frameKey; }
      if (validCombo(saved.comboPaste)) { combos.paste = saved.comboPaste; }
      if (validCombo(saved.comboFrame)) { combos.frame = saved.comboFrame; }
      if (typeof saved.track === 'string') { ui.track.value = saved.track; }
      if (typeof saved.still === 'string') { ui.still.value = saved.still; }
      if (typeof saved.fit === 'string' && /^(fit|shrink|fill|original)$/.test(saved.fit)) { ui.fit.value = saved.fit; }
      if (typeof saved.titleFont === 'string') { ui.titleFont.value = saved.titleFont; }
      if (typeof saved.titleTemplate === 'string') { ui.titleTemplate.value = saved.titleTemplate; }
      if (typeof saved.titleSize === 'string') { ui.titleSize.value = saved.titleSize; }
      if (typeof saved.titleColor === 'string') { ui.titleColor.value = saved.titleColor; syncTitleColorPicker(); }
      if (typeof saved.titlePos === 'string' && /^(top|center|bottom)$/.test(saved.titlePos)) { ui.titlePos.value = saved.titlePos; }
      if (typeof saved.titleBold === 'boolean') { ui.titleBold.checked = saved.titleBold; }
      if (typeof saved.titleShadow === 'boolean') { ui.titleShadow.checked = saved.titleShadow; }
      if (saved.lang === 'ar' || saved.lang === 'en') { uiLang = saved.lang; }
    } catch (e) { /* storage unavailable or corrupt: keep defaults */ }
  }

  function saveSettings() {
    try {
      window.localStorage.setItem(CONFIG.SETTINGS_KEY, JSON.stringify({
        mode: ui.placement.value,
        copyLocal: !!ui.copyLocal.checked,
        autoConvert: !!ui.autoConvert.checked,
        organize: !!ui.organize.checked,
        verbose: !!ui.verbose.checked,
        auto: !!ui.auto.checked,
        autoColor: !!ui.autoColor.checked,
        stage: !!ui.stage.checked,
        autoText: !!ui.autoText.checked,
        hotkey: !!ui.hotkey.checked,
        hotkeyText: !!ui.hotkeyText.checked,
        frameKey: !!ui.frameKey.checked,
        comboPaste: combos.paste,
        comboFrame: combos.frame,
        track: ui.track.value,
        still: ui.still.value,
        fit: ui.fit.value,
        titleFont: ui.titleFont.value,
        titleTemplate: ui.titleTemplate.value,
        titleSize: ui.titleSize.value,
        titleColor: ui.titleColor.value,
        titlePos: ui.titlePos.value,
        titleBold: !!ui.titleBold.checked,
        titleShadow: !!ui.titleShadow.checked,
        lang: uiLang
      }));
    } catch (e) { /* storage unavailable */ }
  }


  /* ------------------------------------------------------------------ */
  /* Global Ctrl+V (Windows): works while the timeline, not the panel, has focus */
  /* ------------------------------------------------------------------ */

  /*
   * CEP panels only receive keys while they have focus. hotkey.ps1 runs next to the panel and watches
   * Ctrl+V with a low-level keyboard hook, but only acts when Premiere Pro is the foreground app and the
   * clipboard holds media copied from another app. It tells us with a "QMP_HOTKEY" line.
   */
  var hotkeyProc = { proc: null, buf: '', failed: false, warned: false };

  function stopHotkey() {
    var p = hotkeyProc.proc;
    hotkeyProc.proc = null;
    if (p) { try { p.kill(); } catch (e) { /* already gone */ } }
  }

  function startHotkey() {
    if (!IS_WIN || (!ui.hotkey.checked && !ui.frameKey.checked) || hotkeyProc.proc || hotkeyProc.failed) { return; }
    var dir = extensionFolder();
    var script = dir ? path.join(dir, 'hotkey.ps1') : '';
    if (!script || !fs.existsSync(script)) { hotkeyProc.failed = true; logWarn('hotkey.ps1 was not found, so Ctrl+V on the timeline is off.'); return; }
    try {
      var proc = childProcess.spawn(powershellExe(),
        ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-Exts', Object.keys(EXT_KIND).join(','),
          '-PasteKey', comboArg(combos.paste), '-FrameKey', comboArg(combos.frame),
          '-Paste', ui.hotkey.checked ? '1' : '0', '-Text', ui.hotkeyText.checked ? '1' : '0', '-Frame', ui.frameKey.checked ? '1' : '0'],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      hotkeyProc.proc = proc;
      hotkeyProc.buf = '';
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', function (chunk) {
        hotkeyProc.buf += chunk;
        var nl;
        while ((nl = hotkeyProc.buf.indexOf('\n')) !== -1) {
          var line = hotkeyProc.buf.slice(0, nl).trim();
          hotkeyProc.buf = hotkeyProc.buf.slice(nl + 1);
          if (line === 'QMP_READY') { logDebug('Ctrl+V hotkey helper ready.'); }
          else if (line === 'QMP_HOTKEY') {
            if (state.busy) { logWarn('A paste is already running.'); }
            else { runPaste(null, 'Ctrl+V:'); }
          } else if (line === 'QMP_FRAME') { copyFrameToClipboard(); }
          else if (line.indexOf('QMP_ERROR:') === 0) { logWarn('Ctrl+V hotkey helper: ' + line.slice(10)); }
        }
      });
      var errBuf = '';
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', function (c) { errBuf = truncate(errBuf + c, 600); });
      proc.stdin.on('error', function () { /* process ended */ });
      proc.on('error', function () { if (hotkeyProc.proc === proc) { hotkeyProc.proc = null; hotkeyProc.failed = true; } });
      proc.on('exit', function (code) {
        if (hotkeyProc.proc !== proc) { return; }
        hotkeyProc.proc = null;
        if (!hotkeyProc.warned) {
          hotkeyProc.warned = true;
          logWarn('Ctrl+V on the timeline stopped (' + code + '). ' + errBuf.trim() + ' Antivirus may block keyboard hooks. The Paste button and auto-paste still work.');
        }
      });
    } catch (e) {
      hotkeyProc.failed = true;
      hotkeyProc.proc = null;
      logWarn('Could not start the Ctrl+V helper: ' + errMsg(e));
    }
  }

  function updateHotkey() {
    stopHotkey();
    hotkeyProc.failed = false; hotkeyProc.warned = false;
    startHotkey();
  }

  /* ------------------------------------------------------------------ */
  /* Copy the current frame to the clipboard                             */
  /* ------------------------------------------------------------------ */

  async function copyFrameToClipboard() {
    if (state.busy) { logWarn('Busy. Try again in a moment.'); return; }
    if (!nodeReady) { return; }
    setBusy(true);
    setStatus('busy', 'Working');
    var tmp = path.join(os.tmpdir(), 'qmp_frame_' + randomId() + '.png');
    try {
      logInfo('Exporting the current frame...');
      var r = await hostCall('QMP_exportFrame', { outPath: tmp }, 60000);
      if (!r.ok) { throw new Error(r.error || 'Could not export the frame.'); }
      var st = null;
      for (var i = 0; i < 20; i++) {
        try { st = await fsp.stat(tmp); if (st.size > 0) { break; } } catch (e0) { st = null; }
        await sleep(150);
      }
      if (!st || !st.size) { throw new Error('The frame file was not written.'); }
      if (IS_WIN) {
        await runPowerShell("Add-Type -AssemblyName System.Windows.Forms,System.Drawing\n$i=[System.Drawing.Image]::FromFile($env:QMP_PNG)\n$b=New-Object System.Drawing.Bitmap($i)\n$i.Dispose()\n[System.Windows.Forms.Clipboard]::SetImage($b)\n", { QMP_PNG: tmp }, 20000);
      } else {
        await execFileP('/usr/bin/osascript', ['-e', 'set the clipboard to (read (POSIX file "' + tmp.replace(/"/g, '') + '") as \u00ABclass PNGf\u00BB)'], {}, 20000);
      }
      /* our own copy must not trigger auto-paste */
      try { watch.lastSeq = await getClipSeq(); } catch (e1) { /* ignore */ }
      logOk('Current frame copied to the clipboard as an image.');
      setStatus('ok', 'Done');
      setMessage('ok', uiLang === 'ar' ? 'اننسخ الفريم الحالي كصورة.' : 'Current frame copied as an image.');
    } catch (e) {
      logError(errMsg(e));
      setStatus('error', 'Error');
      setMessage('error', friendlyError(errMsg(e)));
    } finally {
      await safeUnlink(tmp);
      setBusy(false);
      resetStatusSoon();
    }
  }

  /*
   * Premiere Pro handles Ctrl/Cmd+V itself (timeline paste) before a panel sees it, unless the
   * panel registers interest in that key combination with the CEP host.
   */
  function registerPasteShortcut() {
    try {
      var cep = window.__adobe_cep__;
      if (cep && typeof cep.registerKeyEventsInterest === 'function') {
        var list = [combos.paste, combos.frame].map(function (c) {
          var o = { keyCode: c.vk };
          if (c.ctrl) { if (IS_MAC) { o.metaKey = true; } else { o.ctrlKey = true; } }
          if (c.shift) { o.shiftKey = true; }
          if (c.alt) { o.altKey = true; }
          return o;
        });
        cep.registerKeyEventsInterest(JSON.stringify(list));
      }
    } catch (e) {
      logDebug('Could not register the paste shortcut with Premiere Pro: ' + errMsg(e));
    }
  }

  function bindUi() {
    [ui.placement, ui.copyLocal, ui.autoConvert, ui.organize, ui.verbose, ui.track, ui.still, ui.fit].forEach(function (el) {
      el.addEventListener('change', saveSettings);
    });
    ui.auto.addEventListener('change', function () { saveSettings(); updateWatch(); });
    ui.stage.addEventListener('change', function () { saveSettings(); if (!ui.stage.checked) { discardStage(); } updateWatch(); });
    ui.titleTemplateBrowse.addEventListener('click', browseTitleTemplate);
    [ui.autoColor, ui.autoText, ui.titleTemplate, ui.titleFont, ui.titleSize, ui.titlePos, ui.titleBold, ui.titleShadow].forEach(function (el) { el.addEventListener('change', saveSettings); });
    ui.titleColorPick.addEventListener('input', function () { ui.titleColor.value = ui.titleColorPick.value; saveSettings(); });
    ui.titleColor.addEventListener('change', function () {
      var c = normalizeColor(ui.titleColor.value, true);
      if (c) { syncTitleColorPicker(); } else { ui.titleColor.value = DEFAULT_TITLE_STYLE.color; syncTitleColorPicker(); }
      saveSettings();
    });
    [ui.hotkey, ui.hotkeyText, ui.frameKey].forEach(function (el) { el.addEventListener('change', function () { saveSettings(); updateHotkey(); }); });
    ui.frameBtn.addEventListener('click', function () { copyFrameToClipboard(); });

    Array.prototype.forEach.call(document.querySelectorAll('.seg-btn'), function (b) {
      b.addEventListener('click', function () {
        if (state.busy) { return; }
        ui.placement.value = b.getAttribute('data-mode') === 'insert' ? 'insert' : 'overwrite';
        updateModeUi();
        saveSettings();
      });
    });

    ui.langBtn.addEventListener('click', function () {
      uiLang = uiLang === 'ar' ? 'en' : 'ar';
      applyLang();
      saveSettings();
    });

    ui.pasteBtn.addEventListener('click', function () { runPaste(); });

    ui.cancelBtn.addEventListener('click', function () {
      if (!state.busy) { return; }
      state.cancelled = true;
      logWarn('Cancelling. Work already handed to Premiere Pro cannot be interrupted.');
      if (state.abortActive) { try { state.abortActive(); } catch (e) { /* ignore */ } }
    });

    ui.clearLogBtn.addEventListener('click', function () {
      while (ui.console.firstChild) { ui.console.removeChild(ui.console.firstChild); }
    });

    ui.copyLogBtn.addEventListener('click', copyLogToClipboard);
    ui.openFolderBtn.addEventListener('click', function () {
      if (!lastPastedDir) { logWarn('No folder yet. Paste something first.'); return; }
      try {
        if (IS_WIN) { childProcess.spawn('explorer.exe', [lastPastedDir], { detached: true, stdio: 'ignore', windowsHide: false }).unref(); }
        else { childProcess.spawn('/usr/bin/open', [lastPastedDir], { detached: true, stdio: 'ignore' }).unref(); }
      } catch (e) { logWarn('Could not open the folder: ' + errMsg(e)); }
    });
    ui.toggleLogBtn.addEventListener('click', function () { setLogCollapsed(!ui.logBox.classList.contains('collapsed')); });

    /* Drag and drop: files from Explorer/Finder, or links/images dragged from a browser. */
    var dragDepth = 0;
    function hasPayload(ev) {
      var dt = ev.dataTransfer;
      if (!dt) { return false; }
      var types = dt.types ? Array.prototype.slice.call(dt.types) : [];
      return types.indexOf('Files') !== -1 || types.indexOf('text/uri-list') !== -1 || types.indexOf('text/plain') !== -1;
    }
    document.addEventListener('dragenter', function (ev) {
      if (!hasPayload(ev)) { return; }
      ev.preventDefault();
      dragDepth++;
      if (!state.busy) { ui.dropOverlay.hidden = false; }
    });
    document.addEventListener('dragover', function (ev) {
      if (!hasPayload(ev)) { return; }
      ev.preventDefault();
      try { ev.dataTransfer.dropEffect = 'copy'; } catch (e) { /* ignore */ }
    });
    document.addEventListener('dragleave', function (ev) {
      if (!hasPayload(ev)) { return; }
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) { ui.dropOverlay.hidden = true; }
    });
    document.addEventListener('drop', function (ev) {
      ev.preventDefault();
      dragDepth = 0;
      ui.dropOverlay.hidden = true;
      if (state.busy) { logWarn('A paste is already running.'); return; }
      var dt = ev.dataTransfer;
      if (!dt) { return; }
      var dropped = [];
      var files = dt.files ? Array.prototype.slice.call(dt.files) : [];
      files.forEach(function (f) { if (f && f.path) { dropped.push({ kind: 'file', value: f.path }); } });
      if (!dropped.length) {
        var text = '';
        try { text = dt.getData('text/uri-list') || dt.getData('text/plain') || ''; } catch (e1) { text = ''; }
        if (text) { dropped = parseClipboardText(text).items; }
      }
      if (!dropped.length) {
        if (files.length) { logWarn('This Premiere Pro version does not expose the paths of dropped files. Copy the file (Ctrl+C / Cmd+C) and press Paste instead.'); }
        else { logWarn('Nothing usable was dropped.'); }
        setMessage('warn', uiLang === 'ar' ? 'ما قدرت أقرأ الملف المسحوب. انسخه (Ctrl+C) واضغط لصق.' : 'Could not read the dropped file. Copy it (Ctrl+C) and press Paste.');
        return;
      }
      runPaste(dropped);
    });

    document.addEventListener('keydown', function (ev) {
      if (capturing) { return; }
      var tag = ev.target && ev.target.tagName ? ev.target.tagName.toLowerCase() : '';
      if (comboMatches(combos.paste, ev) && tag !== 'select') {
        ev.preventDefault();
        runPaste();
      } else if (comboMatches(combos.frame, ev) && tag !== 'select') {
        ev.preventDefault();
        copyFrameToClipboard();
      }
    });

    window.addEventListener('error', function (ev) {
      logError('Unexpected error: ' + (ev && ev.message ? ev.message : 'unknown'));
    });

    window.addEventListener('unhandledrejection', function (ev) {
      logError('Unexpected error: ' + errMsg(ev && ev.reason));
    });
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function pingHost() {
    var lastErr = null;
    for (var attempt = 1; attempt <= 5; attempt++) {
      try {
        var info = await hostCall('QMP_ping', {}, CONFIG.HOST_PING_TIMEOUT_MS);
        if (!info.ok) { throw new Error(info.error || 'Ping failed.'); }
        checkPreviousCrash();
        hostVersionStr = String(info.hostVersion) + '/' + String(info.hostBuild || '');
        logOk('Connected to Premiere Pro ' + info.hostVersion + ' (host script ' + info.hostscriptVersion + ').');
        setStatus('idle', idleLabel());
        return;
      } catch (e) {
        lastErr = e;
        if (attempt < 5) { await sleep(700 * attempt); }
      }
    }
    logWarn('Premiere Pro host script is not responding: ' + errMsg(lastErr));
    setStatus('error', 'Host offline');
  }

  function init() {
    try {
      if (!/"lang"/.test(window.localStorage.getItem(CONFIG.SETTINGS_KEY) || '') && /^ar/i.test(navigator.language || '')) { uiLang = 'ar'; }
    } catch (e0) { /* keep English */ }
    loadSettings();
    ui.logBox.classList.add('collapsed');
    applyLang();
    bindUi();
    registerPasteShortcut();
    if (!nodeReady) {
      ui.pasteBtn.disabled = true;
      setStatus('error', 'Node.js off');
      logError('Node.js is not enabled for this panel. Check that CSXS/manifest.xml contains the --enable-nodejs and --mixed-context parameters, then restart Premiere Pro.');
      return;
    }
    if (!IS_WIN && !IS_MAC) {
      ui.pasteBtn.disabled = true;
      setStatus('error', 'Unsupported OS');
      logError('QuickMediaPaste supports Windows and macOS only.');
      return;
    }
    logInfo('QuickMediaPaste started on ' + (IS_WIN ? 'Windows' : 'macOS') + '. Copy media, then press Paste to Timeline or ' + comboLabel(combos.paste) + (IS_WIN ? ' anywhere in Premiere Pro.' : ' while this panel has focus.'));
    startWinWorker();
    if (!IS_WIN) { ui.hotkeyRow.style.display = 'none'; ui.hotkeyTextRow.style.display = 'none'; ui.frameKeyRow.style.display = 'none'; } else { startHotkey(); }
    bindComboButton(ui.keyPaste, ui.keyPasteReset, 'paste');
    bindComboButton(ui.keyFrame, ui.keyFrameReset, 'frame');
    refreshComboUi();
    window.addEventListener('beforeunload', function () { killWinWorker(); stopHotkey(); });
    updateWatch();
    pingHost();
  }

  init();
})();
