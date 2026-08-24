#!/usr/bin/env python3
"""Fail closed when package metadata or a release tag disagrees.

This script reads metadata without importing or executing either distribution.
It is intentionally dependency-free and runs in the release workflow on
Python 3.11+.
"""

from __future__ import annotations

import ast
import json
import os
import sys
import tomllib
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_REPOSITORY = "https://github.com/nymrel/nymrel-swarm-protocol"
EXPECTED_ISSUES = f"{EXPECTED_REPOSITORY}/issues"


def _setup_literals(path: Path) -> dict[str, Any]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if not (
            isinstance(node.func, ast.Name)
            and node.func.id == "setup"
            or isinstance(node.func, ast.Attribute)
            and node.func.attr == "setup"
        ):
            continue

        values: dict[str, Any] = {}
        for keyword in node.keywords:
            if keyword.arg not in {"name", "version", "url"}:
                continue
            try:
                values[keyword.arg] = ast.literal_eval(keyword.value)
            except (ValueError, TypeError, SyntaxError):
                pass
        return values
    raise ValueError("setup.py does not contain a setup(...) call")


def _normalize_repository(value: str) -> str:
    normalized = value.strip().removeprefix("git+").rstrip("/")
    if normalized.endswith(".git"):
        normalized = normalized[:-4]
    return normalized


def main() -> int:
    errors: list[str] = []

    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    setup = _setup_literals(ROOT / "setup.py")

    package_project = pyproject.get("project", {})
    package_urls = package_project.get("urls", {})

    names = {
        "package.json": package.get("name"),
        "pyproject.toml": package_project.get("name"),
        "setup.py": setup.get("name"),
    }
    expected_names = {
        "package.json": "@nymrel/swarm-protocol",
        "pyproject.toml": "nymrel-swarm-protocol",
        "setup.py": "nymrel-swarm-protocol",
    }
    for source, expected in expected_names.items():
        if names[source] != expected:
            errors.append(f"{source} package name is {names[source]!r}; expected {expected!r}")

    versions = {
        "package.json": package.get("version"),
        "pyproject.toml": package_project.get("version"),
        "setup.py": setup.get("version"),
    }
    if None in versions.values() or len(set(versions.values())) != 1:
        rendered = ", ".join(f"{source}={value!r}" for source, value in versions.items())
        errors.append(f"distribution versions disagree: {rendered}")

    repository_values = {
        "package.json": package.get("repository", {}).get("url", ""),
        "pyproject.toml": package_urls.get("Repository", ""),
        "setup.py": setup.get("url", ""),
    }
    for source, value in repository_values.items():
        if not isinstance(value, str) or _normalize_repository(value) != EXPECTED_REPOSITORY:
            errors.append(
                f"{source} repository is {value!r}; expected {EXPECTED_REPOSITORY!r}"
            )

    issue_values = {
        "package.json": package.get("bugs", {}).get("url"),
        "pyproject.toml": package_urls.get("Issues"),
    }
    for source, value in issue_values.items():
        if value != EXPECTED_ISSUES:
            errors.append(f"{source} issues URL is {value!r}; expected {EXPECTED_ISSUES!r}")

    version = next(iter(set(versions.values()))) if len(set(versions.values())) == 1 else None
    ref_type = os.environ.get("GITHUB_REF_TYPE", "")
    ref_name = os.environ.get("GITHUB_REF_NAME", "")
    ref = os.environ.get("GITHUB_REF", "")
    tag = ref_name if ref_type == "tag" else ref.removeprefix("refs/tags/") if ref.startswith("refs/tags/") else ""
    if tag and version is not None and tag != f"v{version}":
        errors.append(f"release tag {tag!r} does not match package version v{version}")

    if errors:
        for error in errors:
            print(f"release-contract error: {error}", file=sys.stderr)
        return 1

    print(
        "release contract passed: "
        f"npm={names['package.json']} python={names['pyproject.toml']} version={version}"
        + (f" tag={tag}" if tag else "")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
