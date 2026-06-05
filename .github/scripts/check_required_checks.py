#!/usr/bin/env python3
"""Drift-guard for required status checks.

Keeps three lists in agreement so branch protection never references a stale or
missing CI job:

  1. The check contexts produced by .github/workflows/ci.yml (derived from each
     job's `name:` + matrix expansion).
  2. The list documented in CONTRIBUTING.md (between the
     `required-checks:start/end` markers).
  3. (optional) The live branch-protection required checks on `main`, when a
     repo-admin token is provided via CHECKS_SYNC_TOKEN.

(1) vs (2) always runs and needs no credentials — it is the primary guard and
works on fork PRs. (3) only runs when CHECKS_SYNC_TOKEN is set, because the
GitHub API for branch protection requires repo-admin scope, which the default
Actions GITHUB_TOKEN does not have.

Exit non-zero on any mismatch.
"""
from __future__ import annotations

import itertools
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
CI_YML = ROOT / ".github" / "workflows" / "ci.yml"
CONTRIBUTING = ROOT / "CONTRIBUTING.md"


def fail(msg: str) -> None:
    print(f"::error::{msg}")


def workflow_contexts() -> set[str]:
    """Derive the set of status-check contexts ci.yml will report.

    A job's context is its `name:` (falling back to the job id). Matrix jobs
    expand to one context per combination, suffixed ` (v1, v2, ...)` in the
    order the matrix keys are declared — matching GitHub's own naming.
    """
    import yaml  # PyYAML; installed in the CI step

    data = yaml.safe_load(CI_YML.read_text())
    contexts: set[str] = set()
    for job_id, job in (data.get("jobs") or {}).items():
        base = job.get("name", job_id)
        matrix = ((job.get("strategy") or {}).get("matrix")) or {}
        list_keys = [
            k for k, v in matrix.items()
            if isinstance(v, list) and k not in ("include", "exclude")
        ]
        if "include" in matrix or "exclude" in matrix:
            print(
                f"::warning::job '{job_id}' uses matrix include/exclude; "
                "context derivation only expands the plain matrix axes"
            )
        if list_keys:
            for combo in itertools.product(*(matrix[k] for k in list_keys)):
                suffix = ", ".join(str(v) for v in combo)
                contexts.add(f"{base} ({suffix})")
        else:
            contexts.add(base)
    return contexts


def documented_contexts() -> set[str]:
    """Parse the backtick-quoted check names between the CONTRIBUTING markers."""
    text = CONTRIBUTING.read_text()
    m = re.search(
        r"<!--\s*required-checks:start\s*-->(.*?)<!--\s*required-checks:end\s*-->",
        text,
        re.S,
    )
    if not m:
        fail(
            "CONTRIBUTING.md is missing the "
            "`<!-- required-checks:start -->` / `:end` markers"
        )
        sys.exit(1)
    return set(re.findall(r"`([^`]+)`", m.group(1)))


def protection_contexts(token: str, repo: str) -> set[str] | None:
    """Live branch-protection required checks, or None if unreadable."""
    url = (
        f"https://api.github.com/repos/{repo}"
        "/branches/main/protection/required_status_checks/contexts"
    )
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "required-checks-drift-guard",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return set(json.load(resp))
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            print(
                "::warning::CHECKS_SYNC_TOKEN lacks repo-admin scope "
                f"(HTTP {e.code}); skipping the branch-protection comparison"
            )
            return None
        if e.code == 404:
            print(
                "::warning::no branch protection found on `main` (HTTP 404); "
                "skipping the branch-protection comparison"
            )
            return None
        raise


def report(label: str, expected: set[str], actual: set[str]) -> bool:
    """Print a diff; return True if they match."""
    missing = expected - actual  # in CI, absent from `actual`
    extra = actual - expected    # in `actual`, not a real CI job
    if not missing and not extra:
        print(f"✓ {label} is in sync ({len(expected)} checks)")
        return True
    fail(f"{label} is out of sync with the CI workflow")
    for c in sorted(missing):
        print(f"    missing (CI job not listed): {c!r}")
    for c in sorted(extra):
        print(f"    stale  (listed but no such CI job): {c!r}")
    return False


def main() -> int:
    expected = workflow_contexts()
    print("CI workflow produces these check contexts:")
    for c in sorted(expected):
        print(f"  - {c}")
    print()

    ok = report("CONTRIBUTING.md", expected, documented_contexts())

    token = os.environ.get("CHECKS_SYNC_TOKEN", "").strip()
    if token:
        repo = os.environ.get("GITHUB_REPOSITORY", "surpradhan/agent-event-protocol")
        live = protection_contexts(token, repo)
        if live is not None:
            ok = report("branch protection", expected, live) and ok
    else:
        print(
            "ℹ CHECKS_SYNC_TOKEN not set — skipping the live branch-protection "
            "comparison (set a repo-admin PAT secret to enable it)."
        )

    if not ok:
        print(
            "\nFix: update the CI workflow, the CONTRIBUTING.md "
            "`required-checks` block, and/or the branch-protection required "
            "checks so all three list the same contexts."
        )
        return 1
    print("\nAll required-check lists agree. ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
