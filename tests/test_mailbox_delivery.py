import json
import os
import tempfile
import unittest

from nymrel_swarm_protocol.bus import EnvelopeEngine, FileMailboxManager


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
        self.assertEqual(
            [receipt.recipient for receipt in receipts],
            ["fable", "gemini"],
        )
        self.assertTrue(
            all(receipt.current_state == "delivered" for receipt in receipts)
        )

        self.mailbox.receive_messages("fable")
        self.assertEqual(
            self.mailbox.get_delivery_receipt(
                envelope.header.id,
                "fable",
            ).current_state,
            "observed",
        )
        self.assertEqual(
            self.mailbox.get_delivery_receipt(
                envelope.header.id,
                "gemini",
            ).current_state,
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
            self.mailbox.get_delivery_receipt(
                envelope.header.id,
                "fable",
            ).current_state,
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
        self.assertEqual(
            sum(1 for transition in receipt.transitions if transition.to == "observed"),
            1,
        )


if __name__ == "__main__":
    unittest.main()
