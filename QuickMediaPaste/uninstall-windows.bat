@echo off
set "DEST=%APPDATA%\Adobe\CEP\extensions\com.quickmediapaste"
if exist "%DEST%" rmdir /s /q "%DEST%"
echo QuickMediaPaste removed.
echo.
echo The installer turned on CEP debug mode so unsigned extensions can load.
echo Turn it off again? Choose N if you use other unsigned Premiere extensions.
choice /c YN /n /m "Turn off CEP debug mode now? [Y/N] "
if errorlevel 2 goto keep
for %%V in (9 10 11 12 13 14 15 16) do reg delete "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /f >nul 2>&1
echo CEP debug mode turned off.
goto end
:keep
echo CEP debug mode left as is.
:end
pause
