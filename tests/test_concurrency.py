"""
Concurrency and collision detection tests (Python)
"""

import os
import shutil
import tempfile
import unittest
import threading
from concurrent.futures import ThreadPoolExecutor
from nymrel_swarm_protocol.claims import ClaimManager
from nymrel_swarm_protocol.fencing import FencingClock


class TestConcurrency(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp(prefix="swarm-concurrency-py-")

    def tearDown(self):
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def test_single_winner_claim_race(self):
        claims = ClaimManager(self.tmp_dir)
        agents = [f"agent-{i}" for i in range(5)]

        successful = []
        errors = []

        def _try_claim(agent):
            try:
                rec = claims.acquire_claim(
                    resource_path="src/critical-resource",
                    owner_agent=agent,
                    mode="exclusive",
                )
                successful.append(rec)
            except Exception as e:
                errors.append(e)

        with ThreadPoolExecutor(max_workers=5) as executor:
            futures = [executor.submit(_try_claim, a) for a in agents]
            for f in futures:
                f.result()

        self.assertEqual(len(successful), 1, "Exactly one agent must win the race")
        self.assertEqual(len(errors), 4, "Remaining 4 agents must be rejected with conflict")

    def test_monotonic_fencing_increments_under_contention(self):
        clock = FencingClock(self.tmp_dir)
        n = 20

        def _inc(i):
            return clock.increment_generation("mission-concurrency", f"worker-{i}")

        with ThreadPoolExecutor(max_workers=5) as executor:
            tokens = list(executor.map(_inc, range(n)))

        generations = [t.generation for t in tokens]
        self.assertEqual(len(generations), n)

        gen_set = set(generations)
        self.assertEqual(len(gen_set), n, "All generations must be unique")

        for i in range(1, n + 1):
            self.assertIn(i, gen_set)

        latest = clock.get_latest_token("mission-concurrency")
        self.assertEqual(latest.current_generation, n)


if __name__ == "__main__":
    unittest.main()
