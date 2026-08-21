"""
Unit tests for AtomicLockManager and FencingClock (Python)
"""

import os
import shutil
import tempfile
import unittest
from nymrel_swarm_protocol.fencing import AtomicLockManager, FencingClock


class TestFencing(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp(prefix="swarm-fencing-py-")

    def tearDown(self):
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def test_acquires_and_releases_atomic_lock(self):
        lock_mgr = AtomicLockManager(self.tmp_dir)
        handle = lock_mgr.acquire_lock("test_lock", timeout_ms=1000)
        self.assertIsNotNone(handle)
        self.assertEqual(handle["lock_name"], "test_lock")
        self.assertTrue(os.path.exists(handle["lock_path"]))

        lock_mgr.release_lock(handle)
        self.assertFalse(os.path.exists(handle["lock_path"]))

    def test_with_lock_executes_and_releases(self):
        lock_mgr = AtomicLockManager(self.tmp_dir)
        executed = []

        def _work():
            executed.append(True)

        lock_mgr.with_lock("scoped_lock", _work)
        self.assertEqual(executed, [True])

        # Must be able to re-acquire cleanly
        handle = lock_mgr.acquire_lock("scoped_lock", timeout_ms=500)
        lock_mgr.release_lock(handle)

    def test_increments_fencing_generation_monotonically(self):
        clock = FencingClock(self.tmp_dir)

        token1 = clock.increment_generation("repo/backend", "agent-alpha")
        self.assertEqual(token1.generation, 1)
        self.assertEqual(token1.claimant, "agent-alpha")
        self.assertTrue(token1.token.startswith("fenc_gen1_"))

        token2 = clock.increment_generation("repo/backend", "agent-beta")
        self.assertEqual(token2.generation, 2)
        self.assertEqual(token2.claimant, "agent-beta")
        self.assertTrue(token2.token.startswith("fenc_gen2_"))

        # Validation
        self.assertTrue(clock.validate_generation("repo/backend", token2))
        self.assertFalse(clock.validate_generation("repo/backend", token1))


if __name__ == "__main__":
    unittest.main()
