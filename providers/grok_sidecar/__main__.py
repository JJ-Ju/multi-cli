"""Command-line entry point for the Grok provider sidecar."""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

from .runner import SidecarRunner


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Grok provider sidecar for Gemini CLI",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        help="Python logging level (default: INFO)",
    )
    parser.add_argument(
        "--log-file",
        default=None,
        help="Optional path to append detailed sidecar logs",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        filename=args.log_file,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    env_file = Path(__file__).resolve().parent / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key, value)

    runner = SidecarRunner()
    try:
        runner.run()
    except KeyboardInterrupt:
        logging.info("Sidecar interrupted via KeyboardInterrupt")
    except Exception:  # pragma: no cover - defensive logging
        logging.exception("Fatal error inside Grok sidecar")
        return 1
    finally:
        runner.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
