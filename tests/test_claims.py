"""
Unit tests for ClaimManager (Python)
"""

import os
import time
import shutil
import tempfile
import unittest
from nymrel_swarm_protocol.claims import ClaimManager


class TestClaims(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp(prefix="swarm-claims-py-")

    def tearDown(self):
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def test_normalizes_paths_across_platforms(self):
        self.assertEqual(ClaimManager.normalize_resource_path("src\\backend\\api/"), "src/backend/api")
        self.assertEqual(ClaimManager.normalize_resource_path("SRC/BACKEND/API"), "src/backend/api")

    def test_detects_path_hierarchy_conflicts(self):
        # Exclusive conflicts
        self.assertTrue(ClaimManager.check_conflict("src", "exclusive", "src/bus", "exclusive"))
        self.assertTrue(ClaimManager.check_conflict("src/bus", "exclusive", "src", "exclusive"))
        self.assertTrue(ClaimManager.check_conflict("src", "exclusive", "src/bus", "shared"))
        self.assertTrue(ClaimManager.check_conflict("src", "shared", "src/bus", "exclusive"))

        # Shared with shared is allowed
        self.assertFalse(ClaimManager.check_conflict("src", "shared", "src/bus", "shared"))
        self.assertFalse(ClaimManager.check_conflict("src", "shared", "src", "shared"))

        # Disjoint
        self.assertFalse(ClaimManager.check_conflict("src/backend", "exclusive", "src/frontend", "exclusive"))

    def test_acquires_exclusive_claim_and_blocks_conflicting(self):
        claims = ClaimManager(self.tmp_dir)

        claim1 = claims.acquire_claim(
            resource_path="src/core",
            owner_agent="codex-sol",
            mode="exclusive",
            lease_duration_ms=10000,
        )

        self.assertEqual(claim1.owner_agent, "codex-sol")
        self.assertEqual(claim1.status, "active")
        self.assertEqual(claim1.fencing_generation, 1)

        with self.assertRaises(ValueError):
            claims.acquire_claim(
                resource_path="src/core/utils",
                owner_agent="claude-opus",
                mode="exclusive",
            )

    def test_refreshes_lease_via_heartbeat(self):
        claims = ClaimManager(self.tmp_dir)

        claim = claims.acquire_claim(
            resource_path="src/api",
            owner_agent="codex-sol",
            lease_duration_ms=2000,
        )

        old_expires = claim.expires_at
        time.sleep(0.05)

        refreshed = claims.heartbeat(claim.claim_id, "codex-sol")
        self.assertGreater(refreshed.expires_at, old_expires)

    def test_releases_claim_cleanly(self):
        claims = ClaimManager(self.tmp_dir)

        claim = claims.acquire_claim(
            resource_path="src/db",
            owner_agent="codex-sol",
        )

        released = claims.release_claim(claim.claim_id, "codex-sol")
        self.assertTrue(released)

        updated = claims.get_claim(claim.claim_id)
        self.assertEqual(updated.status, "released")

        # Now claude-opus can acquire
        claim2 = claims.acquire_claim(
            resource_path="src/db",
            owner_agent="claude-opus",
        )
        self.assertEqual(claim2.owner_agent, "claude-opus")

    def test_auto_arbiter_reaps_expired_leases(self):
        claims = ClaimManager(self.tmp_dir)

        claim = claims.acquire_claim(
            resource_path="src/temp",
            owner_agent="agent-fast",
            lease_duration_ms=10,
        )

        time.sleep(0.05)

        reaped = claims.reap_expired_leases()
        self.assertEqual(len(reaped), 1)
        self.assertEqual(reaped[0].claim_id, claim.claim_id)
        self.assertEqual(reaped[0].status, "expired")


if __name__ == "__main__":
    unittest.main()
