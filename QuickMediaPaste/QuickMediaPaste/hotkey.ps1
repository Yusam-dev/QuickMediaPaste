# QuickMediaPaste - global Ctrl+V helper (Windows).
# Runs as a child of the panel. While Premiere Pro is the foreground app and the clipboard holds
# media (files, a bitmap, or a media link copied from ANOTHER app), Ctrl+V is swallowed and
# "QMP_HOTKEY" is printed so the panel pastes it at the playhead. Anything else passes through
# untouched, so Premiere's own clip copy/paste keeps working. Exits when the panel closes (stdin EOF).
param([string]$Exts = '', [string]$Paste = '1', [string]$Text = '0', [string]$Frame = '1', [string]$PasteKey = '1,0,0,86', [string]$FrameKey = '1,1,0,67')
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public static class QmpHotkey {
  [StructLayout(LayoutKind.Sequential)]
  struct KBD { public uint vk; public uint scan; public uint flags; public uint time; public IntPtr extra; }
  delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc cb, IntPtr mod, uint tid);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int c, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string n);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint tid, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsClipboardFormatAvailable(uint f);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterClipboardFormat(string s);
  [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr h);
  [DllImport("user32.dll")] static extern bool CloseClipboard();
  [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint f);
  [DllImport("user32.dll")] static extern IntPtr GetClipboardOwner();
  [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr h);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern uint DragQueryFile(IntPtr h, uint i, StringBuilder b, uint n);

  const uint CF_BITMAP = 2, CF_DIB = 8, CF_UNICODETEXT = 13, CF_HDROP = 15, CF_DIBV5 = 17;
  static HookProc proc = new HookProc(Callback);
  static IntPtr hook = IntPtr.Zero;
  static uint mainThread;
  static uint pngFormat;
  static HashSet<string> exts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  static bool swallowing = false;
  static uint swallowVk = 0;
  static uint pasteVk = 0x56, frameVk = 0x43;
  static bool pCtrl = true, pShift = false, pAlt = false, fCtrl = true, fShift = true, fAlt = false;
  static void ParseCombo(string s, ref uint vk, ref bool c, ref bool sh, ref bool a) {
    try {
      string[] p = s.Split(',');
      if (p.Length == 4) { c = p[0] == "1"; sh = p[1] == "1"; a = p[2] == "1"; vk = uint.Parse(p[3]); }
    } catch (Exception) { }
  }
  static bool pasteOn = true, textOn = false, frameOn = true;
  static System.Text.RegularExpressions.Regex colorRx = new System.Text.RegularExpressions.Regex(
    @"^\s*(background(-image|-color)?\s*:\s*)?(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgb|rgba|hsl|hsla|linear-gradient|radial-gradient)\(.*\))\s*;?\s*$",
    System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.Singleline);
  static uint cachePid = 0; static bool cacheResult = false; static long cacheTick = 0;
  static readonly object outLock = new object();

  static void Emit(string s) { lock (outLock) { Console.Out.WriteLine(s); Console.Out.Flush(); } }

  public static void Run(string extList, bool paste, bool text, bool frame, string pasteKey, string frameKey) {
    pasteOn = paste; textOn = text; frameOn = frame;
    ParseCombo(pasteKey, ref pasteVk, ref pCtrl, ref pShift, ref pAlt);
    ParseCombo(frameKey, ref frameVk, ref fCtrl, ref fShift, ref fAlt);
    foreach (string e in extList.Split(new char[] { ',' }, StringSplitOptions.RemoveEmptyEntries)) { exts.Add(e.Trim().TrimStart('.')); }
    pngFormat = RegisterClipboardFormat("PNG");
    mainThread = GetCurrentThreadId();
    hook = SetWindowsHookEx(13, proc, GetModuleHandle(null), 0);
    if (hook == IntPtr.Zero) { Emit("QMP_ERROR:hook failed " + Marshal.GetLastWin32Error()); return; }
    Thread t = new Thread(delegate () {
      try { while (Console.In.ReadLine() != null) { } } catch (Exception) { }
      PostThreadMessage(mainThread, 0x12, IntPtr.Zero, IntPtr.Zero);
    });
    t.IsBackground = true;
    t.Start();
    Emit("QMP_READY");
    Application.Run();
    UnhookWindowsHookEx(hook);
  }

  static IntPtr Callback(int code, IntPtr w, IntPtr l) {
    try {
      if (code >= 0) {
        KBD k = (KBD)Marshal.PtrToStructure(l, typeof(KBD));
        int msg = (int)w;
        if ((k.vk == pasteVk || k.vk == frameVk) && (k.flags & 0x10) == 0) {
          if (msg == 0x100) {
            if (swallowing && k.vk == swallowVk) { return (IntPtr)1; }
            bool ctrl = (GetAsyncKeyState(0x11) & 0x8000) != 0;
            bool shift = (GetAsyncKeyState(0x10) & 0x8000) != 0;
            bool alt = (GetAsyncKeyState(0x12) & 0x8000) != 0;
            bool win = (GetAsyncKeyState(0x5B) & 0x8000) != 0 || (GetAsyncKeyState(0x5C) & 0x8000) != 0;
            if (!win) {
              if (k.vk == pasteVk && ctrl == pCtrl && shift == pShift && alt == pAlt && pasteOn && ShouldHandle()) {
                swallowing = true; swallowVk = k.vk;
                Emit("QMP_HOTKEY");
                return (IntPtr)1;
              }
              if (k.vk == frameVk && ctrl == fCtrl && shift == fShift && alt == fAlt && frameOn) {
                uint pid = ForegroundPid();
                if (pid != 0 && IsPremiere(pid)) {
                  swallowing = true; swallowVk = k.vk;
                  Emit("QMP_FRAME");
                  return (IntPtr)1;
                }
              }
            }
          } else if (msg == 0x101 && swallowing && k.vk == swallowVk) {
            swallowing = false;
            return (IntPtr)1;
          }
        }
      }
    } catch (Exception) { }
    return CallNextHookEx(hook, code, w, l);
  }

  static uint ForegroundPid() {
    uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid); return pid;
  }

  static bool IsPremiere(uint pid) {
    long now = Environment.TickCount;
    if (pid == cachePid && now - cacheTick < 3000) { return cacheResult; }
    bool r = false;
    try { using (Process p = Process.GetProcessById((int)pid)) { r = p.ProcessName.StartsWith("Adobe Premiere Pro", StringComparison.OrdinalIgnoreCase); } } catch (Exception) { }
    cachePid = pid; cacheResult = r; cacheTick = now;
    return r;
  }

  static bool ShouldHandle() {
    uint pid = ForegroundPid();
    if (pid == 0 || !IsPremiere(pid)) { return false; }
    /* Something Premiere itself copied (timeline clips, text fields): leave it to Premiere. */
    IntPtr owner = GetClipboardOwner();
    if (owner != IntPtr.Zero) { uint op; GetWindowThreadProcessId(owner, out op); if (op == pid) { return false; } }
    return ClipboardHasMedia();
  }

  static bool ExtIsMedia(string p) {
    try {
      string e = Path.GetExtension(p);
      return !string.IsNullOrEmpty(e) && exts.Contains(e.TrimStart('.'));
    } catch (Exception) { return false; }
  }

  static bool OpenClip() {
    for (int i = 0; i < 4; i++) { if (OpenClipboard(IntPtr.Zero)) { return true; } Thread.Sleep(15); }
    return false;
  }

  static bool ClipboardHasMedia() {
    bool files = IsClipboardFormatAvailable(CF_HDROP);
    bool image = IsClipboardFormatAvailable(CF_BITMAP) || IsClipboardFormatAvailable(CF_DIB) ||
                 IsClipboardFormatAvailable(CF_DIBV5) || (pngFormat != 0 && IsClipboardFormatAvailable(pngFormat));
    bool text = IsClipboardFormatAvailable(CF_UNICODETEXT);
    if (!files && !text) { return image; }
    if (!OpenClip()) { return false; }
    try {
      if (files) {
        IntPtr h = GetClipboardData(CF_HDROP);
        if (h != IntPtr.Zero) {
          uint n = DragQueryFile(h, 0xFFFFFFFF, null, 0);
          for (uint i = 0; i < n && i < 50; i++) {
            StringBuilder sb = new StringBuilder(1024);
            DragQueryFile(h, i, sb, 1024);
            string fp = sb.ToString();
            if (ExtIsMedia(fp) || Directory.Exists(fp)) { return true; }
          }
        }
        return false;
      }
      if (image) { return true; }
      IntPtr th = GetClipboardData(CF_UNICODETEXT);
      if (th == IntPtr.Zero) { return false; }
      IntPtr ptr = GlobalLock(th);
      if (ptr == IntPtr.Zero) { return false; }
      string txt;
      try { txt = Marshal.PtrToStringUni(ptr); } finally { GlobalUnlock(th); }
      if (string.IsNullOrEmpty(txt) || txt.Length > 20000) { return false; }
      if (colorRx.IsMatch(txt.Replace("\r", " ").Replace("\n", " "))) { return true; }
      foreach (string raw in txt.Split(new char[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)) {
        string line = raw.Trim().Trim('"', '\'');
        if (line.Length == 0) { continue; }
        if (line.StartsWith("data:image/", StringComparison.OrdinalIgnoreCase) ||
            line.StartsWith("data:video/", StringComparison.OrdinalIgnoreCase) ||
            line.StartsWith("data:audio/", StringComparison.OrdinalIgnoreCase)) { return true; }
        if (line.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || line.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) {
          Uri u;
          if (Uri.TryCreate(line, UriKind.Absolute, out u) && ExtIsMedia(u.AbsolutePath)) { return true; }
        } else if ((line.Length > 3 && line[1] == ':' && (line[2] == '\\' || line[2] == '/')) || line.StartsWith("\\\\") || line.StartsWith("file:", StringComparison.OrdinalIgnoreCase)) {
          if (ExtIsMedia(line)) { return true; }
        }
      }
      return textOn && txt.Trim().Length > 0;
    } catch (Exception) { return false; }
    finally { CloseClipboard(); }
  }
}
'@
[QmpHotkey]::Run($Exts, ($Paste -eq '1'), ($Text -eq '1'), ($Frame -eq '1'), $PasteKey, $FrameKey)
