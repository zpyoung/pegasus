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
    merge_mode = "--merge" in args

    project_dir_str = os.environ.get("PEGASUS_PROJECT_DIR")
    if not project_dir_str:
        # Fall back to current working directory
        project_dir_str = str(Path.cwd())

    project_dir = Path(project_dir_str)
    db_path = project_dir / ".pegasus" / "pegasus.db"

    # Import runner components here (only this module imports runner.py)
    from pegasus.runner import ClaudeAgentRunner, PipelineExecutor  # noqa: PLC0415

    # Set up stderr logging — captures claude CLI stderr into the task log
    log_dir = project_dir / ".pegasus" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    stderr_log = open(log_dir / f"{task_id}.stderr.log", "a", encoding="utf-8")  # noqa: SIM115

    def _on_stderr(line: str) -> None:
        stderr_log.write(line + "\n")
        stderr_log.flush()

    agent_runner = ClaudeAgentRunner(on_stderr=_on_stderr)
    executor = PipelineExecutor(
        db_path=db_path,
        agent_runner=agent_runner,
        project_dir=project_dir,
    )

    if merge_mode:
        from pegasus.runner import MergeExecutor  # noqa: PLC0415

        merge_executor = MergeExecutor(
            db_path=db_path,
            agent_runner=agent_runner,
            project_dir=project_dir,
        )
        asyncio.run(merge_executor.merge_task(task_id))
    elif resume_mode:
        asyncio.run(executor.resume_task(task_id))
    else:
        # Read task data from SQLite (ui.py already inserted the row)
        from pegasus.models import make_connection  # noqa: PLC0415

        conn = make_connection(db_path, read_only=True)
        row = conn.execute(
            "SELECT pipeline, description FROM tasks WHERE id = ?", (task_id,)
        ).fetchone()
        conn.close()

        if row is None:
            print(f"Task {task_id} not found in database", file=sys.stderr)
            sys.exit(1)

        asyncio.run(executor.run_task(task_id, row["pipeline"], row["description"] or ""))


if __name__ == "__main__":
    main()
