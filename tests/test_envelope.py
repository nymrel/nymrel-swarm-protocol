"""
Unit tests for EnvelopeEngine v2 (Python)
"""

import unittest
import json
from nymrel_swarm_protocol.bus import EnvelopeEngine, EnvelopeV2


class TestEnvelopeEngine(unittest.TestCase):
    def test_creates_valid_envelope(self):
        env = EnvelopeEngine.create(
            sender="codex-sol",
            recipient="claude-opus",
            topic="task.dispatch",
            payload={"task_id": "task-101", "priority": "high"},
        )

        self.assertEqual(env.header.version, "2.0")
        self.assertEqual(env.header.sender, "codex-sol")
        self.assertEqual(env.header.recipient, "claude-opus")
        self.assertEqual(env.header.topic, "task.dispatch")
        self.assertTrue(env.header.id)
        self.assertTrue(env.header.timestamp)
        self.assertTrue(env.checksum)
        self.assertTrue(EnvelopeEngine.verify(env))

    def test_detects_tampered_payload(self):
        env = EnvelopeEngine.create(
            sender="codex-sol",
            recipient="claude-opus",
            topic="task.dispatch",
            payload={"amount": 100},
        )

        self.assertTrue(EnvelopeEngine.verify(env))

        # Tamper payload
        tampered_dict = env.to_dict()
        tampered_dict["payload"] = {"amount": 999999}
        self.assertFalse(EnvelopeEngine.verify(tampered_dict))

    def test_serializes_and_deserializes_correctly(self):
        env = EnvelopeEngine.create(
            sender="cursor-grok",
            recipient="all",
            topic="heartbeat",
            payload={"status": "healthy", "load": 0.12},
        )

        serialized = EnvelopeEngine.serialize(env)
        deserialized = EnvelopeEngine.deserialize(serialized)

        self.assertEqual(deserialized.header.id, env.header.id)
        self.assertEqual(deserialized.header.sender, env.header.sender)
        self.assertEqual(deserialized.header.recipient, env.header.recipient)
        self.assertEqual(deserialized.payload, env.payload)
        self.assertEqual(deserialized.checksum, env.checksum)

    def test_rejects_corrupted_json(self):
        raw = json.dumps({
            "header": {"id": "bad", "version": "1.0"},
            "payload": {},
            "checksum": "invalid",
        })
        with self.assertRaises(ValueError):
            EnvelopeEngine.deserialize(raw)


if __name__ == "__main__":
    unittest.main()
