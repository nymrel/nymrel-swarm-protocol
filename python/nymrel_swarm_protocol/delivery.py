"""Nymrel Mesh delivery truth ledger.

A sender-side success never stands in for recipient observation or verified
completion. One tamper-evident receipt is persisted for each
``(message_id, recipient)`` pair.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional, Tuple

from .fencing import AtomicLockManager

DELIVERY_RECEIPT_VERSION = "1.0"

DELIVERY_STATES: Tuple[str, ...] = (
    "created",
    "accepted",
    "routed",
    "deferred",
    "delivered",
    "observed",
    "acted",
    "verified",
    "delivery_unknown",
    "expired",
    "dead_lettered",
    "revoked",
    "rejected",
)

DELIVERY_EVIDENCE_KINDS: Tuple[str, ...] = (
    "receipt_created",
    "outbox_persisted",
    "route_selected",
    "mailbox_persisted",
    "runtime_observed",
    "agent_action",
    "verification",
    "reconciliation",
    "operator_decision",
)

DELIVERY_REASON_CODES: Tuple[str, ...] = (
    "local_persistence_failed",
    "recipient_evidence_reconciled",
    "transport_result_ambiguous",
    "explicit_reconciliation",
    "deadline_expired",
    "delivery_dead_lettered",
    "authority_revoked",
    "recipient_rejected",
)

TERMINAL_STATES = frozenset(("verified", "expired", "dead_lettered", "revoked", "rejected"))
ALLOWED_TRANSITIONS: Mapping[str, Tuple[str, ...]] = {
    "created": ("accepted", "rejected", "revoked"),
    "accepted": (
        "routed",
        "deferred",
        "delivery_unknown",
        "expired",
        "dead_lettered",
        "revoked",
        "rejected",
    ),
    "routed": ("delivered", "deferred", "delivery_unknown", "expired", "dead_lettered", "revoked"),
    "deferred": ("routed", "delivery_unknown", "expired", "dead_lettered", "revoked"),
    "delivered": ("observed", "expired", "dead_lettered", "revoked"),
    "observed": ("acted", "revoked"),
    "acted": ("verified", "revoked"),
    "delivery_unknown": (
        "routed",
        "deferred",
        "delivered",
        "observed",
        "expired",
        "dead_lettered",
        "revoked",
    ),
    "verified": (),
    "expired": (),
    "dead_lettered": (),
    "revoked": (),
    "rejected": (),
}

_EVIDENCE_KEYS = frozenset(("kind", "reference", "sha256"))
_TRANSITION_KEYS = frozenset(
    (
        "sequence",
        "from",
        "to",
        "actor",
        "at",
        "evidence",
        "reason_code",
        "previous_hash",
        "hash",
    )
)
_RECEIPT_KEYS = frozenset(
    (
        "version",
        "message_id",
        "recipient",
        "current_state",
        "created_at",
        "updated_at",
        "chain_hash",
        "transitions",
    )
)


def _assert_text(value: Any, field: str, max_length: int) -> str:
    if not isinstance(value, str) or not value or value.strip() != value:
        raise ValueError(f"{field} must be a non-empty string without surrounding whitespace")
    if len(value) > max_length:
        raise ValueError(f"{field} exceeds the maximum length of {max_length}")
    if any(unicodedata.category(char) == "Cc" for char in value):
        raise ValueError(f"{field} must not contain control characters")
    return value


def _assert_closed_object(value: Mapping[str, Any], allowed: frozenset[str], field: str) -> None:
    unknown = set(value) - allowed
    if unknown:
        key = sorted(unknown)[0]
        raise ValueError(f'{field} field "{key}" is not allowed')


def _parse_timestamp(value: str) -> datetime:
    if not (value.endswith("Z") or (len(value) >= 6 and value[-6] in "+-" and value[-3] == ":")):
        raise ValueError("timestamp must include an explicit UTC or offset timezone")
    prepared = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(prepared)
    except ValueError as exc:
        raise ValueError("timestamp must be valid ISO-8601") from exc
    if parsed.tzinfo is None:
        raise ValueError("timestamp must include a timezone")
    return parsed.astimezone(timezone.utc)


def _canonical_timestamp(parsed: datetime) -> str:
    return parsed.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _normalize_timestamp(value: Optional[str] = None) -> str:
    parsed = datetime.now(timezone.utc) if value is None else _parse_timestamp(_assert_text(value, "at", 64))
    return _canonical_timestamp(parsed)


def _assert_canonical_timestamp(value: Any, field: str) -> datetime:
    text = _assert_text(value, field, 64)
    parsed = _parse_timestamp(text)
    if _canonical_timestamp(parsed) != text:
        raise ValueError(f"{field} must be a canonical UTC timestamp")
    return parsed


def _assert_evidence(value: Any) -> "DeliveryEvidence":
    if isinstance(value, DeliveryEvidence):
        candidate = value.to_dict()
    elif isinstance(value, dict):
        candidate = dict(value)
    else:
        raise ValueError("evidence must be an object")

    _assert_closed_object(candidate, _EVIDENCE_KEYS, "evidence")
    kind = candidate.get("kind")
    if kind not in DELIVERY_EVIDENCE_KINDS:
        raise ValueError(f"evidence.kind must be one of: {', '.join(DELIVERY_EVIDENCE_KINDS)}")
    reference = _assert_text(candidate.get("reference"), "evidence.reference", 2048)
    digest = candidate.get("sha256")
    if digest is not None:
        if not isinstance(digest, str) or len(digest) != 64 or any(ch not in "0123456789abcdef" for ch in digest):
            raise ValueError("evidence.sha256 must be a lowercase 64-character SHA-256 digest")
    return DeliveryEvidence(kind=kind, reference=reference, sha256=digest)


def _assert_reason_code(value: Any) -> str:
    if value not in DELIVERY_REASON_CODES:
        raise ValueError(f"reason_code must be one of: {', '.join(DELIVERY_REASON_CODES)}")
    return value


def _encode_field(value: Optional[str]) -> str:
    normalized = "" if value is None else value
    return f"{len(normalized.encode('utf-8'))}:{normalized}"


class DeliveryReceiptConflictError(ValueError):
    """A receipt key was replayed with a different creation contract."""


@dataclass(frozen=True)
class DeliveryEvidence:
    kind: str
    reference: str
    sha256: Optional[str] = None

    def to_dict(self) -> Dict[str, str]:
        result = {"kind": self.kind, "reference": self.reference}
        if self.sha256 is not None:
            result["sha256"] = self.sha256
        return result


@dataclass(frozen=True)
class DeliveryTransition:
    sequence: int
    from_state: Optional[str]
    to: str
    actor: str
    at: str
    previous_hash: Optional[str]
    hash: str
    evidence: Optional[DeliveryEvidence] = None
    reason_code: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "sequence": self.sequence,
            "from": self.from_state,
            "to": self.to,
            "actor": self.actor,
            "at": self.at,
            "previous_hash": self.previous_hash,
            "hash": self.hash,
        }
        if self.evidence is not None:
            result["evidence"] = self.evidence.to_dict()
        if self.reason_code is not None:
            result["reason_code"] = self.reason_code
        return result


@dataclass(frozen=True)
class DeliveryReceipt:
    version: str
    message_id: str
    recipient: str
    current_state: str
    created_at: str
    updated_at: str
    chain_hash: str
    transitions: Tuple[DeliveryTransition, ...]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "version": self.version,
            "message_id": self.message_id,
            "recipient": self.recipient,
            "current_state": self.current_state,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "chain_hash": self.chain_hash,
            "transitions": [transition.to_dict() for transition in self.transitions],
        }


class DeliveryLedger:
    def __init__(self, swarm_root: str):
        _assert_text(swarm_root, "swarm_root", 4096)
        self.receipts_dir = os.path.join(swarm_root, "deliveries")
        self.lock_manager = AtomicLockManager(swarm_root)
        os.makedirs(self.receipts_dir, exist_ok=True)

    @staticmethod
    def is_terminal(state: str) -> bool:
        return state in DELIVERY_STATES and state in TERMINAL_STATES

    @staticmethod
    def can_transition(from_state: str, to: str) -> bool:
        if from_state not in DELIVERY_STATES or to not in DELIVERY_STATES:
            return False
        return from_state == to or to in ALLOWED_TRANSITIONS[from_state]

    @staticmethod
    def compute_transition_hash(
        message_id: str,
        recipient: str,
        *,
        sequence: int,
        from_state: Optional[str],
        to: str,
        actor: str,
        at: str,
        evidence: Optional[DeliveryEvidence],
        reason_code: Optional[str],
        previous_hash: Optional[str],
    ) -> str:
        fields = (
            message_id,
            recipient,
            str(sequence),
            from_state,
            to,
            actor,
            at,
            evidence.kind if evidence else None,
            evidence.reference if evidence else None,
            evidence.sha256 if evidence else None,
            reason_code,
            previous_hash,
        )
        material = "".join(_encode_field(value) for value in fields)
        return hashlib.sha256(material.encode("utf-8")).hexdigest()

    @staticmethod
    def verify_receipt(receipt: Any) -> bool:
        try:
            DeliveryLedger._receipt_from_value(receipt)
            return True
        except (TypeError, ValueError, KeyError):
            return False

    def create(
        self,
        *,
        message_id: str,
        recipient: str,
        actor: str,
        at: Optional[str] = None,
        evidence: Optional[Any] = None,
        reason_code: Optional[str] = None,
    ) -> DeliveryReceipt:
        _assert_text(message_id, "message_id", 512)
        _assert_text(recipient, "recipient", 512)
        _assert_text(actor, "actor", 512)
        normalized_evidence = _assert_evidence(evidence) if evidence is not None else None
        if reason_code is not None:
            _assert_reason_code(reason_code)

        receipt_path = self._receipt_path(message_id, recipient, create_parent=True)
        lock_name = self._lock_name(message_id, recipient)

        def operation() -> DeliveryReceipt:
            existing = self._read_receipt(receipt_path)
            if existing is not None:
                creation = existing.transitions[0]
                same_evidence = (
                    (creation.evidence.to_dict() if creation.evidence else None)
                    == (normalized_evidence.to_dict() if normalized_evidence else None)
                )
                requested_at_matches = (
                    at is None or creation.at == _normalize_timestamp(at)
                )
                if (
                    creation.actor != actor
                    or not same_evidence
                    or creation.reason_code != reason_code
                    or not requested_at_matches
                ):
                    raise DeliveryReceiptConflictError(
                        "Delivery receipt already exists with a different creation contract"
                    )
                return existing

            timestamp = _normalize_timestamp(at)
            transition_hash = self.compute_transition_hash(
                message_id,
                recipient,
                sequence=1,
                from_state=None,
                to="created",
                actor=actor,
                at=timestamp,
                evidence=normalized_evidence,
                reason_code=reason_code,
                previous_hash=None,
            )
            transition = DeliveryTransition(
                sequence=1,
                from_state=None,
                to="created",
                actor=actor,
                at=timestamp,
                evidence=normalized_evidence,
                reason_code=reason_code,
                previous_hash=None,
                hash=transition_hash,
            )
            receipt = DeliveryReceipt(
                version=DELIVERY_RECEIPT_VERSION,
                message_id=message_id,
                recipient=recipient,
                current_state="created",
                created_at=timestamp,
                updated_at=timestamp,
                chain_hash=transition_hash,
                transitions=(transition,),
            )
            self._write_receipt(receipt_path, receipt)
            return receipt

        return self.lock_manager.with_lock(lock_name, operation)

    def transition(
        self,
        *,
        message_id: str,
        recipient: str,
        to: str,
        actor: str,
        at: Optional[str] = None,
        evidence: Optional[Any] = None,
        reason_code: Optional[str] = None,
    ) -> DeliveryReceipt:
        _assert_text(message_id, "message_id", 512)
        _assert_text(recipient, "recipient", 512)
        _assert_text(actor, "actor", 512)
        self._assert_state(to)
        normalized_evidence = _assert_evidence(evidence) if evidence is not None else None
        if reason_code is not None:
            _assert_reason_code(reason_code)

        receipt_path = self._receipt_path(message_id, recipient, create_parent=False)
        lock_name = self._lock_name(message_id, recipient)

        def operation() -> DeliveryReceipt:
            receipt = self._read_receipt(receipt_path)
            if receipt is None:
                raise ValueError(
                    f'No delivery receipt exists for message "{message_id}" and recipient "{recipient}"'
                )
            if receipt.current_state == to:
                prior = receipt.transitions[-1]
                if (
                    prior.actor != actor
                    or prior.evidence != normalized_evidence
                    or prior.reason_code != reason_code
                ):
                    raise ValueError(
                        f'Conflicting same-state retry for message "{message_id}" and recipient "{recipient}"'
                    )
                if at is not None and _normalize_timestamp(at) != prior.at:
                    raise ValueError("Conflicting same-state retry timestamp")
                return receipt
            if not self.can_transition(receipt.current_state, to):
                raise ValueError(
                    f'Invalid delivery transition {receipt.current_state} -> {to} for message "{message_id}"'
                )

            timestamp = _normalize_timestamp(at)
            if _parse_timestamp(timestamp) < _parse_timestamp(receipt.updated_at):
                raise ValueError("Delivery transition timestamp must not move backward")

            sequence = len(receipt.transitions) + 1
            transition_hash = self.compute_transition_hash(
                message_id,
                recipient,
                sequence=sequence,
                from_state=receipt.current_state,
                to=to,
                actor=actor,
                at=timestamp,
                evidence=normalized_evidence,
                reason_code=reason_code,
                previous_hash=receipt.chain_hash,
            )
            transition = DeliveryTransition(
                sequence=sequence,
                from_state=receipt.current_state,
                to=to,
                actor=actor,
                at=timestamp,
                evidence=normalized_evidence,
                reason_code=reason_code,
                previous_hash=receipt.chain_hash,
                hash=transition_hash,
            )
            updated = DeliveryReceipt(
                version=receipt.version,
                message_id=receipt.message_id,
                recipient=receipt.recipient,
                current_state=to,
                created_at=receipt.created_at,
                updated_at=timestamp,
                chain_hash=transition_hash,
                transitions=receipt.transitions + (transition,),
            )
            self._write_receipt(receipt_path, updated)
            return updated

        return self.lock_manager.with_lock(lock_name, operation)

    def get(self, message_id: str, recipient: str) -> Optional[DeliveryReceipt]:
        _assert_text(message_id, "message_id", 512)
        _assert_text(recipient, "recipient", 512)
        return self._read_receipt(self._receipt_path(message_id, recipient, create_parent=False))

    def list(self, message_id: Optional[str] = None) -> List[DeliveryReceipt]:
        if message_id is not None:
            _assert_text(message_id, "message_id", 512)
            message_dirs = [os.path.join(self.receipts_dir, self._digest(message_id))]
        else:
            message_dirs = [
                os.path.join(self.receipts_dir, entry)
                for entry in os.listdir(self.receipts_dir)
                if os.path.isdir(os.path.join(self.receipts_dir, entry))
            ]

        receipts: List[DeliveryReceipt] = []
        for directory in message_dirs:
            if not os.path.isdir(directory):
                continue
            for filename in os.listdir(directory):
                if not filename.endswith(".json"):
                    continue
                receipt = self._read_receipt(os.path.join(directory, filename))
                if receipt is not None and (message_id is None or receipt.message_id == message_id):
                    receipts.append(receipt)
        return sorted(receipts, key=lambda receipt: (receipt.message_id, receipt.recipient))

    @staticmethod
    def _assert_state(value: Any) -> str:
        if value not in DELIVERY_STATES:
            raise ValueError(f"Delivery state must be one of: {', '.join(DELIVERY_STATES)}")
        return value

    @staticmethod
    def _receipt_from_value(value: Any) -> DeliveryReceipt:
        data = value.to_dict() if isinstance(value, DeliveryReceipt) else value
        if not isinstance(data, dict):
            raise ValueError("Delivery receipt must be an object")
        _assert_closed_object(data, _RECEIPT_KEYS, "receipt")
        if data.get("version") != DELIVERY_RECEIPT_VERSION:
            raise ValueError(f"Unsupported delivery receipt version: {data.get('version')}")

        message_id = _assert_text(data.get("message_id"), "receipt.message_id", 512)
        recipient = _assert_text(data.get("recipient"), "receipt.recipient", 512)
        current_state = DeliveryLedger._assert_state(data.get("current_state"))
        created_at = _assert_text(data.get("created_at"), "receipt.created_at", 64)
        updated_at = _assert_text(data.get("updated_at"), "receipt.updated_at", 64)
        created_timestamp = _assert_canonical_timestamp(created_at, "receipt.created_at")
        updated_timestamp = _assert_canonical_timestamp(updated_at, "receipt.updated_at")
        if updated_timestamp < created_timestamp:
            raise ValueError("receipt.updated_at must not precede receipt.created_at")
        chain_hash = data.get("chain_hash")
        if not isinstance(chain_hash, str) or len(chain_hash) != 64 or any(ch not in "0123456789abcdef" for ch in chain_hash):
            raise ValueError("receipt.chain_hash is invalid")

        raw_transitions = data.get("transitions")
        if not isinstance(raw_transitions, list) or not raw_transitions:
            raise ValueError("receipt.transitions must be a non-empty array")

        transitions: List[DeliveryTransition] = []
        prior_state: Optional[str] = None
        prior_hash: Optional[str] = None
        prior_timestamp: Optional[datetime] = None
        for index, raw_transition in enumerate(raw_transitions):
            if not isinstance(raw_transition, dict):
                raise ValueError(f"receipt.transitions[{index}] is invalid")
            _assert_closed_object(raw_transition, _TRANSITION_KEYS, f"receipt.transitions[{index}]")
            if raw_transition.get("sequence") != index + 1:
                raise ValueError("Delivery transition sequence is not contiguous")
            if raw_transition.get("from") != prior_state:
                raise ValueError("Delivery transition predecessor does not match the prior state")

            to = DeliveryLedger._assert_state(raw_transition.get("to"))
            if index == 0 and to != "created":
                raise ValueError("The first delivery transition must create the receipt")
            if index > 0 and (prior_state is None or to not in ALLOWED_TRANSITIONS[prior_state]):
                raise ValueError(f"Stored delivery transition {prior_state} -> {to} is invalid")

            actor = _assert_text(raw_transition.get("actor"), "transition.actor", 512)
            at = _assert_text(raw_transition.get("at"), "transition.at", 64)
            transition_timestamp = _assert_canonical_timestamp(at, "transition.at")
            if prior_timestamp is not None and transition_timestamp < prior_timestamp:
                raise ValueError("Delivery transition timestamps must not move backward")
            evidence = _assert_evidence(raw_transition["evidence"]) if "evidence" in raw_transition else None
            reason_code = raw_transition.get("reason_code")
            if reason_code is not None:
                _assert_reason_code(reason_code)
            previous_hash = raw_transition.get("previous_hash")
            if previous_hash != prior_hash:
                raise ValueError("Delivery transition hash chain predecessor is invalid")
            transition_hash = raw_transition.get("hash")
            if (
                not isinstance(transition_hash, str)
                or len(transition_hash) != 64
                or any(ch not in "0123456789abcdef" for ch in transition_hash)
            ):
                raise ValueError("Delivery transition hash is invalid")

            expected_hash = DeliveryLedger.compute_transition_hash(
                message_id,
                recipient,
                sequence=index + 1,
                from_state=prior_state,
                to=to,
                actor=actor,
                at=at,
                evidence=evidence,
                reason_code=reason_code,
                previous_hash=previous_hash,
            )
            if expected_hash != transition_hash:
                raise ValueError("Delivery transition hash mismatch")

            transition = DeliveryTransition(
                sequence=index + 1,
                from_state=prior_state,
                to=to,
                actor=actor,
                at=at,
                evidence=evidence,
                reason_code=reason_code,
                previous_hash=previous_hash,
                hash=transition_hash,
            )
            transitions.append(transition)
            prior_state = to
            prior_hash = transition_hash
            prior_timestamp = transition_timestamp

        if current_state != prior_state or chain_hash != prior_hash:
            raise ValueError("Delivery receipt head does not match its transition chain")
        if created_at != transitions[0].at:
            raise ValueError("receipt.created_at does not match the first transition")
        if updated_at != transitions[-1].at:
            raise ValueError("receipt.updated_at does not match the final transition")

        return DeliveryReceipt(
            version=DELIVERY_RECEIPT_VERSION,
            message_id=message_id,
            recipient=recipient,
            current_state=current_state,
            created_at=created_at,
            updated_at=updated_at,
            chain_hash=chain_hash,
            transitions=tuple(transitions),
        )

    @staticmethod
    def _digest(value: str) -> str:
        return hashlib.sha256(value.encode("utf-8")).hexdigest()

    def _receipt_path(self, message_id: str, recipient: str, *, create_parent: bool) -> str:
        directory = os.path.join(self.receipts_dir, self._digest(message_id))
        if create_parent:
            os.makedirs(directory, exist_ok=True)
        return os.path.join(directory, f"{self._digest(recipient)}.json")

    def _lock_name(self, message_id: str, recipient: str) -> str:
        return f"delivery_{self._digest(message_id)}_{self._digest(recipient)}"

    def _read_receipt(self, receipt_path: str) -> Optional[DeliveryReceipt]:
        if not os.path.exists(receipt_path):
            return None
        with open(receipt_path, "r", encoding="utf-8") as handle:
            return self._receipt_from_value(json.load(handle))

    def _write_receipt(self, receipt_path: str, receipt: DeliveryReceipt) -> None:
        verified = self._receipt_from_value(receipt)
        directory = os.path.dirname(receipt_path)
        file_descriptor, temporary_path = tempfile.mkstemp(prefix=".delivery-", suffix=".tmp", dir=directory)
        try:
            os.chmod(temporary_path, 0o600)
            with os.fdopen(file_descriptor, "w", encoding="utf-8") as handle:
                json.dump(verified.to_dict(), handle, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, receipt_path)
        finally:
            if os.path.exists(temporary_path):
                os.remove(temporary_path)
