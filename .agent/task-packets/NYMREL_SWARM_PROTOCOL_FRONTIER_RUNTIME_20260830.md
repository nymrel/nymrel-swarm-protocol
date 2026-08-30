# Nymrel Swarm Protocol frontier runtime and provenance pass

Date: 2026-08-30
Owner: Codex
Claim: `codex-swarm-protocol-frontier-runtime-20260830`
Goal: `01a04d87-73f3-73e0-bd2f-8c89ee2b1023`
Pull request: `nymrel/nymrel-swarm-protocol#1`
Canonical base: `25c83e961964e6a58210df71069e74ed08a1a1aa`
Starting candidate: `3f2b4b9975ef8eab6d331f9af0eb5a7da941982d`

## Why now

The accepted release-hardening candidate still treats end-of-life Node 18/20 and Python 3.9 as supported, uses TypeScript 5, allows setup-node to probe npm before the reviewed package manager is active, and promotes release artifacts without a GitHub build attestation. Those are control-plane and supply-chain gaps for a new, unpublished coordination protocol.

## Bounded scope

- Require maintained Node 22–26 and Python 3.11–3.14 runtimes.
- Move the TypeScript build to the current compiler with modern Node module resolution.
- Pin the Python build backend and remove the redundant wheel build dependency.
- Disable premature npm cache probing and bootstrap exact npm outside the repository contract without lifecycle scripts.
- Add executable workflow/runtime/package contracts and a pinned workflow self-audit.
- Attest the exact immutable npm/Python artifact bundle before either trusted-publishing job.
- Preserve all TypeScript/Python protocol behavior, source distribution shape, public APIs, and registry/account gates.

## Acceptance

- Clean exact-toolchain Node install, build, complete tests, release-contract tests, audits, and packed-consumer smoke pass.
- Python source tests, Bandit, pip-audit, wheel/sdist validation, clean install, and CLI smoke pass on an available supported interpreter.
- Generated `dist/` is reproducible and clean.
- actionlint and Zizmor report no workflow findings.
- An independent reviewer accepts the exact commit/tree before push.
- The existing PR remains draft until hosted matrix/CodeQL-equivalent evidence and registry Trusted Publisher bindings exist.
- No merge, tag, release, registry publication, provider/account mutation, deployment, customer, or revenue outcome is claimed.
