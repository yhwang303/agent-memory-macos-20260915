# agent-memory Migration Guide

## From older agent-memory versions

### Database migration
agent-memory automatically migrates the SQLite database when new columns are needed. No manual steps required. The database is at `~/.agent-memory/agent-memory.db`.

### New features in this release

- **Multi-platform support**: 11 new IDE/CLI integrations (Windsurf, Gemini CLI, OpenCode, Codex CLI, Copilot CLI, Antigravity, Goose, Crush, Roo Code, Warp, plus Cursor upgrade)
- **Hybrid search**: RAG (Chroma + bge-m3) combined with SQLite FTS5 for improved recall
- **Image semantics**: Claude Code transcript reading for image description capture
- **OpenClaw gateway**: Plugin for chat gateway integrations (Telegram, Discord, Slack)
- **CLI commands**: `agent-memory install`, `agent-memory status`, `agent-memory doctor`

### One-liner install for new IDEs

```bash
# Auto-detect and install all found IDEs
npx tsx src/cli.ts install --all

# Install specific IDEs
npx tsx src/cli.ts install cursor windsurf gemini-cli

# Check status
npx tsx src/cli.ts status

# System health
npx tsx src/cli.ts doctor
```

## From claude-mem

If you're switching from [claude-mem](https://github.com/thedotmack/claude-mem):

1. **Data**: agent-memory uses a separate database (`~/.agent-memory/agent-memory.db`). Your claude-mem data will remain in `~/.claude-mem/`.
2. **Hooks**: agent-memory uses the same hook mechanism. Update your IDE hooks config to point to agent-memory's `hooks-cli.ts`.
3. **RAG**: agent-memory supports Chroma via `chroma-mcp` (same as claude-mem). Enable in `~/.agent-memory/settings.json`:
   ```json
   { "rag": { "enabled": true, "embedding_model": "bge-m3" } }
   ```
4. **License**: agent-memory is now AGPL-3.0 (same as claude-mem).

## Optional: RAG / Chroma setup

RAG is optional. Without it, agent-memory uses SQLite FTS5 for search (still effective).

To enable:
1. Install uv: `winget install --id=astral-sh.uv -e` (Windows) or `curl -LsSf https://astral.sh/uv/install.sh | sh` (Linux/macOS)
2. Set `rag.enabled: true` in `~/.agent-memory/settings.json`
3. Restart agent-memory worker — bge-m3 model (~2GB) downloads on first use

## Troubleshooting

Run `agent-memory doctor` to check system health:
```
agent-memory doctor
==================
Core (SQLite):    OK (17847 observations, 1814 summaries)
RAG (Chroma):     Enabled (model: bge-m3)
IDEs detected:    6 (Cursor, Claude Code, ...)
```
