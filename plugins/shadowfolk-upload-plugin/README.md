# ShadowFolk Upload Plugin

Pure-script uploader for sending local agent-memory records to ShadowFolk.

## Scope

This plugin reads local `agent-memory.db` records and uploads them to ShadowFolk. It does not modify agent-memory's sync queue, remote client, database schema, or OpenClaw plugin.

The client calls no local LLM. ShadowFolk remains responsible for server-side task summary processing.

## Modes

- `once`: upload one workspace once, then exit.
- `daemon`: loop over configured workspaces and upload incrementally.

## Configuration

Global ShadowFolk auth config lives at `~/.shadow/config.json`:

```json
{
  "server": "https://shadowfolk.example.com",
  "api_token": "sf_example_token",
  "memory_db": "C:/Users/name/.agent-memory/agent-memory.db"
}
```

Upload daemon config can be based on `examples/upload.example.json`.

Workspace-level `.shadow/config.json` can override `server`, `project_id`, or other ShadowFolk binding fields while inheriting the global token.

## Once Upload

Run:

```bash
PYTHONPATH=plugins/shadowfolk-upload-plugin python -m shadowfolk_upload.cli once --workspace E:/Github/agent-memory
```

This performs one pure-script upload. It reads local memory records and sends them to ShadowFolk. No local LLM is called.

## Daemon Mode

Run:

```bash
PYTHONPATH=plugins/shadowfolk-upload-plugin python -m shadowfolk_upload.cli daemon --upload-config ~/.shadow/upload.json
```

Linux can run this under systemd. Windows UI shells can start and stop this process.

## Windows UI Contract

The UI shell should not reimplement upload logic. It should:

- Write upload config JSON.
- Start or stop the Python daemon process.
- Call `once` for manual upload.
- Read `statusFile` for current workspace status.
- Show `logFile` if configured by the wrapper.

The status file contains `workspace`, `uploaded`, `batch_id`, observation and summary counts, `error`, and `updated_at`.

## Testing

Run:

```bash
cd plugins/shadowfolk-upload-plugin
python -m unittest discover -s tests -v
```
