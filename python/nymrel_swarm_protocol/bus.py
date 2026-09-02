"""
nymrel_swarm_protocol - Mailbox Manager, Strongly-Typed Envelope v2 & Event Stream
Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import uuid
from dataclasses import asdict, dataclass
from typing import Any, Dict, List, Optional, Union
from urllib.parse import quote

from .delivery import DeliveryLedger, DeliveryReceipt
from .fencing import AtomicLockManager, FencingToken, iso_now


class EnvelopeConflictError(ValueError):
    """A message id was replayed with a different immutable contract."""


@dataclass
class EnvelopeHeader:
    id: str
    version: str
    timestamp: str
    sender: str
    recipient: str
    topic: str
    correlation_id: Optional[str] = None
    fencing: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        result = asdict(self)
        if self.fencing is None:
            del result["fencing"]
        if self.correlation_id is None:
            del result["correlation_id"]
        return result


@dataclass
class EnvelopeV2:
    header: EnvelopeHeader
    payload: Any
    checksum: str

    def to_dict(self) -> Dict[str, Any]:
        return {"header": self.header.to_dict(), "payload": self.payload, "checksum": self.checksum}


@dataclass
class BusEvent:
    event_id: str
    timestamp: str
    event_type: str
    actor: str
    resource: Optional[str] = None
    details: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        result = asdict(self)
        if self.resource is None:
            del result["resource"]
        if self.details is None:
            result["details"] = {}
        return result


class EnvelopeEngine:
    @staticmethod
    def compute_checksum(header: Union[EnvelopeHeader, Dict[str, Any]], payload: Any) -> str:
        header_dict = header.to_dict() if isinstance(header, EnvelopeHeader) else header
        payload_string = payload if isinstance(payload, str) else json.dumps(
            payload, separators=(",", ":"), sort_keys=True
        )
        content = (
            f"{header_dict['id']}|{header_dict['version']}|{header_dict['timestamp']}|"
            f"{header_dict['sender']}|{header_dict['recipient']}|{header_dict['topic']}|{payload_string}"
        )
        return hashlib.sha256(content.encode("utf-8")).hexdigest()

    @staticmethod
    def create(
        sender: str,
        recipient: str,
        topic: str,
        payload: Any,
        correlation_id: Optional[str] = None,
        fencing: Optional[Union[FencingToken, Dict[str, Any]]] = None,
    ) -> EnvelopeV2:
        fencing_dict = fencing.to_dict() if isinstance(fencing, FencingToken) else fencing
        header = EnvelopeHeader(
            id=str(uuid.uuid4()),
            version="2.0",
            timestamp=iso_now(),
            sender=sender,
            recipient=recipient,
            topic=topic,
            correlation_id=correlation_id,
            fencing=fencing_dict,
        )
        return EnvelopeV2(
            header=header,
            payload=payload,
            checksum=EnvelopeEngine.compute_checksum(header, payload),
        )

    @staticmethod
    def verify(envelope_data: Union[EnvelopeV2, Dict[str, Any]]) -> bool:
        if isinstance(envelope_data, EnvelopeV2):
            return EnvelopeEngine.compute_checksum(envelope_data.header, envelope_data.payload) == envelope_data.checksum
        if not isinstance(envelope_data, dict):
            return False
        header = envelope_data.get("header")
        checksum = envelope_data.get("checksum")
        payload = envelope_data.get("payload")
        if not header or not checksum or not isinstance(header, dict):
            return False
        if (
            header.get("version") != "2.0"
            or not header.get("id")
            or not header.get("timestamp")
            or not header.get("sender")
            or not header.get("recipient")
            or not header.get("topic")
        ):
            return False
        return EnvelopeEngine.compute_checksum(header, payload) == checksum

    @staticmethod
    def serialize(envelope: EnvelopeV2) -> str:
        return json.dumps(envelope.to_dict(), indent=2)

    @staticmethod
    def deserialize(raw: str) -> EnvelopeV2:
        data = json.loads(raw)
        if not EnvelopeEngine.verify(data):
            raise ValueError("Invalid Envelope v2: Integrity checksum mismatch or invalid structure")
        header_data = data["header"]
        header = EnvelopeHeader(
            id=header_data["id"],
            version=header_data["version"],
            timestamp=header_data["timestamp"],
            sender=header_data["sender"],
            recipient=header_data["recipient"],
            topic=header_data["topic"],
            correlation_id=header_data.get("correlation_id"),
            fencing=header_data.get("fencing"),
        )
        return EnvelopeV2(header=header, payload=data["payload"], checksum=data["checksum"])


class FileMailboxManager:
    def __init__(self, swarm_root: str):
        self.root_dir = swarm_root
        self.mailboxes_dir = os.path.join(swarm_root, "mailboxes")
        self.broadcasts_dir = os.path.join(swarm_root, "broadcasts")
        self.events_file = os.path.join(swarm_root, "events.jsonl")
        self.lock_manager = AtomicLockManager(swarm_root)
        self.delivery_ledger = DeliveryLedger(swarm_root)
        os.makedirs(self.root_dir, exist_ok=True)
        os.makedirs(self.mailboxes_dir, exist_ok=True)
        os.makedirs(self.broadcasts_dir, exist_ok=True)

    def _get_agent_inbox(self, agent_id: str) -> str:
        directory = os.path.join(self.mailboxes_dir, agent_id, "inbox")
        os.makedirs(directory, exist_ok=True)
        return directory

    def _get_agent_outbox(self, agent_id: str) -> str:
        directory = os.path.join(self.mailboxes_dir, agent_id, "outbox")
        os.makedirs(directory, exist_ok=True)
        return directory

    def _get_agent_archive(self, agent_id: str) -> str:
        directory = os.path.join(self.mailboxes_dir, agent_id, "archive")
        os.makedirs(directory, exist_ok=True)
        return directory

    @staticmethod
    def _digest(value: str) -> str:
        return hashlib.sha256(value.encode("utf-8")).hexdigest()

    @staticmethod
    def _segment(value: str) -> str:
        return quote(value, safe="")

    @staticmethod
    def _write_envelope_file(file_path: str, serialized: str) -> bool:
        if os.path.exists(file_path):
            with open(file_path, "r", encoding="utf-8") as handle:
                if handle.read() != serialized:
                    raise EnvelopeConflictError(
                        "Message id is already bound to different envelope bytes"
                    )
            return False

        directory = os.path.dirname(file_path)
        descriptor, temporary_path = tempfile.mkstemp(
            prefix=".envelope-",
            suffix=".tmp",
            dir=directory,
        )
        try:
            os.chmod(temporary_path, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(serialized)
                handle.flush()
                os.fsync(handle.fileno())

            if os.path.exists(file_path):
                with open(file_path, "r", encoding="utf-8") as handle:
                    if handle.read() != serialized:
                        raise EnvelopeConflictError(
                            "Message id is already bound to different envelope bytes"
                        )
                return False

            os.replace(temporary_path, file_path)
            return True
        finally:
            if os.path.exists(temporary_path):
                os.remove(temporary_path)

    def _resolve_recipients(self, envelope: EnvelopeV2, is_broadcast: bool) -> List[str]:
        existing = self.delivery_ledger.list(envelope.header.id)
        if is_broadcast:
            if existing:
                return [receipt.recipient for receipt in existing]
            recipients = sorted(
                agent
                for agent in self.list_mailboxes()
                if agent != envelope.header.sender
            )
            if not recipients:
                raise EnvelopeConflictError(
                    "Broadcast requires at least one registered recipient"
                )
            return recipients

        if any(
            receipt.recipient != envelope.header.recipient
            for receipt in existing
        ):
            raise EnvelopeConflictError(
                "Message id is already bound to a different recipient set"
            )
        return [envelope.header.recipient]

    def _create_delivery_receipt(
        self,
        message_id: str,
        recipient: str,
        sender: str,
        envelope_sha256: str,
    ) -> None:
        self.delivery_ledger.create(
            message_id=message_id,
            recipient=recipient,
            actor=sender,
            evidence={
                "kind": "receipt_created",
                "reference": f"envelope://{self._segment(message_id)}",
                "sha256": envelope_sha256,
            },
        )

    def _mark_delivery_failure(self, message_id: str, recipient: str) -> None:
        receipt = self.delivery_ledger.get(message_id, recipient)
        if receipt is None or DeliveryLedger.is_terminal(receipt.current_state):
            return
        if receipt.current_state not in ("created", "accepted", "routed", "deferred"):
            return

        target = "rejected" if receipt.current_state == "created" else "delivery_unknown"
        self.delivery_ledger.transition(
            message_id=message_id,
            recipient=recipient,
            to=target,
            actor="nymrel-mesh",
            evidence={
                "kind": "reconciliation",
                "reference": (
                    f"delivery://{self._segment(message_id)}/"
                    f"{self._segment(recipient)}/failure"
                ),
            },
            reason_code="local_persistence_failed",
        )

    def _mark_observed(self, agent_id: str, envelope: EnvelopeV2) -> None:
        receipt = self.delivery_ledger.get(envelope.header.id, agent_id)
        if receipt is None:
            return  # Legacy message written before delivery receipts existed.

        serialized = EnvelopeEngine.serialize(envelope)
        reference = f"mailbox://{self._segment(agent_id)}/inbox/{self._segment(envelope.header.id)}"
        digest = self._digest(serialized)

        if receipt.current_state == "created":
            receipt = self.delivery_ledger.transition(
                message_id=envelope.header.id,
                recipient=agent_id,
                to="accepted",
                actor="nymrel-mesh-reconciler",
                evidence={"kind": "reconciliation", "reference": reference, "sha256": digest},
                reason_code="recipient_evidence_reconciled",
            )
        if receipt.current_state in ("accepted", "deferred"):
            receipt = self.delivery_ledger.transition(
                message_id=envelope.header.id,
                recipient=agent_id,
                to="routed",
                actor="nymrel-mesh-reconciler",
                evidence={"kind": "reconciliation", "reference": reference, "sha256": digest},
            )
        if receipt.current_state == "routed":
            receipt = self.delivery_ledger.transition(
                message_id=envelope.header.id,
                recipient=agent_id,
                to="delivered",
                actor="nymrel-mesh-reconciler",
                evidence={"kind": "mailbox_persisted", "reference": reference, "sha256": digest},
            )
        if receipt.current_state in ("delivered", "delivery_unknown"):
            self.delivery_ledger.transition(
                message_id=envelope.header.id,
                recipient=agent_id,
                to="observed",
                actor=agent_id,
                evidence={"kind": "runtime_observed", "reference": reference, "sha256": digest},
            )
            return
        if receipt.current_state in ("observed", "acted", "verified"):
            return
        raise ValueError(
            f'Delivery receipt is terminal at {receipt.current_state}, but message "{envelope.header.id}" exists in recipient inbox'
        )

    def register_agent(self, agent_id: str) -> None:
        self._get_agent_inbox(agent_id)
        self._get_agent_outbox(agent_id)
        self._get_agent_archive(agent_id)

    def list_mailboxes(self) -> List[str]:
        if not os.path.exists(self.mailboxes_dir):
            return []
        return [
            entry
            for entry in os.listdir(self.mailboxes_dir)
            if os.path.isdir(os.path.join(self.mailboxes_dir, entry))
        ]

    def get_delivery_receipt(self, message_id: str, recipient: str) -> Optional[DeliveryReceipt]:
        return self.delivery_ledger.get(message_id, recipient)

    def list_delivery_receipts(self, message_id: Optional[str] = None) -> List[DeliveryReceipt]:
        return self.delivery_ledger.list(message_id)

    def send_message(self, envelope: EnvelopeV2) -> str:
        """Persist one message and recipient-specific delivery receipts.

        A successful return proves mailbox persistence (``delivered``), not
        recipient-runtime observation or action. Replaying the exact same
        envelope is idempotent; the original broadcast recipient set is frozen.
        """
        if not EnvelopeEngine.verify(envelope):
            raise ValueError("Cannot send invalid Envelope v2: verification failed")

        message_id = envelope.header.id
        filename = f"{message_id}.json"
        serialized = EnvelopeEngine.serialize(envelope)
        content_digest = self._digest(serialized)
        is_broadcast = envelope.header.recipient in ("broadcast", "all")

        def operation() -> str:
            changed = False
            recipients = self._resolve_recipients(envelope, is_broadcast)
            for recipient in recipients:
                self._create_delivery_receipt(
                    message_id,
                    recipient,
                    envelope.header.sender,
                    content_digest,
                )

            outbox_reference = (
                f"mailbox://{self._segment(envelope.header.sender)}/outbox/"
                f"{self._segment(message_id)}"
            )
            try:
                outbox = self._get_agent_outbox(envelope.header.sender)
                outbox_path = os.path.join(outbox, filename)
                changed = self._write_envelope_file(outbox_path, serialized) or changed
                for recipient in recipients:
                    receipt = self.delivery_ledger.get(message_id, recipient)
                    if receipt is not None and receipt.current_state == "created":
                        self.delivery_ledger.transition(
                            message_id=message_id,
                            recipient=recipient,
                            to="accepted",
                            actor=envelope.header.sender,
                            evidence={
                                "kind": "outbox_persisted",
                                "reference": outbox_reference,
                                "sha256": content_digest,
                            },
                        )
                        changed = True
            except Exception as error:
                if not isinstance(error, EnvelopeConflictError):
                    for recipient in recipients:
                        self._mark_delivery_failure(message_id, recipient)
                raise

            if is_broadcast:
                try:
                    changed = (
                        self._write_envelope_file(
                            os.path.join(self.broadcasts_dir, filename),
                            serialized,
                        )
                        or changed
                    )
                except Exception as error:
                    if not isinstance(error, EnvelopeConflictError):
                        for recipient in recipients:
                            self._mark_delivery_failure(message_id, recipient)
                    raise

            failed_recipients: List[str] = []
            first_failure: Optional[BaseException] = None
            for recipient in recipients:
                try:
                    receipt = self.delivery_ledger.get(message_id, recipient)
                    if receipt is None:
                        raise RuntimeError("Delivery receipt disappeared during send")

                    if receipt.current_state in (
                        "accepted",
                        "deferred",
                        "delivery_unknown",
                    ):
                        prior_state = receipt.current_state
                        receipt = self.delivery_ledger.transition(
                            message_id=message_id,
                            recipient=recipient,
                            to="routed",
                            actor="nymrel-mesh",
                            evidence={
                                "kind": (
                                    "reconciliation"
                                    if prior_state == "delivery_unknown"
                                    else "route_selected"
                                ),
                                "reference": f"mailbox://{self._segment(recipient)}",
                            },
                        )
                        changed = True

                    inbox_path = os.path.join(
                        self._get_agent_inbox(recipient),
                        filename,
                    )
                    archive_path = os.path.join(
                        self._get_agent_archive(recipient),
                        filename,
                    )

                    if receipt.current_state == "routed":
                        self._write_envelope_file(inbox_path, serialized)
                        receipt = self.delivery_ledger.transition(
                            message_id=message_id,
                            recipient=recipient,
                            to="delivered",
                            actor="nymrel-mesh",
                            evidence={
                                "kind": "mailbox_persisted",
                                "reference": (
                                    f"mailbox://{self._segment(recipient)}/inbox/"
                                    f"{self._segment(message_id)}"
                                ),
                                "sha256": content_digest,
                            },
                        )
                        changed = True

                    if receipt.current_state in (
                        "delivered",
                        "observed",
                        "acted",
                        "verified",
                    ):
                        persisted_path = (
                            inbox_path if os.path.exists(inbox_path) else archive_path
                        )
                        if not os.path.exists(persisted_path):
                            raise RuntimeError(
                                "Delivery receipt claims persistence, but no recipient copy exists"
                            )
                        self._write_envelope_file(persisted_path, serialized)
                        continue

                    raise RuntimeError(
                        "Message cannot be retried from terminal delivery state "
                        f"{receipt.current_state}"
                    )
                except Exception as error:
                    failed_recipients.append(recipient)
                    if first_failure is None:
                        first_failure = error
                    if not isinstance(error, EnvelopeConflictError):
                        self._mark_delivery_failure(message_id, recipient)

            if failed_recipients:
                if first_failure is not None:
                    raise first_failure
                raise RuntimeError(
                    f"Message delivery was not confirmed for {len(failed_recipients)} recipient(s)"
                )

            if changed:
                try:
                    self.record_event(
                        BusEvent(
                            event_id=str(uuid.uuid4()),
                            timestamp=iso_now(),
                            event_type=(
                                "message_broadcast"
                                if is_broadcast
                                else "message_sent"
                            ),
                            actor=envelope.header.sender,
                            details=(
                                {
                                    "message_id": message_id,
                                    "topic": envelope.header.topic,
                                    "recipients_count": len(recipients),
                                }
                                if is_broadcast
                                else {
                                    "message_id": message_id,
                                    "recipient": envelope.header.recipient,
                                    "topic": envelope.header.topic,
                                }
                            ),
                        )
                    )
                except Exception:
                    # Delivery truth is already persisted. An ancillary event-log
                    # failure must not masquerade as delivery failure.
                    pass

            return message_id

        return self.lock_manager.with_lock(
            f"message_send_{self._digest(message_id)}",
            operation,
        )

    def broadcast(
        self,
        sender: str,
        topic: str,
        payload: Any,
        fencing: Optional[Union[FencingToken, Dict[str, Any]]] = None,
    ) -> EnvelopeV2:
        envelope = EnvelopeEngine.create(
            sender=sender,
            recipient="broadcast",
            topic=topic,
            payload=payload,
            fencing=fencing,
        )
        self.send_message(envelope)
        return envelope

    def receive_messages(
        self,
        agent_id: str,
        limit: Optional[int] = None,
        auto_acknowledge: bool = False,
    ) -> List[EnvelopeV2]:
        inbox = self._get_agent_inbox(agent_id)
        filenames = [filename for filename in os.listdir(inbox) if filename.endswith(".json")]
        if limit is not None:
            filenames = filenames[:limit]

        messages: List[EnvelopeV2] = []
        for filename in filenames:
            file_path = os.path.join(inbox, filename)
            try:
                with open(file_path, "r", encoding="utf-8") as handle:
                    envelope = EnvelopeEngine.deserialize(handle.read())
            except Exception:
                continue  # Corrupt content is not evidence of observation.

            self._mark_observed(agent_id, envelope)
            messages.append(envelope)
            if auto_acknowledge:
                self.acknowledge_message(agent_id, envelope.header.id)
        return messages

    def acknowledge_message(self, agent_id: str, message_id: str) -> None:
        inbox = self._get_agent_inbox(agent_id)
        archive = self._get_agent_archive(agent_id)
        filename = f"{message_id}.json"
        source = os.path.join(inbox, filename)
        destination = os.path.join(archive, filename)
        if os.path.exists(source):
            os.replace(source, destination)

    def record_event(self, event: BusEvent) -> None:
        def operation() -> None:
            with open(self.events_file, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(event.to_dict()) + "\n")

        self.lock_manager.with_lock("events_log", operation)

    def read_event_stream(self, limit: int = 100) -> List[Dict[str, Any]]:
        if not os.path.exists(self.events_file):
            return []
        with open(self.events_file, "r", encoding="utf-8") as handle:
            lines = [line.strip() for line in handle if line.strip()]
        events: List[Dict[str, Any]] = []
        for line in lines[max(0, len(lines) - limit):]:
            try:
                events.append(json.loads(line))
            except Exception:
                pass
        return events
