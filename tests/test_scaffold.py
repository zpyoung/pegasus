"""Smoke tests for the project scaffold (01-scaffold)."""

from __future__ import annotations


def test_package_importable() -> None:
    """The pegasus package can be imported."""
    import pegasus  # noqa: PLC0415

    assert pegasus.__version__ == "0.1.0"


def test_version_string_format() -> None:
    """Version string follows semantic versioning."""
    import pegasus  # noqa: PLC0415

    parts = pegasus.__version__.split(".")
    assert len(parts) == 3, "Expected MAJOR.MINOR.PATCH"
    assert all(p.isdigit() for p in parts), "All version parts must be numeric"


def test_main_module_exists() -> None:
    """__main__.py exists and is importable as a module."""
    import importlib

    spec = importlib.util.find_spec("pegasus.__main__")
    assert spec is not None, "pegasus.__main__ module not found"


def test_main_entrypoint_callable() -> None:
    """main() is a callable in __main__."""
    from pegasus.__main__ import main  # noqa: PLC0415

    assert callable(main)
