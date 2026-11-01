@echo off
cd /d "%~dp0"
node scripts/start-preview.mjs
if errorlevel 1 pause
