import hashlib
import json
import os
import tempfile
import unittest

from nymrel_swarm_protocol.bus import EnvelopeEngine, FileMailboxManager
from nymrel_swarm_protocol.delivery import DeliveryLedger


class MailboxDeliveryTruthTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.mailbox = FileMailboxManager(self.temp_dir.name)
        for agent in ("sol", "fable", "gemini"):
            self.mailbox.register_agent(agent)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_separates_mailbox_persistence_from_observation(self):
        envelope = EnvelopeEngine.create(
            sender="sol",
            recipient="fable",
            topic="review.requested",
            payload={"artifact": "pr://42"},
        )
        self.mailbox.send_message(envelope)
        receipt = self.mailbox.get_delivery_receipt(envelope.header.id, "fable")
        self.assertEqual(receipt.current_state, "delivered")
        self.assertEqual(
            [transition.to for transition in receipt.transitions],
            ["created", "accepted", "routed", "delivered"],
        )

        messages = self.mailbox.receive_messages("fable")
        self.assertEqual(len(messages), 1)
        receipt = self.mailbox.get_delivery_receipt(envelope.header.id, "fable")
        self.assertEqual(receipt.current_state, "observed")
        self.assertEqual(
            [transition.to for transition in receipt.transitions],
            ["created", "accepted", "routed", "delivered", "observed"],
        )

    def test_broadcast_receipts_are_recipient_specific(self):
        envelope = self.mailbox.broadcast("sol", "studio.notice", {"value": 1})
        receipts = self.mailbox.list_delivery_receipts(envelope.header.id)
        self.assertEqual([receipt.recipient for receipt in receipts], ["fable", "gemini"])
        self.assertTrue(all(receipt.current_state == "delivered" for receipt in receipts))

        self.mailbox.receive_messages("fable")
        self.assertEqual(
            self.mailbox.get_delivery_receipt(envelope.header.id, "fable").current_state,
            "observed",
        )
        self.assertEqual(
            self.mailbox.get_delivery_receipt(envelope.header.id, "gemini").current_state,
            "delivered",
        )

    def test_corruption_does_not_record_observation(self):
        envelope = EnvelopeEngine.create(
            sender="sol",
            recipient="fable",
            topic="test.corruption",
            payload={"safe": True},
        )
        self.mailbox.send_message(envelope)
        file_path = os.path.join(
            self.temp_dir.name,
            "mailboxes",
            "fable",
            "inbox",
            f"{envelope.header.id}.json",
        )
        with open(file_path, "r", encoding="utf-8") as handle:
            stored = json.load(handle)
        stored["payload"]["safe"] = False
        with open(file_path, "w", encoding="utf-8") as handle:
            json.dump(stored, handle, indent=2)

        self.assertEqual(self.mailbox.receive_messages("fable"), [])
        self.assertEqual(
            self.mailbox.get_delivery_receipt(envelope.header.id, "fable").current_state,
            "delivered",
        )

    def test_repeated_read_does_not_duplicate_observed_history(self):
        envelope = EnvelopeEngine.create(
            sender="sol",
            recipient="fable",
            topic="test.retry",
            payload={},
        )
        self.mailbox.send_message(envelope)
        self.mailbox.receive_messages("fable")
        self.mailbox.receive_messages("fable")
        receipt = self.mailbox.get_delivery_receipt(envelope.header.id, "fable")
        self.assertEqual(receipt.current_state, "observed")
        self.assertEqual(sum(1 for transition in receipt.transitions if transition.to == "observed"), 1)

    def test_resending_same_envelope_is_idempotent(self):
        envelope = EnvelopeEngine.create(
            sender="sol",
            recipient="fable",
            topic="test.replay",
            payload={"value": 7},
        )
        self.mailbox.send_message(envelope)
        self.mailbox.send_message(envelope)
        receipt = self.mailbox.get_delivery_receipt(envelope.header.id, "fable")
        self.assertEqual(receipt.current_state, "delivered")
        self.assertEqual(
            sum(1 for transition in receipt.transitions if transition.to == "delivered"),
            1,
        )
        self.assertEqual(len(self.mailbox.read_event_stream()), 1)

    def test_replay_refuses_changed_bytes_without_downgrading_delivery(self):
        envelope = EnvelopeEngine.create(
            sender="sol",
            recipient="fable",
            topic="test.collision",
            payload={"value": 1},
        )
        self.mailbox.send_message(envelope)
        changed = EnvelopeEngine.deserialize(EnvelopeEngine.serialize(envelope))
        changed.payload["value"] = 2
        changed.checksum = EnvelopeEngine.compute_checksum(
            changed.header,
            changed.payload,
        )
        with self.assertRaisesRegex(ValueError, "different (envelope bytes|creation contract)"):
            self.mailbox.send_message(changed)
        self.assertEqual(
            self.mailbox.get_delivery_receipt(
                envelope.header.id,
                "fable",
            ).current_state,
            "delivered",
        )

    def test_interrupted_receipt_cannot_be_rebound_to_different_bytes(self):
        envelope = EnvelopeEngine.create(
            sender="sol",
            recipient="fable",
            topic="test.receipt-only-conflict",
            payload={"value": 1},
        )
        serialized = EnvelopeEngine.serialize(envelope)
        ledger = DeliveryLedger(self.temp_dir.name)
        ledger.create(
            message_id=envelope.header.id,
            recipient="fable",
            actor="sol",
            evidence={
                "kind": "receipt_created",
                "reference": f"envelope://{envelope.header.id}",
                "sha256": hashlib.sha256(serialized.encode("utf-8")).hexdigest(),
            },
        )

        changed = EnvelopeEngine.deserialize(serialized)
        changed.payload["value"] = 2
        changed.checksum = EnvelopeEngine.compute_checksum(
            changed.header,
            changed.payload,
        )
        with self.assertRaisesRegex(ValueError, "different creation contract"):
            self.mailbox.send_message(changed)
        self.assertEqual(
            self.mailbox.get_delivery_receipt(
                envelope.header.id,
                "fable",
            ).current_state,
            "created",
        )

    def test_broadcast_replay_preserves_original_recipient_set(self):
        envelope = self.mailbox.broadcast(
            "sol",
            "test.broadcast-replay",
            {"value": 1},
        )
        self.mailbox.register_agent("grok")
        self.mailbox.send_message(envelope)
        self.assertEqual(
            [
                receipt.recipient
                for receipt in self.mailbox.list_delivery_receipts(
                    envelope.header.id
                )
            ],
            ["fable", "gemini"],
        )
        self.assertEqual(self.mailbox.receive_messages("grok"), [])

    def test_broadcast_with_no_registered_target_fails_before_writes(self):
        with tempfile.TemporaryDirectory() as empty_root:
            isolated = FileMailboxManager(empty_root)
            isolated.register_agent("sol")
            envelope = EnvelopeEngine.create(
                sender="sol",
                recipient="broadcast",
                topic="test.empty-broadcast",
                payload={},
            )
            with self.assertRaisesRegex(
                ValueError,
                "Broadcast requires at least one registered recipient",
            ):
                isolated.send_message(envelope)
            self.assertEqual(isolated.list_delivery_receipts(envelope.header.id), [])
            self.assertFalse(
                os.path.exists(
                    os.path.join(
                        empty_root,
                        "mailboxes",
                        "sol",
                        "outbox",
                        f"{envelope.header.id}.json",
                    )
                )
            )

    def test_missing_recipient_bytes_do_not_downgrade_delivery(self):
        envelope = EnvelopeEngine.create(
            sender="sol",
            recipient="fable",
            topic="test.missing-copy",
            payload={},
        )
        self.mailbox.send_message(envelope)
        os.remove(
            os.path.join(
                self.temp_dir.name,
                "mailboxes",
                "fable",
                "inbox",
                f"{envelope.header.id}.json",
            )
        )
        with self.assertRaisesRegex(
            RuntimeError,
            "Delivery receipt claims persistence, but no recipient copy exists",
        ):
            self.mailbox.send_message(envelope)
        self.assertEqual(
            self.mailbox.get_delivery_receipt(
                envelope.header.id,
                "fable",
            ).current_state,
            "delivered",
        )

    def test_message_id_cannot_be_rebound_to_another_recipient(self):
        envelope = EnvelopeEngine.create(
            sender="sol",
            recipient="fable",
            topic="test.recipient-binding",
            payload={},
        )
        self.mailbox.send_message(envelope)
        changed = EnvelopeEngine.deserialize(EnvelopeEngine.serialize(envelope))
        changed.header.recipient = "gemini"
        changed.checksum = EnvelopeEngine.compute_checksum(
            changed.header,
            changed.payload,
        )
        with self.assertRaisesRegex(
            ValueError,
            "Message id is already bound to a different recipient set",
        ):
            self.mailbox.send_message(changed)
        self.assertEqual(
            self.mailbox.get_delivery_receipt(
                envelope.header.id,
                "fable",
            ).current_state,
            "delivered",
        )
        self.assertIsNone(
            self.mailbox.get_delivery_receipt(
                envelope.header.id,
                "gemini",
            )
        )


if __name__ == "__main__":
    unittest.main()
