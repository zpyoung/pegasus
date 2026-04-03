"""Entry point for ``python -m pegasus`` and the ``pegasus`` console script."""

from __future__ import annotations

import sys


def main() -> None:
    """Main CLI entry point.  Delegates to ``ui.cli`` once that module exists."""
    try:
        from pegasus.ui import cli  # noqa: PLC0415 — deferred import is intentional
    except ImportError:
        # ui.py is not yet implemented (early scaffold iteration)
        print("pegasus: UI module not yet available. Run `pegasus --help` after full install.")
        sys.exit(1)

    cli(standalone_mode=True)


if __name__ == "__main__":
    main()
