@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

echo === Starting MCP Service ===
echo Make sure Worker is running first (start-worker.bat)
echo.
node dist/servers/mcp-server.js
