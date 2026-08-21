"""
nymrel_swarm_protocol - Mailbox Manager, Strongly-Typed Envelope v2 & Event Stream
Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
"""

import os
import time
import json
import uuid
import hashlib
from typing import Optional, Dict, Any, List, Union
from dataclasses import dataclass, asdict
from .fencing import FencingToken, AtomicLockManager, iso_now


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
        d = asdict(self)
        if self.fencing is None:
            del d["fencing"]
        if self.correlation_id is None:
            del d["correlation_id"]
        return d


@dataclass
class EnvelopeV2:
    header: EnvelopeHeader
    payload: Any
    checksum: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "header": self.header.to_dict(),
            "payload": self.payload,
            "checksum": self.checksum,
        }


@dataclass
class BusEvent:
    event_id: str
    timestamp: str
    event_type: str
    actor: str
    resource: Optional[str] = None
    details: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        if self.resource is None:
            del d["resource"]
        if self.details is None:
            d["details"] = {}
        return d


class EnvelopeEngine:
    @staticmethod
    def compute_checksum(header: Union[EnvelopeHeader, Dict[str, Any]], payload: Any) -> str:
        h_dict = header.to_dict() if isinstance(header, EnvelopeHeader) else header
        payload_str = payload if isinstance(payload, str) else json.dumps(payload, separators=(",", ":"), sort_keys=True)
        content = (
            f"{h_dict['id']}|{h_dict['version']}|{h_dict['timestamp']}|"
            f"{h_dict['sender']}|{h_dict['recipient']}|{h_dict['topic']}|{payload_str}"
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
        now = iso_now()
        fencing_dict = fencing.to_dict() if isinstance(fencing, FencingToken) else fencing

        header = EnvelopeHeader(
            id=str(uuid.uuid4()),
            version="2.0",
            timestamp=now,
            sender=sender,
            recipient=recipient,
            topic=topic,
            correlation_id=correlation_id,
            fencing=fencing_dict,
        )

        checksum = EnvelopeEngine.compute_checksum(header, payload)
        return EnvelopeV2(header=header, payload=payload, checksum=checksum)

    @staticmethod
    def verify(envelope_data: Union[EnvelopeV2, Dict[str, Any]]) -> bool:
        if isinstance(envelope_data, EnvelopeV2):
            expected = EnvelopeEngine.compute_checksum(envelope_data.header, envelope_data.payload)
            return expected == envelope_data.checksum

        if not isinstance(envelope_data, dict):
            return False

        header = envelope_data.get("header")
        checksum = envelope_data.get("checksum")
        payload = envelope_data.get("payload")

        if not header or not checksum or not isinstance(header, dict):
            return False

        if header.get("version") != "2.0" or not header.get("id") or not header.get("sender"):
            return False

        expected = EnvelopeEngine.compute_checksum(header, payload)
        return expected == checksum

    @staticmethod
    def serialize(envelope: EnvelopeV2) -> str:
        return json.dumps(envelope.to_dict(), indent=2)

    @staticmethod
    def deserialize(raw: str) -> EnvelopeV2:
        data = json.loads(raw)
        if not EnvelopeEngine.verify(data):
            raise ValueError("Invalid Envelope v2: Integrity checksum mismatch or invalid structure")
        h = data["header"]
        header = EnvelopeHeader(
            id=h["id"],
            version=h["version"],
            timestamp=h["timestamp"],
            sender=h["sender"],
            recipient=h["recipient"],
            topic=h["topic"],
            correlation_id=h.get("correlation_id"),
            fencing=h.get("fencing"),
        )
        return EnvelopeV2(header=header, payload=data["payload"], checksum=data["checksum"])


class FileMailboxManager:
    def __init__(self, swarm_root: str):
        self.root_dir = swarm_root
        self.mailboxes_dir = os.path.join(swarm_root, "mailboxes")
        self.broadcasts_dir = os.path.join(swarm_root, "broadcasts")
        self.events_file = os.path.join(swarm_root, "events.jsonl")
        self.lock_manager = AtomicLockManager(swarm_root)

        os.makedirs(self.root_dir, exist_ok=True)
        os.makedirs(self.mailboxes_dir, exist_ok=True)
        os.makedirs(self.broadcasts_dir, exist_ok=True)

    def _get_agent_inbox(self, agent_id: str) -> str:
        d = os.path.join(self.mailboxes_dir, agent_id, "inbox")
        os.makedirs(d, exist_ok=True)
        return d

    def _get_agent_outbox(self, agent_id: str) -> str:
        d = os.path.join(self.mailboxes_dir, agent_id, "outbox")
        os.makedirs(d, exist_ok=True)
        return d

    def _get_agent_archive(self, agent_id: str) -> str:
        d = os.path.join(self.mailboxes_dir, agent_id, "archive")
        os.makedirs(d, exist_ok=True)
        return d

    def register_agent(self, agent_id: str) -> None:
        self._get_agent_inbox(agent_id)
        self._get_agent_outbox(agent_id)
        self._get_agent_archive(agent_id)

    def list_mailboxes(self) -> List[str]:
        if not os.path.exists(self.mailboxes_dir):
            return []
        return [
            d for d in os.listdir(self.mailboxes_dir)
            if os.path.isdir(os.path.join(self.mailboxes_dir, d))
        ]

    def send_message(self, envelope: EnvelopeV2) -> str:
        if not EnvelopeEngine.verify(envelope):
            raise ValueError("Cannot send invalid Envelope v2: verification failed")

        msg_id = envelope.header.id
        filename = f"{msg_id}.json"
        serialized = EnvelopeEngine.serialize(envelope)

        # 1. Outbox
        outbox = self._get_agent_outbox(envelope.header.sender)
        with open(os.path.join(outbox, filename), "w", encoding="utf-8") as f:
            f.write(serialized)

        # 2. Inboxes
        is_broadcast = envelope.header.recipient in ("broadcast", "all")
        now = iso_now()

        if is_broadcast:
            with open(os.path.join(self.broadcasts_dir, filename), "w", encoding="utf-8") as f:
                f.write(serialized)

            all_agents = self.list_mailboxes()
            for agent in all_agents:
                if agent != envelope.header.sender:
                    inbox = self._get_agent_inbox(agent)
                    with open(os.path.join(inbox, filename), "w", encoding="utf-8") as f:
                        f.write(serialized)

            self.record_event(BusEvent(
                event_id=str(uuid.uuid4()),
                timestamp=now,
                event_type="message_broadcast",
                actor=envelope.header.sender,
                details={
                    "message_id": msg_id,
                    "topic": envelope.header.topic,
                    "recipients_count": max(0, len(all_agents) - 1),
                }
            ))
        else:
            inbox = self._get_agent_inbox(envelope.header.recipient)
            with open(os.path.join(inbox, filename), "w", encoding="utf-8") as f:
                f.write(serialized)

            self.record_event(BusEvent(
                event_id=str(uuid.uuid4()),
                timestamp=now,
                event_type="message_sent",
                actor=envelope.header.sender,
                details={
                    "message_id": msg_id,
                    "recipient": envelope.header.recipient,
                    "topic": envelope.header.topic,
                }
            ))

        return msg_id

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
        files = [f for f in os.listdir(inbox) if f.endswith(".json")]
        if limit is not None:
            files = files[:limit]

        messages: List[EnvelopeV2] = []
        for file in files:
            file_path = os.path.join(inbox, file)
            try:
                with open(file_path, "r", encoding="utf-8") as f:
                    raw = f.read()
                envelope = EnvelopeEngine.deserialize(raw)
                messages.append(envelope)

                if auto_acknowledge:
                    self.acknowledge_message(agent_id, envelope.header.id)
            except Exception:
                pass

        return messages

    def acknowledge_message(self, agent_id: str, message_id: str) -> None:
        inbox = self._get_agent_inbox(agent_id)
        archive = self._get_agent_archive(agent_id)
        filename = f"{message_id}.json"
        src = os.path.join(inbox, filename)
        dest = os.path.join(archive, filename)

        if os.path.exists(src):
            try:
                os.replace(src, dest)
            except Exception:
                pass

    def record_event(self, event: BusEvent) -> None:
        def _op():
            line = json.dumps(event.to_dict()) + "\n"
            with open(self.events_file, "a", encoding="utf-8") as f:
                f.write(line)

        self.lock_manager.with_lock("events_log", _op)

    def read_event_stream(self, limit: int = 100) -> List[Dict[str, Any]]:
        if not os.path.exists(self.events_file):
            return []

        with open(self.events_file, "r", encoding="utf-8") as f:
            lines = [line.strip() for line in f if line.strip()]

        start_idx = max(0, len(lines) - limit)
        selected = lines[start_idx:]
        events = []
        for line in selected:
            try:
                events.append(json.loads(line))
            except Exception:
                pass
        return events
