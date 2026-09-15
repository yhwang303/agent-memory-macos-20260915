@echo off
chcp 65001 >nul 2>&1
node "D:\GitHub\agent-memory\dist\hooks-cli.js" %*
