"""Pegasus runner subprocess entry-point.

This module is invoked as ``python3 -m pegasus._run_task <task-id> [--resume]``
by the CLI's ``run`` and ``resume`` commands.  It imports runner.PipelineExecutor
and delegates to ``run_task`` or ``resume_task``.

The ``PEGASUS_PROJECT_DIR`` environment variable must be set (done by ui.py when
spawning this subprocess).

**Note**: Only this module imports runner.py.  ui.py NEVER imports runner.py.
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path


def main() -> None:
    """Parse arguments and run the appropriate pipeline executor method."""
    args = sys.argv[1:]

    if not args:
        print("Usage: python3 -m pegasus._run_task <task-id> [--resume]", file=sys.stderr)
        sys.exit(1)

    task_id = args[0]
    resume_mode = "--resume" in args

    project_dir_str = os.environ.get("PEGASUS_PROJECT_DIR")
    if not project_dir_str:
        # Fall back to current working directory
        project_dir_str = str(Path.cwd())

    project_dir = Path(project_dir_str)

    # Import PipelineExecutor here (only this module imports runner.py)
    from pegasus.runner import PipelineExecutor  # noqa: PLC0415

    executor = PipelineExecutor(project_dir=project_dir)

    if resume_mode:
        asyncio.run(executor.resume_task(task_id))
    else:
        asyncio.run(executor.run_task(task_id))


if __name__ == "__main__":
    main()
