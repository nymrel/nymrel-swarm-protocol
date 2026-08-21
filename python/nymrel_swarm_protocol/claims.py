"""
nymrel_swarm_protocol - Resource Claims & Auto-Expiring Leases
Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
"""

import os
import time
import json
import uuid
from typing import Optional, Dict, Any, List, Literal
from dataclasses import dataclass, asdict
from .fencing import AtomicLockManager, FencingClock, iso_now
from .bus import FileMailboxManager, BusEvent

ClaimMode = Literal["exclusive", "shared"]
ClaimStatus = Literal["active", "expired", "released", "revoked"]


@dataclass
class ClaimRecord:
    claim_id: str
    resource_path: str
    owner_agent: str
    mode: ClaimMode
    status: ClaimStatus
    fencing_generation: int
    lease_duration_ms: int
    acquired_at: str
    expires_at: str
    heartbeat_at: str
    metadata: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        if self.metadata is None:
            d["metadata"] = {}
        return d


class ClaimManager:
    def __init__(self, swarm_root: str, default_lease_ms: int = 30000):
        self.base_dir = os.path.join(swarm_root, "claims")
        self.lock_manager = AtomicLockManager(swarm_root)
        self.fencing_clock = FencingClock(swarm_root)
        self.mailbox_manager = FileMailboxManager(swarm_root)
        self.default_lease_ms = default_lease_ms

        os.makedirs(self.base_dir, exist_ok=True)

    def _get_claim_path(self, claim_id: str) -> str:
        return os.path.join(self.base_dir, f"{claim_id}.json")

    @staticmethod
    def normalize_resource_path(resource_path: str) -> str:
        normalized = resource_path.replace("\\", "/").strip()
        if normalized.endswith("/") and len(normalized) > 1:
            normalized = normalized[:-1]
        return normalized.lower()

    @staticmethod
    def is_sub_path(parent: str, child: str) -> bool:
        if parent == child:
            return True
        parent_slash = parent if parent.endswith("/") else f"{parent}/"
        return child.startswith(parent_slash)

    @staticmethod
    def check_conflict(
        path_a: str,
        mode_a: ClaimMode,
        path_b: str,
        mode_b: ClaimMode,
    ) -> bool:
        is_related = ClaimManager.is_sub_path(path_a, path_b) or ClaimManager.is_sub_path(path_b, path_a)
        if not is_related:
            return False

        if mode_a == "exclusive" or mode_b == "exclusive":
            return True

        return False

    def acquire_claim(
        self,
        resource_path: str,
        owner_agent: str,
        mode: ClaimMode = "exclusive",
        lease_duration_ms: Optional[int] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> ClaimRecord:
        def _op():
            norm_path = ClaimManager.normalize_resource_path(resource_path)
            duration = lease_duration_ms if lease_duration_ms is not None else self.default_lease_ms
            now_iso = iso_now()
            expires_iso = iso_now(duration)

            active_claims = self._list_active_internal()

            for existing in active_claims:
                if existing.owner_agent == owner_agent and existing.resource_path == norm_path:
                    # Refresh existing claim
                    existing.lease_duration_ms = duration
                    existing.expires_at = expires_iso
                    existing.heartbeat_at = now_iso
                    if metadata:
                        existing.metadata = {**(existing.metadata or {}), **metadata}
                    with open(self._get_claim_path(existing.claim_id), "w", encoding="utf-8") as f:
                        json.dump(existing.to_dict(), f, indent=2)
                    return existing

                conflict = ClaimManager.check_conflict(
                    existing.resource_path,
                    existing.mode,
                    norm_path,
                    mode,
                )

                if conflict:
                    raise ValueError(
                        f'Claim conflict on "{resource_path}": Already held by "{existing.owner_agent}" '
                        f'({existing.mode} mode, claim_id: {existing.claim_id}, expires: {existing.expires_at})'
                    )

            fencing_token = self.fencing_clock.increment_generation(norm_path, owner_agent)
            claim_id = str(uuid.uuid4())

            record = ClaimRecord(
                claim_id=claim_id,
                resource_path=norm_path,
                owner_agent=owner_agent,
                mode=mode,
                status="active",
                fencing_generation=fencing_token.generation,
                lease_duration_ms=duration,
                acquired_at=now_iso,
                expires_at=expires_iso,
                heartbeat_at=now_iso,
                metadata=metadata or {},
            )

            with open(self._get_claim_path(claim_id), "w", encoding="utf-8") as f:
                json.dump(record.to_dict(), f, indent=2)

            self.mailbox_manager.record_event(BusEvent(
                event_id=str(uuid.uuid4()),
                timestamp=now_iso,
                event_type="claim_acquired",
                actor=owner_agent,
                resource=norm_path,
                details={
                    "claim_id": claim_id,
                    "mode": mode,
                    "generation": fencing_token.generation,
                    "expires_at": expires_iso,
                }
            ))

            return record

        return self.lock_manager.with_lock("claims_mutex", _op)

    def heartbeat(self, claim_id: str, agent_id: str) -> ClaimRecord:
        def _op():
            claim = self.get_claim(claim_id)
            if not claim:
                raise ValueError(f"Claim not found: {claim_id}")

            if claim.owner_agent != agent_id:
                raise PermissionError(f'Unauthorized heartbeat: Claim {claim_id} is owned by "{claim.owner_agent}", not "{agent_id}"')

            if claim.status in ("released", "revoked"):
                raise ValueError(f'Cannot heartbeat claim in "{claim.status}" status')

            now_iso = iso_now()
            new_expires_iso = iso_now(claim.lease_duration_ms)

            claim.status = "active"
            claim.heartbeat_at = now_iso
            claim.expires_at = new_expires_iso

            with open(self._get_claim_path(claim_id), "w", encoding="utf-8") as f:
                json.dump(claim.to_dict(), f, indent=2)

            self.mailbox_manager.record_event(BusEvent(
                event_id=str(uuid.uuid4()),
                timestamp=now_iso,
                event_type="claim_heartbeat",
                actor=agent_id,
                resource=claim.resource_path,
                details={
                    "claim_id": claim_id,
                    "expires_at": new_expires_iso,
                }
            ))

            return claim

        return self.lock_manager.with_lock("claims_mutex", _op)

    def release_claim(self, claim_id: str, agent_id: str) -> bool:
        def _op():
            claim = self.get_claim(claim_id)
            if not claim:
                return False

            if claim.owner_agent != agent_id:
                raise PermissionError(f'Unauthorized release: Claim {claim_id} is owned by "{claim.owner_agent}", not "{agent_id}"')

            claim.status = "released"
            with open(self._get_claim_path(claim_id), "w", encoding="utf-8") as f:
                json.dump(claim.to_dict(), f, indent=2)

            now_iso = iso_now()
            self.mailbox_manager.record_event(BusEvent(
                event_id=str(uuid.uuid4()),
                timestamp=now_iso,
                event_type="claim_released",
                actor=agent_id,
                resource=claim.resource_path,
                details={"claim_id": claim_id}
            ))

            return True

        return self.lock_manager.with_lock("claims_mutex", _op)

    def get_claim(self, claim_id: str) -> Optional[ClaimRecord]:
        file_path = self._get_claim_path(claim_id)
        if not os.path.exists(file_path):
            return None
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return ClaimRecord(**data)
        except Exception:
            return None

    def list_claims(
        self,
        owner_agent: Optional[str] = None,
        resource_path: Optional[str] = None,
        mode: Optional[ClaimMode] = None,
        status: Optional[ClaimStatus] = None,
        include_expired: bool = False,
    ) -> List[ClaimRecord]:
        if not os.path.exists(self.base_dir):
            return []

        files = [f for f in os.listdir(self.base_dir) if f.endswith(".json")]
        records: List[ClaimRecord] = []
        now_iso = iso_now()

        for file in files:
            try:
                with open(os.path.join(self.base_dir, file), "r", encoding="utf-8") as f:
                    data = json.load(f)
                record = ClaimRecord(**data)

                if record.status == "active" and record.expires_at < now_iso:
                    record.status = "expired"

                if owner_agent and record.owner_agent != owner_agent:
                    continue
                if resource_path and record.resource_path != self.normalize_resource_path(resource_path):
                    continue
                if mode and record.mode != mode:
                    continue
                if status and record.status != status:
                    continue
                if not include_expired and status != "expired" and record.status == "expired":
                    continue

                records.append(record)
            except Exception:
                pass

        return records

    def _list_active_internal(self) -> List[ClaimRecord]:
        now_iso = iso_now()
        all_claims = self.list_claims(include_expired=True)
        return [c for c in all_claims if c.status == "active" and c.expires_at >= now_iso]

    def reap_expired_leases(self) -> List[ClaimRecord]:
        def _op():
            files = [f for f in os.listdir(self.base_dir) if f.endswith(".json")]
            now_iso = iso_now()
            expired: List[ClaimRecord] = []

            for file in files:
                file_path = os.path.join(self.base_dir, file)
                try:
                    with open(file_path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    record = ClaimRecord(**data)

                    if record.status == "active" and record.expires_at < now_iso:
                        record.status = "expired"
                        with open(file_path, "w", encoding="utf-8") as f:
                            json.dump(record.to_dict(), f, indent=2)
                        expired.append(record)

                        self.mailbox_manager.record_event(BusEvent(
                            event_id=str(uuid.uuid4()),
                            timestamp=now_iso,
                            event_type="claim_expired",
                            actor="auto_arbiter",
                            resource=record.resource_path,
                            details={
                                "claim_id": record.claim_id,
                                "expired_owner": record.owner_agent,
                                "expired_at": record.expires_at,
                            }
                        ))
                except Exception:
                    pass

            return expired

        return self.lock_manager.with_lock("claims_mutex", _op)
