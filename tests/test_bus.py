"""
Unit tests for FileMailboxManager (Python)
"""

import os
import shutil
import tempfile
import unittest
from nymrel_swarm_protocol.bus import FileMailboxManager, EnvelopeEngine


class TestBus(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp(prefix="swarm-bus-py-")

    def tearDown(self):
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def test_registers_and_delivers_direct_messages(self):
        mailbox = FileMailboxManager(self.tmp_dir)
        mailbox.register_agent("codex-sol")
        mailbox.register_agent("claude-opus")

        env = EnvelopeEngine.create(
            sender="codex-sol",
            recipient="claude-opus",
            topic="test.direct",
            payload={"hello": "world"},
        )

        msg_id = mailbox.send_message(env)
        self.assertEqual(msg_id, env.header.id)

        received = mailbox.receive_messages("claude-opus")
        self.assertEqual(len(received), 1)
        self.assertEqual(received[0].header.id, env.header.id)
        self.assertEqual(received[0].payload, {"hello": "world"})

    def test_broadcasts_to_all_registered_agents_except_sender(self):
        mailbox = FileMailboxManager(self.tmp_dir)
        mailbox.register_agent("sender-agent")
        mailbox.register_agent("worker-1")
        mailbox.register_agent("worker-2")
        mailbox.register_agent("worker-3")

        mailbox.broadcast("sender-agent", "cluster.sync", {"epoch": 42})

        w1_msgs = mailbox.receive_messages("worker-1")
        w2_msgs = mailbox.receive_messages("worker-2")
        w3_msgs = mailbox.receive_messages("worker-3")
        sender_msgs = mailbox.receive_messages("sender-agent")

        self.assertEqual(len(w1_msgs), 1)
        self.assertEqual(len(w2_msgs), 1)
        self.assertEqual(len(w3_msgs), 1)
        self.assertEqual(len(sender_msgs), 0)

    def test_acknowledges_and_archives_message(self):
        mailbox = FileMailboxManager(self.tmp_dir)
        mailbox.register_agent("receiver")

        env = EnvelopeEngine.create(
            sender="sender",
            recipient="receiver",
            topic="task.one",
            payload={"value": 1},
        )
        mailbox.send_message(env)

        msgs = mailbox.receive_messages("receiver", auto_acknowledge=True)
        self.assertEqual(len(msgs), 1)

        msgs_after = mailbox.receive_messages("receiver")
        self.assertEqual(len(msgs_after), 0)

    def test_records_and_reads_event_stream(self):
        mailbox = FileMailboxManager(self.tmp_dir)
        mailbox.register_agent("agent-a")
        mailbox.register_agent("agent-b")

        env = EnvelopeEngine.create(
            sender="agent-a",
            recipient="agent-b",
            topic="event.check",
            payload={},
        )
        mailbox.send_message(env)

        stream = mailbox.read_event_stream()
        self.assertGreaterEqual(len(stream), 1)
        self.assertEqual(stream[0]["actor"], "agent-a")
        self.assertEqual(stream[0]["event_type"], "message_sent")


if __name__ == "__main__":
    unittest.main()
