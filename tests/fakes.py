"""Test fakes for Pegasus runner tests.

Provides ``FakeAgentRunner`` — a drop-in ``AgentRunnerProtocol``-compatible
test double that yields pre-configured messages without spawning any subprocess
or making any API calls.
"""

from __future__ import annotations

from typing import AsyncIterator

from pegasus.runner import (
    AgentMessage,
    ErrorMessage,
    Message,
    ResultMessage,
    ToolUseMessage,
)


class FakeAgentRunner:
    """Test fake for ``AgentRunnerProtocol``.

    Configure it with a sequence of ``Message`` objects; ``run_task`` yields
    them in order.  If *raise_on_run* is set, ``run_task`` raises that
    exception instead of yielding messages (useful for testing exception
    handling in ``PegasusEngine``).

    Args:
        messages:     Sequence of messages to yield (default: one
                      ``ResultMessage`` with cost 0.05).
        raise_on_run: If not ``None``, raise this exception when
                      ``run_task`` is called.
    """

    def __init__(
        self,
        messages: list[Message] | None = None,
        *,
        raise_on_run: Exception | None = None,
    ) -> None:
        if messages is None:
            messages = [
                ResultMessage(
                    output="done",
                    total_cost_usd=0.05,
                    session_id="fake-session-1",
                )
            ]
        self._messages = messages
        self._raise_on_run = raise_on_run
        self.interrupt_called: bool = False
        self.run_calls: list[tuple[str, str]] = []  # (prompt, cwd) pairs

    async def run_task(
        self,
        prompt: str,
        cwd: str,
    ) -> AsyncIterator[Message]:
        self.run_calls.append((prompt, cwd))
        if self._raise_on_run is not None:
            raise self._raise_on_run

        messages = list(self._messages)

        async def _gen() -> AsyncIterator[Message]:
            for msg in messages:
                yield msg

        return _gen()

    async def interrupt(self) -> None:
        self.interrupt_called = True


def make_fake_runner_with_tool_use(
    tool_name: str = "Write",
    result_cost: float = 0.10,
) -> FakeAgentRunner:
    """Return a ``FakeAgentRunner`` that emits an agent message, a tool use, then a result."""
    return FakeAgentRunner(
        messages=[
            AgentMessage(content="I will write a file.", cost=0.02),
            ToolUseMessage(
                tool_name=tool_name,
                tool_input={"path": "/tmp/out.txt", "content": "hello"},
                cost=0.0,
            ),
            ResultMessage(
                output="File written successfully.",
                total_cost_usd=result_cost,
                session_id="fake-session-tool",
            ),
        ]
    )


def make_fake_runner_with_error(error_msg: str = "API rate limit exceeded") -> FakeAgentRunner:
    """Return a ``FakeAgentRunner`` that emits an ``ErrorMessage``."""
    return FakeAgentRunner(
        messages=[
            ErrorMessage(error=error_msg, cost=0.0),
        ]
    )
