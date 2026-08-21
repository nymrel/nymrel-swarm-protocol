"""
Unit tests for TwoSeatProtocol (Python)
"""

import os
import shutil
import tempfile
import unittest
from nymrel_swarm_protocol.two_seat import TwoSeatProtocol, HandoverPacket


class TestTwoSeat(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp(prefix="swarm-twoseat-py-")

    def tearDown(self):
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def test_initializes_mission_with_distinct_seats(self):
        proto = TwoSeatProtocol(self.tmp_dir)

        mission = proto.init_mission(
            mission_id="mission-001",
            mission_owner_seat_id="codex-sol",
            studio_controller_seat_id="claude-opus",
            initial_checkpoint="Bootstrap project architecture",
        )

        self.assertEqual(mission.mission_id, "mission-001")
        self.assertEqual(mission.mission_owner_seat_id, "codex-sol")
        self.assertEqual(mission.studio_controller_seat_id, "claude-opus")
        self.assertEqual(mission.state, "ACTIVE")
        self.assertEqual(mission.current_generation, 1)

    def test_validates_action_owner_allowed_controller_restricted(self):
        proto = TwoSeatProtocol(self.tmp_dir)

        mission = proto.init_mission(
            mission_id="mission-002",
            mission_owner_seat_id="codex-sol",
            studio_controller_seat_id="claude-opus",
        )

        # Owner write is allowed
        owner_check = proto.validate_action(
            mission_id="mission-002",
            agent_id="codex-sol",
            write_scope="src/backend",
            presented_token=mission.fencing_token,
        )
        self.assertTrue(owner_check.allowed)
        self.assertEqual(owner_check.role, "mission_owner")

        # Controller read-only observation allowed
        ctrl_read = proto.validate_action(
            mission_id="mission-002",
            agent_id="claude-opus",
        )
        self.assertTrue(ctrl_read.allowed)
        self.assertEqual(ctrl_read.role, "studio_controller")

        # Controller write attempt must be prohibited (safety invariant)
        ctrl_write = proto.validate_action(
            mission_id="mission-002",
            agent_id="claude-opus",
            write_scope="src/backend",
        )
        self.assertFalse(ctrl_write.allowed)
        self.assertIn("Invariant violation: studio_controller", ctrl_write.reason)

    def test_executes_planned_handover_and_fences_stale_writer(self):
        proto = TwoSeatProtocol(self.tmp_dir)

        initial = proto.init_mission(
            mission_id="mission-003",
            mission_owner_seat_id="codex-sol",
            studio_controller_seat_id="claude-opus",
        )
        old_token = initial.fencing_token

        handover = proto.request_handover(
            mission_id="mission-003",
            packet=HandoverPacket(
                from_agent="codex-sol",
                to_agent="claude-opus",
                checkpoint="Backend finished",
                open_claims=[],
                child_tasks=[],
                validation_state={"tests": 10},
                next_move="Start React frontend",
                reason="Transitioning to UI",
            ),
        )

        self.assertTrue(handover.success)
        self.assertEqual(handover.new_owner, "claude-opus")
        self.assertEqual(handover.fencing_token["generation"], 2)

        # Prior owner presenting generation 1 is now rejected
        stale_check = proto.validate_action(
            mission_id="mission-003",
            agent_id="codex-sol",
            write_scope="src/backend",
            presented_token=old_token,
        )
        self.assertFalse(stale_check.allowed)
        self.assertIn("Stale fencing generation", stale_check.reason)

    def test_executes_unplanned_recovery_by_controller(self):
        proto = TwoSeatProtocol(self.tmp_dir)

        proto.init_mission(
            mission_id="mission-004",
            mission_owner_seat_id="codex-sol",
            studio_controller_seat_id="claude-opus",
        )

        recovery = proto.execute_unplanned_recovery(
            mission_id="mission-004",
            controller_id="claude-opus",
            reason="Owner silent past lease expiration",
        )

        self.assertTrue(recovery.success)
        self.assertEqual(recovery.new_owner, "claude-opus")
        self.assertEqual(recovery.fencing_token["generation"], 2)

    def test_closes_mission_cleanly(self):
        proto = TwoSeatProtocol(self.tmp_dir)

        proto.init_mission(
            mission_id="mission-005",
            mission_owner_seat_id="codex-sol",
            studio_controller_seat_id="claude-opus",
        )

        closed = proto.close_mission(
            mission_id="mission-005",
            owner_id="codex-sol",
            closeout_data={"status": "complete"},
        )
        self.assertEqual(closed.state, "TERMINATED")


if __name__ == "__main__":
    unittest.main()
