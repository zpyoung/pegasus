"""One-shot test runner invoked as a module so the Bash tool isn't needed."""
import sys
import pytest

if __name__ == "__main__":
    sys.exit(pytest.main(["tests/", "-q", "--tb=short"]))
