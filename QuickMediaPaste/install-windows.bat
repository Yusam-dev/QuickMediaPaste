@echo off
setlocal
set "SRC=%~dp0QuickMediaPaste"
set "DEST=%APPDATA%\Adobe\CEP\extensions\com.quickmediapaste"

if not exist "%SRC%\CSXS\manifest.xml" (
  echo ERROR: QuickMediaPaste folder not found next to this script.
  pause
  exit /b 1
)

echo Make sure Premiere Pro is closed, then
pause

if exist "%DEST%" rmdir /s /q "%DEST%"
xcopy "%SRC%" "%DEST%\" /E /I /Y /Q >nul
if errorlevel 1 (
  echo ERROR: copy failed.
  pause
  exit /b 1
)

rem Unsigned extensions only load when CEP debug mode is on (CSXS.11 = Premiere 2022-2024, CSXS.12 = 2025+).
for %%V in (9 10 11 12 13 14 15 16) do reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul

echo.
echo Installed to: %DEST%
echo Open Premiere Pro, then Window ^> Extensions ^> QuickMediaPaste
pause
