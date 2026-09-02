import json
import os
import tempfile
import unittest

from nymrel_swarm_protocol.delivery import DeliveryLedger


class DeliveryLedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.ledger = DeliveryLedger(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_records_forward_only_lifecycle_with_valid_hash_chain(self):
        self.ledger.create(message_id="msg-1", recipient="fable", actor="sol")
        for state in ("accepted", "routed", "delivered", "observed", "acted", "verified"):
            self.ledger.transition(
                message_id="msg-1",
                recipient="fable",
                to=state,
                actor="fable" if state == "observed" else "studio",
                evidence={
                    "kind": "verification" if state == "verified" else "reconciliation",
                    "reference": f"receipt://{state}",
                },
            )

        receipt = self.ledger.get("msg-1", "fable")
        self.assertIsNotNone(receipt)
        self.assertEqual(receipt.current_state, "verified")
        self.assertEqual(len(receipt.transitions), 7)
        self.assertTrue(DeliveryLedger.verify_receipt(receipt))

    def test_same_state_retry_is_idempotent(self):
        self.ledger.create(message_id="msg-2", recipient="gemini", actor="sol")
        first = self.ledger.transition(
            message_id="msg-2",
            recipient="gemini",
            to="accepted",
            actor="sol",
        )
        retry = self.ledger.transition(
            message_id="msg-2",
            recipient="gemini",
            to="accepted",
            actor="sol",
        )
        self.assertEqual(len(first.transitions), 2)
        self.assertEqual(len(retry.transitions), 2)
        self.assertEqual(first.chain_hash, retry.chain_hash)

    def test_rejects_backward_and_post_terminal_transitions(self):
        self.ledger.create(message_id="msg-3", recipient="grok", actor="sol")
        self.ledger.transition(
            message_id="msg-3",
            recipient="grok",
            to="accepted",
            actor="sol",
        )
        self.ledger.transition(
            message_id="msg-3",
            recipient="grok",
            to="rejected",
            actor="router",
        )
        with self.assertRaisesRegex(ValueError, "Invalid delivery transition rejected -> routed"):
            self.ledger.transition(
                message_id="msg-3",
                recipient="grok",
                to="routed",
                actor="router",
            )

    def test_reconciles_delivery_unknown_explicitly(self):
        self.ledger.create(message_id="msg-4", recipient="hermes", actor="sol")
        self.ledger.transition(
            message_id="msg-4",
            recipient="hermes",
            to="accepted",
            actor="sol",
        )
        self.ledger.transition(
            message_id="msg-4",
            recipient="hermes",
            to="delivery_unknown",
            actor="transport",
        )
        receipt = self.ledger.transition(
            message_id="msg-4",
            recipient="hermes",
            to="delivered",
            actor="reconciler",
            evidence={
                "kind": "reconciliation",
                "reference": "receipt://recipient-side-proof",
            },
        )
        self.assertEqual(receipt.current_state, "delivered")

    def test_rejects_open_ended_evidence_payload(self):
        with self.assertRaisesRegex(ValueError, 'evidence field "secret" is not allowed'):
            self.ledger.create(
                message_id="msg-5",
                recipient="fable",
                actor="sol",
                evidence={
                    "kind": "receipt_created",
                    "reference": "receipt://created",
                    "secret": "not-allowed",
                },
            )

    def test_detects_persisted_tampering(self):
        self.ledger.create(message_id="msg-6", recipient="fable", actor="sol")
        delivery_root = os.path.join(self.temp_dir.name, "deliveries")
        message_dir = os.path.join(delivery_root, os.listdir(delivery_root)[0])
        receipt_path = os.path.join(message_dir, os.listdir(message_dir)[0])
        with open(receipt_path, "r", encoding="utf-8") as handle:
            stored = json.load(handle)
        stored["transitions"][0]["actor"] = "attacker"
        with open(receipt_path, "w", encoding="utf-8") as handle:
            json.dump(stored, handle, indent=2)

        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            self.ledger.get("msg-6", "fable")

    def test_matches_cross_language_delivery_hash_vector(self):
        self.ledger.create(
            message_id="msg-parity",
            recipient="fable",
            actor="sol",
            at="2026-09-02T12:00:00.000Z",
            evidence={
                "kind": "receipt_created",
                "reference": "receipt://created",
            },
        )
        receipt = self.ledger.transition(
            message_id="msg-parity",
            recipient="fable",
            to="accepted",
            actor="sol",
            at="2026-09-02T12:00:01.000Z",
            evidence={
                "kind": "outbox_persisted",
                "reference": "file://outbox/msg-parity",
                "sha256": "a" * 64,
            },
        )
        self.assertEqual(
            receipt.chain_hash,
            "afb4e0debaeca540d983b4e5e4b9f7ae11608a4509cbdb1e01baa369d66de140",
        )


if __name__ == "__main__":
    unittest.main()
