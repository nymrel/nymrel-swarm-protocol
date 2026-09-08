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

    def receipt_path(self):
        delivery_root = os.path.join(self.temp_dir.name, "deliveries")
        message_dir = os.path.join(delivery_root, os.listdir(delivery_root)[0])
        return os.path.join(message_dir, os.listdir(message_dir)[0])

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

    def test_receipt_creation_is_idempotent_only_for_same_contract(self):
        self.ledger.create(
            message_id="msg-create-contract",
            recipient="fable",
            actor="sol",
            evidence={
                "kind": "receipt_created",
                "reference": "envelope://msg-create-contract",
                "sha256": "a" * 64,
            },
        )
        self.ledger.create(
            message_id="msg-create-contract",
            recipient="fable",
            actor="sol",
            evidence={
                "kind": "receipt_created",
                "reference": "envelope://msg-create-contract",
                "sha256": "a" * 64,
            },
        )
        with self.assertRaisesRegex(ValueError, "different creation contract"):
            self.ledger.create(
                message_id="msg-create-contract",
                recipient="fable",
                actor="other-sender",
                evidence={
                    "kind": "receipt_created",
                    "reference": "envelope://msg-create-contract",
                    "sha256": "b" * 64,
                },
            )

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

    def test_same_state_retry_rejects_conflicting_metadata(self):
        self.ledger.create(message_id="msg-retry-contract", recipient="gemini", actor="sol")
        self.ledger.transition(
            message_id="msg-retry-contract",
            recipient="gemini",
            to="accepted",
            actor="sol",
            evidence={
                "kind": "outbox_persisted",
                "reference": "file://outbox/msg-retry-contract",
            },
            reason_code="recipient_evidence_reconciled",
        )
        with self.assertRaisesRegex(ValueError, "Conflicting same-state retry"):
            self.ledger.transition(
                message_id="msg-retry-contract",
                recipient="gemini",
                to="accepted",
                actor="other-actor",
                evidence={
                    "kind": "outbox_persisted",
                    "reference": "file://outbox/msg-retry-contract",
                },
                reason_code="recipient_evidence_reconciled",
            )
        with self.assertRaisesRegex(ValueError, "Conflicting same-state retry"):
            self.ledger.transition(
                message_id="msg-retry-contract",
                recipient="gemini",
                to="accepted",
                actor="sol",
                evidence={"kind": "outbox_persisted", "reference": "file://outbox/different"},
                reason_code="recipient_evidence_reconciled",
            )
        self.assertEqual(len(self.ledger.get("msg-retry-contract", "gemini").transitions), 2)

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

    def test_does_not_downgrade_proven_delivery_to_unknown(self):
        self.ledger.create(message_id="msg-known", recipient="fable", actor="sol")
        self.ledger.transition(
            message_id="msg-known", recipient="fable", to="accepted", actor="sol"
        )
        self.ledger.transition(
            message_id="msg-known", recipient="fable", to="routed", actor="mesh"
        )
        self.ledger.transition(
            message_id="msg-known", recipient="fable", to="delivered", actor="mesh"
        )
        with self.assertRaisesRegex(
            ValueError,
            "Invalid delivery transition delivered -> delivery_unknown",
        ):
            self.ledger.transition(
                message_id="msg-known",
                recipient="fable",
                to="delivery_unknown",
                actor="mesh",
            )
        self.assertEqual(
            self.ledger.get("msg-known", "fable").current_state,
            "delivered",
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
            reason_code="transport_result_ambiguous",
        )
        receipt = self.ledger.transition(
            message_id="msg-4",
            recipient="hermes",
            to="delivered",
            actor="reconciler",
            reason_code="explicit_reconciliation",
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

    def test_rejects_free_form_transition_reasons(self):
        with self.assertRaisesRegex(ValueError, "reason_code must be one of"):
            self.ledger.create(
                message_id="msg-reason",
                recipient="fable",
                actor="sol",
                reason_code="contains-a-secret",
            )

    def test_missing_reads_do_not_create_receipt_subdirectories(self):
        self.assertIsNone(self.ledger.get("missing-message", "fable"))
        self.assertEqual(
            os.listdir(os.path.join(self.temp_dir.name, "deliveries")),
            [],
        )

    def test_detects_persisted_tampering(self):
        self.ledger.create(message_id="msg-6", recipient="fable", actor="sol")
        stored_path = self.receipt_path()
        with open(stored_path, "r", encoding="utf-8") as handle:
            stored = json.load(handle)
        stored["transitions"][0]["actor"] = "attacker"
        with open(stored_path, "w", encoding="utf-8") as handle:
            json.dump(stored, handle, indent=2)

        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            self.ledger.get("msg-6", "fable")

    def test_rejects_unknown_top_level_and_transition_fields(self):
        self.ledger.create(message_id="msg-closed", recipient="fable", actor="sol")
        stored_path = self.receipt_path()
        with open(stored_path, "r", encoding="utf-8") as handle:
            stored = json.load(handle)
        stored["secret"] = "not-allowed"
        with open(stored_path, "w", encoding="utf-8") as handle:
            json.dump(stored, handle, indent=2)
        with self.assertRaisesRegex(ValueError, 'receipt field "secret" is not allowed'):
            self.ledger.get("msg-closed", "fable")

        del stored["secret"]
        stored["transitions"][0]["payload"] = "not-allowed"
        with open(stored_path, "w", encoding="utf-8") as handle:
            json.dump(stored, handle, indent=2)
        with self.assertRaisesRegex(
            ValueError,
            r'receipt\.transitions\[0\] field "payload" is not allowed',
        ):
            self.ledger.get("msg-closed", "fable")

    def test_requires_canonical_stored_timestamps(self):
        self.ledger.create(
            message_id="msg-time",
            recipient="fable",
            actor="sol",
            at="2026-09-02T12:00:00.000Z",
        )
        stored_path = self.receipt_path()
        with open(stored_path, "r", encoding="utf-8") as handle:
            stored = json.load(handle)
        stored["created_at"] = "2026-09-02T05:00:00.000-07:00"
        with open(stored_path, "w", encoding="utf-8") as handle:
            json.dump(stored, handle, indent=2)
        with self.assertRaisesRegex(ValueError, "canonical UTC timestamp"):
            self.ledger.get("msg-time", "fable")

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
