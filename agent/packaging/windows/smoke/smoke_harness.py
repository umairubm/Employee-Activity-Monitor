"""Backward-compatible import surface for the split native smoke harness."""

from __future__ import annotations

try:
    from .fixture import FixtureState, SyncFixture, TEST_NAME, TEST_TOKEN
    from .desktop import (
        compare_identity_and_settings,
        meaningful_config,
        sanitize_error,
        sha256_file,
        wait_for,
    )
    from .harness import main, run_smoke
except ImportError:  # direct ``python smoke/run.py`` / PYTHONPATH invocation
    from fixture import FixtureState, SyncFixture, TEST_NAME, TEST_TOKEN
    from desktop import compare_identity_and_settings, meaningful_config, sanitize_error, sha256_file, wait_for
    from harness import main, run_smoke

__all__ = [
    "FixtureState", "SyncFixture", "TEST_NAME", "TEST_TOKEN",
    "compare_identity_and_settings", "meaningful_config", "sanitize_error",
    "sha256_file", "wait_for", "main", "run_smoke",
]
