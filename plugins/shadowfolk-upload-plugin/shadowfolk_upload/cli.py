from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .config import load_shadow_config, load_upload_config, merge_workspace_config
from .runner import run_daemon, upload_once


def default_shadow_config_path() -> Path:
    return Path.home() / ".shadow" / "config.json"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Upload local agent-memory records to ShadowFolk")
    subparsers = parser.add_subparsers(dest="command")

    once = subparsers.add_parser("once", help="Upload one workspace once")
    once.add_argument("--workspace", "-w", required=True)
    once.add_argument("--shadow-config", default=str(default_shadow_config_path()))
    once.add_argument("--upload-config")

    daemon = subparsers.add_parser("daemon", help="Run continuous upload loop")
    daemon.add_argument("--shadow-config", default=str(default_shadow_config_path()))
    daemon.add_argument("--upload-config", required=True)

    args = parser.parse_args(argv)

    try:
        if args.command == "once":
            shadow_config = load_shadow_config(Path(args.shadow_config))
            shadow_config = merge_workspace_config(shadow_config, args.workspace)
            upload_config = load_upload_config(Path(args.upload_config) if args.upload_config else None)
            result = upload_once(args.workspace, shadow_config, upload_config.status_file)
            print(json.dumps(result.__dict__, ensure_ascii=False, indent=2))
            return 0

        if args.command == "daemon":
            shadow_config = load_shadow_config(Path(args.shadow_config))
            upload_config = load_upload_config(Path(args.upload_config))
            if not upload_config.enabled:
                print("[shadowfolk-upload] disabled by upload config")
                return 0
            if not upload_config.workspaces:
                print("[shadowfolk-upload] no workspaces configured", file=sys.stderr)
                return 1
            run_daemon(
                upload_config.workspaces,
                shadow_config,
                upload_config.interval_seconds,
                upload_config.retry_max_attempts,
                upload_config.retry_base_delay_seconds,
                upload_config.retry_max_delay_seconds,
                upload_config.status_file,
            )
            return 0

        parser.print_help()
        return 2
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        print(f"[shadowfolk-upload] ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
