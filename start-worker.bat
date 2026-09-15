@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

echo === Starting Worker Service ===
node dist/bin/worker.js stop >nul 2>&1
node dist/bin/worker.js start
