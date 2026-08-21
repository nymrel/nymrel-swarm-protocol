"""
nymrel_swarm_protocol - Two-Seat Command Studio Protocol
Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
"""

import os
import time
import json
import uuid
from typing import Optional, Dict, Any, List, Literal, Union
from dataclasses import dataclass, asdict
from .fencing import AtomicLockManager, FencingClock, FencingToken, iso_now
from .bus import FileMailboxManager, BusEvent

TwoSeatRole = Literal["mission_owner", "studio_controller"]
MissionState = Literal["INIT", "ACTIVE", "TRANSFER_REQUESTED", "TRANSFERRED", "RECOVERING", "TERMINATED"]
HealthState = Literal["HEALTHY", "SUSPECT", "STALE", "LEASE_EXPIRED", "RECOVERING", "RECONCILED"]


@dataclass
class HandoverPacket:
    from_agent: str
    to_agent: str
    checkpoint: str
    open_claims: List[str]
    child_tasks: List[str]
    validation_state: Dict[str, Any]
    next_move: str
    reason: Optional[str] = None


@dataclass
class HandoverResult:
    success: bool
    mission_id: str
    new_owner: str
    new_controller: str
    fencing_token: Dict[str, Any]
    state: str
    timestamp: str
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class ActionValidationResult:
    allowed: bool
    reason: str
    role: Optional[str] = None
    current_generation: Optional[int] = None
    token_valid: Optional[bool] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class MissionRecord:
    mission_id: str
    mission_owner_seat_id: str
    studio_controller_seat_id: str
    state: str
    health_state: str
    current_generation: int
    fencing_token: Dict[str, Any]
    active_claims: List[str]
    checkpoints: List[Dict[str, Any]]
    handover_history: List[Dict[str, Any]]
    created_at: str
    updated_at: str
    closed_at: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        if self.closed_at is None:
            del d["closed_at"]
        return d


