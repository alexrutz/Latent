@echo off
rem Starts Latent under its launcher, which starts it again after an update
rem (Settings > Software > Restart) and after a crash. Double-click it, or run it
rem from a shortcut. Close this window or press Ctrl+C to stop Latent.
cd /d "%~dp0"
node scripts\launcher.mjs %*
if errorlevel 1 pause
