"""Integration test configuration.

The server-reachability check lives here (not in test_client.py) so it runs
once per pytest session rather than at import time during collection.  When
running only unit tests (``pytest tests/unit/``), this file is never imported.
"""
from __future__ import annotations

import os

import httpx
import pytest

_SERVER_URL = os.environ.get("AEP_INGEST_URL", "http://localhost:8787")
_SKIP_REASON = (
    f"AEP server not reachable at {_SERVER_URL} — start with 'npm run ingest'"
)


def _server_reachable() -> bool:
    try:
        resp = httpx.get(f"{_SERVER_URL}/health", timeout=2.0)
        return resp.status_code == 200
    except Exception:
        return False


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """Skip all integration tests when the AEP server is unreachable.

    Called once after collection — a single HTTP probe guards the whole suite.
    """
    if not _server_reachable():
        skip = pytest.mark.skip(reason=_SKIP_REASON)
        for item in items:
            if "integration" in str(item.fspath):
                item.add_marker(skip)