class TwoSeatProtocol:
    def __init__(self, swarm_root: str):
        self.base_dir = os.path.join(swarm_root, "two-seat")
        self.lock_manager = AtomicLockManager(swarm_root)
        self.fencing_clock = FencingClock(swarm_root)
        self.mailbox_manager = FileMailboxManager(swarm_root)

        os.makedirs(self.base_dir, exist_ok=True)

    def _get_mission_path(self, mission_id: str) -> str:
        sanitized = "".join(c if c.isalnum() or c in "._-" else "_" for c in mission_id)
        return os.path.join(self.base_dir, f"{sanitized}.json")

    def init_mission(
        self,
        mission_id: str,
        mission_owner_seat_id: str,
        studio_controller_seat_id: str,
        initial_checkpoint: Optional[str] = None,
    ) -> MissionRecord:
        def _op():
            file_path = self._get_mission_path(mission_id)
            if os.path.exists(file_path):
                raise ValueError(f'Mission "{mission_id}" already exists')

            if mission_owner_seat_id == studio_controller_seat_id:
                raise ValueError("Two-Seat invariant violation: mission_owner and studio_controller cannot be the same seat")

            now = iso_now()
            fencing_token = self.fencing_clock.increment_generation(
                f"mission_{mission_id}",
                mission_owner_seat_id,
            )

            record = MissionRecord(
                mission_id=mission_id,
                mission_owner_seat_id=mission_owner_seat_id,
                studio_controller_seat_id=studio_controller_seat_id,
                state="ACTIVE",
                health_state="HEALTHY",
                current_generation=fencing_token.generation,
                fencing_token=fencing_token.to_dict(),
                active_claims=[],
                checkpoints=[
                    {
                        "timestamp": now,
                        "author": mission_owner_seat_id,
                        "summary": initial_checkpoint or "Mission initialized under Two-Seat Command Studio contract",
                    }
                ],
                handover_history=[],
                created_at=now,
                updated_at=now,
            )

            with open(file_path, "w", encoding="utf-8") as f:
                json.dump(record.to_dict(), f, indent=2)

            self.mailbox_manager.record_event(BusEvent(
                event_id=str(uuid.uuid4()),
                timestamp=now,
                event_type="mission_initialized",
                actor=mission_owner_seat_id,
                resource=mission_id,
                details={
                    "owner": mission_owner_seat_id,
                    "controller": studio_controller_seat_id,
                    "generation": fencing_token.generation,
                }
            ))

            return record

        return self.lock_manager.with_lock(f"mission_{mission_id}", _op)

    def get_mission(self, mission_id: str) -> Optional[MissionRecord]:
        file_path = self._get_mission_path(mission_id)
        if not os.path.exists(file_path):
            return None
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return MissionRecord(**data)
        except Exception:
            return None

    def request_handover(self, mission_id: str, packet: HandoverPacket) -> HandoverResult:
        def _op():
            mission = self.get_mission(mission_id)
            if not mission:
                raise ValueError(f'Mission "{mission_id}" not found')

            if mission.state == "TERMINATED":
                raise ValueError(f'Mission "{mission_id}" is already terminated')

            if mission.mission_owner_seat_id != packet.from_agent:
                raise PermissionError(
                    f'Unauthorized handover: "{packet.from_agent}" is not current mission_owner ("{mission.mission_owner_seat_id}")'
                )

            new_token = self.fencing_clock.increment_generation(f"mission_{mission_id}", packet.to_agent)
            now = iso_now()
            prev_owner = mission.mission_owner_seat_id

            mission.mission_owner_seat_id = packet.to_agent
            if mission.studio_controller_seat_id == packet.to_agent:
                mission.studio_controller_seat_id = prev_owner
            mission.state = "ACTIVE"
            mission.current_generation = new_token.generation
            mission.fencing_token = new_token.to_dict()
            mission.updated_at = now

            mission.checkpoints.append({
                "timestamp": now,
                "author": packet.from_agent,
                "summary": f"Handover checkpoint: {packet.checkpoint}. Next move: {packet.next_move}",
                "data": {
                    "open_claims": packet.open_claims,
                    "child_tasks": packet.child_tasks,
                    "validation_state": packet.validation_state,
                }
            })

            mission.handover_history.append({
                "timestamp": now,
                "from": packet.from_agent,
                "to": packet.to_agent,
                "reason": packet.reason or "Planned mission transfer",
                "generation": new_token.generation,
            })

            with open(self._get_mission_path(mission_id), "w", encoding="utf-8") as f:
                json.dump(mission.to_dict(), f, indent=2)

            self.mailbox_manager.record_event(BusEvent(
                event_id=str(uuid.uuid4()),
                timestamp=now,
                event_type="mission_handover",
                actor=packet.from_agent,
                resource=mission_id,
                details={
                    "from": packet.from_agent,
                    "to": packet.to_agent,
                    "generation": new_token.generation,
                }
            ))

            return HandoverResult(
                success=True,
                mission_id=mission_id,
                new_owner=packet.to_agent,
                new_controller=mission.studio_controller_seat_id,
                fencing_token=new_token.to_dict(),
                state="ACTIVE",
                timestamp=now,
            )

        return self.lock_manager.with_lock(f"mission_{mission_id}", _op)

    def execute_unplanned_recovery(self, mission_id: str, controller_id: str, reason: str) -> HandoverResult:
        def _op():
            mission = self.get_mission(mission_id)
            if not mission:
                raise ValueError(f'Mission "{mission_id}" not found')

            if mission.state == "TERMINATED":
                raise ValueError(f'Mission "{mission_id}" is terminated')

            if mission.studio_controller_seat_id != controller_id:
                raise PermissionError(
                    f'Unauthorized recovery: Seat "{controller_id}" is not registered studio_controller ("{mission.studio_controller_seat_id}")'
                )

            prev_owner = mission.mission_owner_seat_id
            new_token = self.fencing_clock.increment_generation(f"mission_{mission_id}", controller_id)
            now = iso_now()

            mission.mission_owner_seat_id = controller_id
            mission.studio_controller_seat_id = f"unassigned_controller_{str(uuid.uuid4())[:8]}"
            mission.state = "ACTIVE"
            mission.health_state = "RECONCILED"
            mission.current_generation = new_token.generation
            mission.fencing_token = new_token.to_dict()
            mission.updated_at = now

            mission.checkpoints.append({
                "timestamp": now,
                "author": controller_id,
                "summary": f"Unplanned recovery executed by controller: {reason}",
            })

            mission.handover_history.append({
                "timestamp": now,
                "from": prev_owner,
                "to": controller_id,
                "reason": f"Recovery: {reason}",
                "generation": new_token.generation,
            })

            with open(self._get_mission_path(mission_id), "w", encoding="utf-8") as f:
                json.dump(mission.to_dict(), f, indent=2)

            self.mailbox_manager.record_event(BusEvent(
                event_id=str(uuid.uuid4()),
                timestamp=now,
                event_type="mission_recovery",
                actor=controller_id,
                resource=mission_id,
                details={
                    "previous_owner": prev_owner,
                    "new_owner": controller_id,
                    "reason": reason,
                    "generation": new_token.generation,
                }
            ))

            return HandoverResult(
                success=True,
                mission_id=mission_id,
                new_owner=controller_id,
                new_controller=mission.studio_controller_seat_id,
                fencing_token=new_token.to_dict(),
                state="ACTIVE",
                timestamp=now,
            )

        return self.lock_manager.with_lock(f"mission_{mission_id}", _op)

    def validate_action(
        self,
        mission_id: str,
        agent_id: str,
        write_scope: Optional[str] = None,
        presented_token: Optional[Union[FencingToken, Dict[str, Any]]] = None,
    ) -> ActionValidationResult:
        mission = self.get_mission(mission_id)
        if not mission:
            return ActionValidationResult(allowed=False, reason=f'Mission "{mission_id}" does not exist')

        if mission.state == "TERMINATED":
            return ActionValidationResult(allowed=False, reason=f'Mission "{mission_id}" is terminated')

        is_owner = mission.mission_owner_seat_id == agent_id
        is_controller = mission.studio_controller_seat_id == agent_id

        if not is_owner and not is_controller:
            return ActionValidationResult(
                allowed=False,
                reason=f'Agent "{agent_id}" is neither mission_owner nor studio_controller for mission "{mission_id}"',
            )

        role = "mission_owner" if is_owner else "studio_controller"

        if presented_token:
            token_gen = presented_token.generation if isinstance(presented_token, FencingToken) else presented_token.get("generation")
            if token_gen != mission.current_generation:
                return ActionValidationResult(
                    allowed=False,
                    role=role,
                    current_generation=mission.current_generation,
                    token_valid=False,
                    reason=f"Stale fencing generation: Presented generation {token_gen} is less than active generation {mission.current_generation}. Writer has been fenced out.",
                )

        if is_controller and write_scope:
            return ActionValidationResult(
                allowed=False,
                role=role,
                current_generation=mission.current_generation,
                reason=f'Invariant violation: studio_controller "{agent_id}" cannot perform state-mutating writes in mission scope. Writes belong solely to active mission_owner "{mission.mission_owner_seat_id}".',
            )

        return ActionValidationResult(
            allowed=True,
            role=role,
            current_generation=mission.current_generation,
            token_valid=True,
            reason="Action permitted: Agent is active mission_owner" if is_owner else "Read/Observation permitted: Agent is active studio_controller",
        )

    def close_mission(self, mission_id: str, owner_id: str, closeout_data: Dict[str, Any]) -> MissionRecord:
        def _op():
            mission = self.get_mission(mission_id)
            if not mission:
                raise ValueError(f'Mission "{mission_id}" not found')

            if mission.mission_owner_seat_id != owner_id:
                raise PermissionError(f'Unauthorized closeout: Only current mission_owner ("{mission.mission_owner_seat_id}") can close mission')

            now = iso_now()
            mission.state = "TERMINATED"
            mission.closed_at = now
            mission.updated_at = now
            mission.checkpoints.append({
                "timestamp": now,
                "author": owner_id,
                "summary": "Terminal validated mission closeout",
                "data": closeout_data,
            })

            with open(self._get_mission_path(mission_id), "w", encoding="utf-8") as f:
                json.dump(mission.to_dict(), f, indent=2)

            self.mailbox_manager.record_event(BusEvent(
                event_id=str(uuid.uuid4()),
                timestamp=now,
                event_type="mission_closed",
                actor=owner_id,
                resource=mission_id,
                details={"closeout": closeout_data}
            ))

            return mission

        return self.lock_manager.with_lock(f"mission_{mission_id}", _op)
